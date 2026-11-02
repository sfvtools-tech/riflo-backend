import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { readRetentionContext } from '../../src/access/retention-firestore.js';
import { resolveRetention, type RetentionPolicy } from '../../src/access/retention.js';

const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const iso = (days: number) => new Date(start + days * day).toISOString();

async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const value = setup();
  try { await run(value); }
  finally {
    await value.db.recursiveDelete(value.account);
    await value.ref.delete();
    await value.db.terminate();
    await deleteApp(value.app);
  }
}
function setup() {
  const uid = `bridge-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const ref = db.collection('subscriptionGrants').doc(uid);
  let clock = start;
  const lifecycle = createLifecycleStore(db, { now: () => clock, retentionEnabled: true });
  async function activate(at: number, ends: number, billingStart = at) {
    clock = start + at * day;
    const saved = (await ref.get()).data();
    return lifecycle.transition(uid, randomUUID(), { type: 'activate_paid', expectedRevision: saved?.revision ?? 0,
      plan: 'lower', periodId: randomUUID(), startsAt: iso(billingStart), expiresAt: iso(ends) });
  }
  return { uid, app, db, account, ref, activate };
}

test('outlier promise bridges successive paid gaps without rewriting the resource or read authority', local, async () => {
  await fixture(async ({ uid, db, account, ref, activate }) => {
    const first = await activate(0, 30);
    const policy: RetentionPolicy = { version: 1, kind: 'paid', tenureId: first.retention!.paidTenureId!, promisedUntil: start + 200 * day };
    const resource = { kind: 'output' as const, expiresAt: policy.promisedUntil, retention: policy };
    const second = await activate(150, 180);
    assert.notEqual(second.retention!.paidTenureId, policy.tenureId);
    const third = await activate(230, 260);
    assert.equal(third.retention!.paidTenureId, second.retention!.paidTenureId);
    const authorityBefore = (await ref.get()).data();
    const factsBefore = (await account.collection('retentionTenures').get()).docs.map(doc => doc.data());
    const original = structuredClone(resource);
    const context = await readRetentionContext(db, uid, third, [policy, policy]);
    const resolved = resolveRetention(resource, start + 300 * day, context);
    assert.equal(resolved.available, true);
    assert.equal(resolved.expiresAt, start + 320 * day);
    assert.equal(context.survivingTenures!.size, 1);
    assert.deepEqual(resource, original);
    assert.deepEqual((await ref.get()).data(), authorityBefore);
    assert.deepEqual((await account.collection('retentionTenures').get()).docs.map(doc => doc.data()), factsBefore);
    assert.equal(resolveRetention({ ...resource, retention: { ...policy, deletedAt: start + day } }, start + 300 * day, context).available, false);
  });
});

test('backdated billing start cannot revive a floor that expired before activation committed', local, async () => {
  await fixture(async ({ uid, db, activate }) => {
    const first = await activate(0, 30);
    const policy: RetentionPolicy = { version: 1, kind: 'paid', tenureId: first.retention!.paidTenureId!, promisedUntil: start + 150 * day };
    const later = await activate(160, 190, 140);
    const context = await readRetentionContext(db, uid, later, [policy]);
    assert.equal(resolveRetention({ kind: 'output', expiresAt: policy.promisedUntil, retention: policy }, start + 160 * day, context).available, false);
    assert.equal(resolveRetention({ kind: 'output', expiresAt: policy.promisedUntil, retention: policy }, start + 160 * day, context).expiresAt, policy.promisedUntil);
  });
});

test('a bridge that also expires cannot be revived by another paid tenure after its extended deadline', local, async () => {
  await fixture(async ({ uid, db, activate }) => {
    const first = await activate(0, 30);
    const policy: RetentionPolicy = { version: 1, kind: 'paid', tenureId: first.retention!.paidTenureId!, promisedUntil: start + 200 * day };
    const second = await activate(150, 180);
    const later = await activate(240, 270, 230);
    assert.notEqual(later.retention!.paidTenureId, second.retention!.paidTenureId);
    const context = await readRetentionContext(db, uid, later, [policy]);
    const result = resolveRetention({ kind: 'output', expiresAt: policy.promisedUntil, retention: policy }, start + 240 * day, context);
    assert.equal(result.available, false);
    assert.equal(result.expiresAt, start + 240 * day);
  });
});

test('malformed or cross-owner selected bridge facts cannot authorize access', local, async () => {
  await fixture(async ({ uid, db, account, activate }) => {
    const first = await activate(0, 30);
    const policy: RetentionPolicy = { version: 1, kind: 'paid', tenureId: first.retention!.paidTenureId!, promisedUntil: start + 200 * day };
    const later = await activate(150, 180);
    const bridgeRef = account.collection('retentionTenures').doc(later.retention!.paidTenureId!);
    const saved = (await bridgeRef.get()).data()!;
    for (const invalid of [{ ...saved, uid: 'another-owner' }, { ...saved, paidAccessEndsAt: 'invalid' }]) {
      await bridgeRef.set(invalid);
      const context = await readRetentionContext(db, uid, later, [policy]);
      const result = resolveRetention({ kind: 'output', expiresAt: policy.promisedUntil, retention: policy }, start + 210 * day, context);
      assert.equal(result.valid, false);
      assert.equal(result.available, false);
    }
  });
});
