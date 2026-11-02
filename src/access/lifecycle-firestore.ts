import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createId } from '../shared/id.js';
import { isLifecycle, LifecycleError, startTrial, transitionLifecycle, type LifecycleCommand } from './lifecycle.js';
import { isPaidTenure, type PaidTenure } from './retention.js';
import { trialOwnerKey } from './trial-abuse.js';
import { ProjectError } from '../projects/service.js';

function fingerprint(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sorted(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
export function createLifecycleStore(db: Firestore, { now = Date.now, retentionEnabled = false }: { now?: () => number; retentionEnabled?: boolean } = {}) {
  const ref = (uid: string) => db.collection('subscriptionGrants').doc(uid);
  return {
    async get(uid: string) { return (await ref(uid).get()).data() ?? null; },
    async startTrial(uid: string, now: number, subjectKey?: string) {
      const periodId = createId();
      return db.runTransaction(async transaction => {
        const saved = (await transaction.get(ref(uid))).data();
        let next = startTrial(saved, periodId, now);
        if (next !== saved && subjectKey) {
          if (!/^[a-f0-9]{64}$/.test(subjectKey)) throw new Error('Invalid trial subject key.');
          const claim = db.collection('trialAbuseClaims').doc(subjectKey);
          const binding = db.collection('trialAbuseBindings').doc(trialOwnerKey(uid));
          const [claimed, bound] = await transaction.getAll(claim, binding);
          if (claimed.exists || bound.exists) throw new ProjectError(403, 'trial_already_used', 'This sign-in has already used its trial. Paid access remains available.');
          transaction.create(claim, { version: 1, startedAt: now });
          transaction.create(binding, { version: 1, subjectKey });
        }
        if (retentionEnabled && next !== saved && !next.retention) next = { ...next, retention: { version: 1, paidTenureId: null } };
        if (next !== saved) transaction.set(ref(uid), next);
        return next;
      });
    },
    async transition(uid: string, eventId: string, command: LifecycleCommand) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(eventId)) throw new LifecycleError(400, 'invalid_lifecycle', 'Provide a stable transition identity.');
      const receipt = db.collection('accounts').doc(uid).collection('lifecycleTransitions').doc(eventId);
      const payload = fingerprint(command);
      return db.runTransaction(async transaction => {
        const prior = (await transaction.get(receipt)).data();
        if (prior) {
          if (prior.fingerprint !== payload) throw new LifecycleError(409, 'lifecycle_conflict', 'This transition identity has a different payload.');
          return prior.result;
        }
        const saved = (await transaction.get(ref(uid))).data();
        const at = now();
        let next = transitionLifecycle(saved, command, at);
        const manageRetention = retentionEnabled || isLifecycle(saved) && saved.retention !== undefined;
        let tenureWrite: PaidTenure | undefined;
        if (manageRetention && next.paid && (command.type === 'activate_paid' || command.type === 'renew')) {
          const existingId = isLifecycle(saved) ? saved.retention?.paidTenureId : undefined;
          const existingRef = existingId ? db.collection('accounts').doc(uid).collection('retentionTenures').doc(existingId) : undefined;
          const existing = existingRef ? (await transaction.get(existingRef)).data() : undefined;
          if (existingId && (!isPaidTenure(existing) || existing.uid !== uid || existing.id !== existingId)) throw new LifecycleError(409, 'lifecycle_conflict', 'Paid retention history is unavailable.');
          const survives = isPaidTenure(existing) && existing.paidAccessEndsAt + 60 * 86_400_000 > at;
          const id = survives ? existing.id : createId();
          tenureWrite = { id, uid, startsAt: survives ? existing.startsAt : Date.parse(next.paid.grant.startsAt), ...(survives ? existing.activatedAt === undefined ? {} : { activatedAt: existing.activatedAt } : { activatedAt: at }), paidAccessEndsAt: Date.parse(next.paid.grant.expiresAt), revision: survives ? existing.revision + 1 : 0 };
          if (!isPaidTenure(tenureWrite)) throw new LifecycleError(409, 'lifecycle_conflict', 'This transition would create invalid retention history.');
          const promotion = isLifecycle(saved) ? saved.retention?.trialPromotion : undefined;
          // Survival is assessed when activation commits, never retroactively from billing dates.
          next = { ...next, retention: { version: 1, paidTenureId: id, ...(promotion ? { trialPromotion: promotion } : next.trial ? { trialPromotion: { at, tenureId: id } } : {}) } };
        }
        if (!isLifecycle(next)) throw new LifecycleError(409, 'lifecycle_conflict', 'This transition would create invalid retention history.');
        if ('periodId' in command) {
          const owner = db.collection('accounts').doc(uid).collection('allowances').doc(`shared-${command.periodId}`);
          const identity = db.collection('accounts').doc(uid).collection('allowancePeriods').doc(command.periodId);
          if ((await transaction.get(owner)).exists || (await transaction.get(identity)).exists) throw new LifecycleError(409, 'lifecycle_conflict', 'This allowance period has already been used.');
          transaction.create(identity, { eventId, startsAt: command.startsAt, expiresAt: command.expiresAt });
        }
        if (tenureWrite) transaction.set(db.collection('accounts').doc(uid).collection('retentionTenures').doc(tenureWrite.id), tenureWrite);
        transaction.set(ref(uid), next);
        transaction.create(receipt, { fingerprint: payload, result: next });
        return next;
      });
    },
  };
}
