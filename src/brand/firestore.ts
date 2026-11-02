import type { Firestore } from 'firebase-admin/firestore';
import type { BrandProfile, BrandStore } from './service.js';

export function createBrandStore(db: Firestore): BrandStore {
  const profile = (uid: string) => db.collection('accounts').doc(uid).collection('settings').doc('brand');
  return {
    async read(uid) {
      return (await profile(uid).get()).data() as BrandProfile | undefined ?? null;
    },
    async save(uid, value) {
      // Replace the whole profile so removed preferences do not survive an update.
      await profile(uid).set(value);
    },
  };
}
