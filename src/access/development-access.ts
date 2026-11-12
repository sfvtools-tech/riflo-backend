import type { Firestore } from 'firebase-admin/firestore';
import { createId } from '../shared/id.js';
import { isGrant } from './policy.js';
import { isPaidTenure, type PaidTenure } from './retention.js';

// Trusted setup for development accounts; it does not convert existing access.
export async function createDevelopmentAccess<T>(db: Firestore, uid: string, grant: T, now = Date.now()) {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/') || !isGrant(grant) || grant.retention || Date.parse(grant.startsAt) > now || Date.parse(grant.expiresAt) <= now) {
    throw new Error('Provide a current development grant without existing retention.');
  }
  const id = createId();
  const tenure: PaidTenure = { id, uid, startsAt: now, paidAccessEndsAt: Date.parse(grant.expiresAt), revision: 0 };
  if (!isPaidTenure(tenure)) throw new Error('Invalid development access duration.');
  const access = { ...grant, retention: { version: 1 as const, paidTenureId: id } };
  await db.runTransaction(async transaction => {
    const ref = db.collection('subscriptionGrants').doc(uid);
    if ((await transaction.get(ref)).exists) throw new Error('Development access already exists.');
    transaction.create(ref, access);
    transaction.create(db.collection('accounts').doc(uid).collection('retentionTenures').doc(id), tenure);
  });
  return access;
}
