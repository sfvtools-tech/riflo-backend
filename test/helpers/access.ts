import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';

export async function activatePaidPlan(db: Firestore, uid: string, now: number, expiresAt: number) {
  return createLifecycleStore(db, { now: () => now }).transition(uid, randomUUID(), {
    type: 'activate_paid', expectedRevision: 0, plan: 'lower', periodId: randomUUID(),
    startsAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  });
}

// Raw grants remain fixtures for compatibility and custom accounting boundary tests only.
export async function seedManualGrant<T extends { expiresAt: string }>(db: Firestore, uid: string, grant: T, now: number) {
  const id = randomUUID();
  const access = { ...grant, retention: { version: 1 as const, paidTenureId: id } };
  await db.runTransaction(async transaction => {
    transaction.create(db.collection('subscriptionGrants').doc(uid), access);
    transaction.create(db.collection('accounts').doc(uid).collection('retentionTenures').doc(id), {
      id, uid, startsAt: now, paidAccessEndsAt: Date.parse(grant.expiresAt), revision: 0,
    });
  });
  return access;
}
