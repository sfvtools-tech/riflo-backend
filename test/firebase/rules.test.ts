import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertFails, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

test('Firebase clients cannot read or write private data, including their own account', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST,
}, async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'demo-riflo',
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
    storage: { rules: await readFile('storage.rules', 'utf8') },
  });
  const privateDocuments = [
    'accounts/alice',
    'subscriptionGrants/alice',
    'accounts/alice/allowances/shared-trial_period_001',
    'accounts/alice/allowancePeriods/paid_period_001',
    'accounts/alice/lifecycleTransitions/activate_paid_001',
  ];
  try {
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const path of privateDocuments) await setDoc(doc(context.firestore(), path), { private: true });
      await uploadBytes(ref(context.storage(), 'accounts/alice/source.mp4'), new Uint8Array([1]));
    });
    for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('alice'), environment.authenticatedContext('bob')]) {
      for (const path of privateDocuments) {
        const document = doc(context.firestore(), path);
        await assertFails(getDoc(document));
        await assertFails(setDoc(document, { private: false }));
        await assertFails(deleteDoc(document));
      }
      await assertFails(getBytes(ref(context.storage(), 'accounts/alice/source.mp4')));
      await assertFails(uploadBytes(ref(context.storage(), 'accounts/alice/source.mp4'), new Uint8Array([2])));
    }
  } finally {
    await environment.cleanup();
  }
});
