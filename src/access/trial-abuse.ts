import { createHash, createHmac } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { resolveAccess } from './lifecycle.js';
import { ProjectError } from '../projects/service.js';

// Claims are supplied only by the verified Firebase Admin token boundary.
export type RequestIdentity = { uid: string; exp?: number; email_verified?: boolean; firebase?: { sign_in_provider?: string; identities?: Record<string, unknown> } };
export const trialWorkLimits = { minute: 10, hour: 60, commands: 120 } as const;
export const trialOwnerKey = (uid: string) => createHash('sha256').update(`riflo:trial-owner:v1:${uid}`).digest('hex');
export function trialSubjectKey(identity: RequestIdentity, key?: Buffer): string {
  if (!key || key.length < 32) throw new ProjectError(503, 'trial_not_configured', 'Trial verification is awaiting setup.');
  const subjects = identity.firebase?.identities?.['google.com'];
  if (identity.email_verified !== true || identity.firebase?.sign_in_provider !== 'google.com' || !Array.isArray(subjects) || subjects.length !== 1 || typeof subjects[0] !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(subjects[0])) {
    throw new ProjectError(403, 'trial_identity_required', 'Sign in with a verified Google account to start a trial.');
  }
  return createHmac('sha256', key).update(`riflo:trial-google-subject:v1:${subjects[0]}`).digest('hex');
}

export function createTrialAbuseStore(db: Firestore, key?: Buffer) {
  return {
    async prepare(identity: RequestIdentity, now: number, command = false) {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid trial work clock.');
      await db.runTransaction(async transaction => {
        const raw = (await transaction.get(db.collection('subscriptionGrants').doc(identity.uid))).data();
        const access = resolveAccess(raw, now);
        const trial = access.lifecycle?.trial.state;
        // Classification is transactional: paid activation/another first import may race.
        if (!access.lifecycle || access.lifecycle.paid.state === 'active' || trial !== 'eligible' && trial !== 'active') return;
        const owner = trialOwnerKey(identity.uid);
        const subject = trial === 'eligible' ? trialSubjectKey(identity, key) : undefined;
        const bound = await transaction.get(db.collection('trialAbuseBindings').doc(owner));
        const binding = bound.data();
        if (subject && bound.exists) throw new ProjectError(403, 'trial_already_used', 'This sign-in has already used its trial. Paid access remains available.');
        if (bound.exists && (binding?.version !== 1 || typeof binding.subjectKey !== 'string' || !/^[a-f0-9]{64}$/.test(binding.subjectKey))) throw new Error('Invalid trial identity binding.');
        const rateKey = subject ?? (typeof binding?.subjectKey === 'string' && /^[a-f0-9]{64}$/.test(binding.subjectKey) ? binding.subjectKey : `uid-${owner}`);
        if (subject && (await transaction.get(db.collection('trialAbuseClaims').doc(subject))).exists) throw new ProjectError(403, 'trial_already_used', 'This Google sign-in has already used its trial. Paid access remains available.');
        const ref = db.collection('trialAbuseRates').doc(rateKey);
        const saved = (await transaction.get(ref)).data();
        if (saved && (saved.version !== 1 || ['minute', 'hour'].some(name => !saved[name] || !Number.isSafeInteger(saved[name].startsAt) || saved[name].startsAt < 0 || !Number.isSafeInteger(saved[name].count) || saved[name].count < 0))) throw new Error('Invalid trial rate state.');
        const window = (name: string, duration: number) => {
          const value = saved?.[name];
          return value && Number.isSafeInteger(value.startsAt) && value.startsAt + duration > now && Number.isSafeInteger(value.count) && value.count >= 0
            ? { startsAt: value.startsAt as number, count: value.count as number } : { startsAt: now, count: 0 };
        };
        const workCount = saved?.workCount === undefined ? 0 : saved.workCount;
        if (!Number.isSafeInteger(workCount) || workCount < 0) throw new Error('Invalid trial command state.');
        if (command && workCount >= trialWorkLimits.commands) throw new ProjectError(403, 'trial_work_limited', 'The trial processing request limit has been reached. Paid access remains available.');
        const minute = window('minute', 60_000);
        const hour = window('hour', 3_600_000);
        const blockedUntil = Math.max(minute.count >= trialWorkLimits.minute ? minute.startsAt + 60_000 : 0, hour.count >= trialWorkLimits.hour ? hour.startsAt + 3_600_000 : 0);
        if (blockedUntil > now) throw new ProjectError(429, 'trial_rate_limited', 'Trial requests are arriving too quickly. Wait before trying again.', Math.ceil((blockedUntil - now) / 1000));
        // Keep the cumulative ceiling beyond the trial deadline, including the first pre-activation import.
        const expiresAt = Math.max(now + 86_400_000, saved?.expiresAt instanceof Timestamp ? saved.expiresAt.toMillis() : 0, command ? (access.lifecycle?.trial.expiresAt ? Date.parse(access.lifecycle.trial.expiresAt) : now + 7 * 86_400_000) + 86_400_000 : 0);
        transaction.set(ref, { version: 1, workCount: workCount + (command ? 1 : 0), minute: { ...minute, count: minute.count + 1 }, hour: { ...hour, count: hour.count + 1 }, expiresAt: Timestamp.fromMillis(expiresAt) });
      });
    },
  };
}
