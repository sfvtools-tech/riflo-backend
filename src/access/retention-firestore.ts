import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { isLifecycle, resolveAccess } from './lifecycle.js';
import { isPaidTenure, isRetentionOrigin, isRetentionPolicy, resolveRetention, type PaidTenure, type RetentionContext, type RetentionOrigin, type RetentionPolicy, type RetentionKind } from './retention.js';

export async function readRetentionContext(db: Firestore, uid: string, access: unknown, origins: readonly (RetentionOrigin | undefined)[], transaction?: Transaction): Promise<RetentionContext> {
  const state = isLifecycle(access) ? access.retention : undefined;
  const ids = new Set(origins.filter((origin): origin is Extract<RetentionOrigin, { kind: 'paid' }> => isRetentionOrigin(origin) && origin.kind === 'paid').map(origin => origin.tenureId));
  if (state?.paidTenureId) ids.add(state.paidTenureId);
  if (state?.trialPromotion) ids.add(state.trialPromotion.tenureId);
  const entries = await Promise.all([...ids].map(async id => {
    const ref = db.collection('accounts').doc(uid).collection('retentionTenures').doc(id);
    const saved = (await (transaction ? transaction.get(ref) : ref.get())).data();
    return isPaidTenure(saved) && saved.uid === uid && saved.id === id ? [id, saved] as const : null;
  }));
  const context: RetentionContext = { uid, tenures: new Map(entries.filter(entry => entry !== null)), ...(state?.trialPromotion ? { promotion: state.trialPromotion } : {}) };
  const floors = new Set(origins.filter(isRetentionPolicy).filter(policy => {
    const origin = policy.kind === 'paid' ? context.tenures.get(policy.tenureId) : state?.trialPromotion ? context.tenures.get(state.trialPromotion.tenureId) : undefined;
    return origin && policy.promisedUntil > origin.paidAccessEndsAt + 60 * 86_400_000;
  }).map(policy => policy.promisedUntil));
  if (floors.size) {
    const surviving = new Map<number, PaidTenure | null>();
    await Promise.all([...floors].map(async floor => {
      const query = db.collection('accounts').doc(uid).collection('retentionTenures').where('activatedAt', '<', floor).orderBy('activatedAt', 'desc').limit(1);
      const snapshot = await (transaction ? transaction.get(query) : query.get());
      if (snapshot.empty) return;
      const saved = snapshot.docs[0].data();
      surviving.set(floor, isPaidTenure(saved) && saved.id === snapshot.docs[0].id && saved.uid === uid ? saved : null);
    }));
    context.survivingTenures = surviving;
  }
  return context;
}

export function admittedRetention(access: unknown, now: number, context: RetentionContext): RetentionOrigin | undefined {
  if (!isLifecycle(access) || !access.retention) return undefined;
  const grant = resolveAccess(access, now).grant;
  if (!grant) return undefined;
  if (grant === access.paid?.grant) {
    const tenureId = access.retention.paidTenureId;
    const tenure = tenureId ? context.tenures.get(tenureId) : undefined;
    if (!tenure || tenure.startsAt > now || tenure.paidAccessEndsAt <= now) throw new Error('Paid retention facts are unavailable.');
    return { kind: 'paid', tenureId: tenure.id };
  }
  return { kind: 'trial', startsAt: Date.parse(grant.startsAt) };
}

export function retentionPolicy(kind: RetentionKind, origin: RetentionOrigin | undefined, context: RetentionContext, importedAt?: number): RetentionPolicy | undefined {
  if (!origin) return undefined;
  const pending: RetentionPolicy = { ...origin, version: 1, promisedUntil: 0 };
  const resolved = resolveRetention({ kind, retention: pending, expiresAt: 0, importedAt }, 0, context);
  if (!resolved.valid || resolved.expiresAt === null) throw new Error('Retention facts are unavailable.');
  return { ...pending, promisedUntil: resolved.expiresAt };
}
