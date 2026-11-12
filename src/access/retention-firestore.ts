import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { isLifecycle, resolveAccess } from './lifecycle.js';
import { isGrant } from './policy.js';
import { ProjectError } from '../projects/service.js';
import { isPaidTenure, isRetentionOrigin, resolveRetention, type RetentionContext, type RetentionOrigin, type RetentionPolicy, type RetentionKind } from './retention.js';

export async function readRetentionContext(db: Firestore, uid: string, access: unknown, origins: readonly (RetentionOrigin | undefined)[], transaction?: Transaction): Promise<RetentionContext> {
  const state = isLifecycle(access) || isGrant(access) ? access.retention : undefined;
  const ids = new Set(origins.filter((origin): origin is Extract<RetentionOrigin, { kind: 'paid' }> => isRetentionOrigin(origin) && origin.kind === 'paid').map(origin => origin.tenureId));
  if (state?.paidTenureId) ids.add(state.paidTenureId);
  if (state?.trialPromotion) ids.add(state.trialPromotion.tenureId);
  const entries = await Promise.all([...ids].map(async id => {
    const ref = db.collection('accounts').doc(uid).collection('retentionTenures').doc(id);
    const saved = (await (transaction ? transaction.get(ref) : ref.get())).data();
    return isPaidTenure(saved) && saved.uid === uid && saved.id === id ? [id, saved] as const : null;
  }));
  const promotionRequired = isLifecycle(access) && access.trial !== null && access.paid !== null;
  const promotion = state?.trialPromotion ?? (state && !promotionRequired ? null : undefined);
  return { uid, tenures: new Map(entries.filter(entry => entry !== null)), promotion };
}

export function admittedRetention(access: unknown, now: number, context: RetentionContext): RetentionOrigin {
  const state = isLifecycle(access) || isGrant(access) ? access.retention : undefined;
  const grant = resolveAccess(access, now).grant;
  if (!state || !grant) throw new ProjectError(409, 'retention_unavailable', 'Account storage settings are unavailable. Contact support.');
  if (isLifecycle(access) && grant === access.trial) return { kind: 'trial', startsAt: Date.parse(grant.startsAt) };
  const tenure = state.paidTenureId ? context.tenures.get(state.paidTenureId) : undefined;
  if (!tenure || tenure.uid !== context.uid || tenure.startsAt > now || tenure.paidAccessEndsAt <= now) {
    throw new ProjectError(409, 'retention_unavailable', 'Account storage settings are unavailable. Contact support.');
  }
  return { kind: 'paid', tenureId: tenure.id };
}

export function retentionPolicy(kind: RetentionKind, origin: RetentionOrigin | undefined, context: RetentionContext, importedAt?: number): RetentionPolicy {
  if (!isRetentionOrigin(origin)) throw new ProjectError(409, 'retention_unavailable', 'Account storage settings are unavailable. Contact support.');
  const pending: RetentionPolicy = { ...origin, version: 1, promisedUntil: 0 };
  const resolved = resolveRetention({ kind, retention: pending, importedAt }, 0, context);
  if (!resolved.valid || resolved.expiresAt === null) throw new ProjectError(409, 'retention_unavailable', 'Account storage settings are unavailable. Contact support.');
  return { ...pending, promisedUntil: resolved.expiresAt };
}
