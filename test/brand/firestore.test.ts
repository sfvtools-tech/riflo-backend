import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createBrandStore } from '../../src/brand/firestore.js';
import { createBrandService } from '../../src/brand/service.js';

test('brand persistence replaces only its account settings without changing grants or usage', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = initializeApp({ projectId: 'demo-riflo' }, `brand-${randomUUID()}`);
  const db = getFirestore(app);
  const accounts = [`brand-${randomUUID()}`, `brand-${randomUUID()}`];
  const alice = db.collection('accounts').doc(accounts[0]!);
  const bob = db.collection('accounts').doc(accounts[1]!);
  const grant = db.collection('subscriptionGrants').doc(accounts[0]!);
  try {
    const service = createBrandService(createBrandStore(db));
    await alice.set({ preserved: true });
    await grant.set({ status: 'unchanged' });
    await alice.collection('allowances').doc('current').set({ consumed: 7 });
    assert.equal(await service.get(accounts[0]!), null);
    await service.replace(accounts[0]!, { name: 'Alice', voice: 'Warm' });
    assert.deepEqual((await alice.collection('settings').doc('brand').get()).data(), { name: 'Alice', voice: 'Warm' });
    assert.equal(await service.get(accounts[1]!), null);
    await service.replace(accounts[1]!, { name: 'Bob' });
    await service.replace(accounts[0]!, { audience: 'Teachers' });
    const restarted = createBrandService(createBrandStore(db));
    assert.deepEqual(await restarted.get(accounts[0]!), { audience: 'Teachers' });
    assert.deepEqual(await restarted.get(accounts[1]!), { name: 'Bob' });
    await service.replace(accounts[0]!, {});
    assert.deepEqual(await restarted.get(accounts[0]!), {});
    assert.deepEqual((await alice.get()).data(), { preserved: true });
    assert.deepEqual((await grant.get()).data(), { status: 'unchanged' });
    assert.deepEqual((await alice.collection('allowances').doc('current').get()).data(), { consumed: 7 });
    assert.equal((await alice.collection('usageEvents').get()).empty, true);
  } finally {
    await Promise.all([db.recursiveDelete(alice), db.recursiveDelete(bob), grant.delete()]);
    await db.terminate();
    await deleteApp(app);
  }
});
