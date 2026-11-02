import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirebaseDriveStore } from '../../src/sources/drive/firestore.js';

test('a Drive connection request finishes once and cannot reconnect after disconnect', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = initializeApp({ projectId: 'demo-riflo' }, `drive-test-${randomUUID()}`);
  const db = getFirestore(app);
  const store = createFirebaseDriveStore(db);
  const uid = `drive-test-${randomUUID()}`;
  const states = Array.from({ length: 4 }, () => randomUUID());
  const now = Date.now();
  const session = { uid, bindingHash: 'browser-hash', verifier: 'encrypted-verifier', expiresAt: now + 600_000 };
  try {
    await store.begin(states[0]!, session);
    assert.equal(await store.consume(states[0]!, 'wrong-browser', now), null);
    const consumed = await Promise.all(Array.from({ length: 4 }, () => store.consume(states[0]!, 'browser-hash', now)));
    assert.equal(consumed.filter(Boolean).length, 1);
    const version = consumed.find(Boolean)!.version;
    assert.equal(await store.save(uid, version, 'encrypted-token'), true);
    await store.begin(states[1]!, session);
    const pending = await store.consume(states[1]!, 'browser-hash', now);
    assert.ok(pending);
    assert.equal((await store.read(uid))!.token, 'encrypted-token');
    await store.remove(uid);
    assert.equal(await store.save(uid, pending.version, 'late-token'), false);
    assert.equal((await store.read(uid))!.token, undefined);
    await store.begin(states[2]!, session);
    await store.begin(states[3]!, session);
    assert.equal(await store.consume(states[2]!, 'browser-hash', now), null);
    assert.equal(await store.consume(states[3]!, 'browser-hash', session.expiresAt), null);
    assert.ok(await store.consume(states[3]!, 'browser-hash', now));
  } finally {
    await Promise.all([db.collection('driveConnections').doc(uid).delete(), ...states.map((state) => db.collection('driveOAuthSessions').doc(state).delete())]);
    await db.terminate();
    await deleteApp(app);
  }
});
