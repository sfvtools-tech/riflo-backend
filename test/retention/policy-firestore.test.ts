import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { readRetentionContext, retentionPolicy } from '../../src/access/retention-firestore.js';
import { resolveRetention } from '../../src/access/retention.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
async function withAccount(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const fixture = setup();
  try { await run(fixture); }
  finally {
    await fixture.db.recursiveDelete(fixture.db.collection('accounts').doc(fixture.uid));
    await fixture.ref.delete();
    await fixture.db.terminate();
    await deleteApp(fixture.app);
  }
}
function setup() {
  const uid = `retention-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const ref = db.collection('subscriptionGrants').doc(uid);
  let clock = start;
  return { uid, app, db, ref, lifecycle: createLifecycleStore(db, { retentionEnabled: true, now: () => clock }), setNow: (value: number) => { clock = value; } };
}

test('retention activation and renewal share one paid tenure without rewriting content', local, async () => {
  await withAccount(async ({ uid, db, ref, lifecycle, setNow }) => {
    const trial = await lifecycle.startTrial(uid, start);
    assert.deepEqual(trial.retention, { version: 1, paidTenureId: null });
    setNow(start + 5 * day);
    const command = { type: 'activate_paid' as const, expectedRevision: 1, plan: 'lower' as const, periodId: randomUUID(), startsAt: iso(start + 5 * day), expiresAt: iso(start + 35 * day) };
    const paid = await lifecycle.transition(uid, 'activation-retention', command);
    assert.equal(paid.retention?.trialPromotion?.at, start + 5 * day);
    const context = await readRetentionContext(db, uid, paid, []);
    const origin = { kind: 'trial' as const, startsAt: start };
    const policy = retentionPolicy('output', origin, context)!;
    const output = { kind: 'output' as const, expiresAt: policy.promisedUntil, retention: policy };
    const original = structuredClone(output);
    assert.equal(resolveRetention(output, start + 40 * day, context).expiresAt, start + 95 * day);
    setNow(start + 35 * day);
    const renewed = await lifecycle.transition(uid, 'renewal-retention', { ...command, type: 'renew', expectedRevision: paid.revision, periodId: randomUUID(), startsAt: iso(start + 35 * day), expiresAt: iso(start + 65 * day) });
    assert.equal(renewed.retention?.paidTenureId, paid.retention?.paidTenureId);
    assert.equal((await db.collection('accounts').doc(uid).collection('retentionTenures').get()).size, 1);
    const extended = await readRetentionContext(db, uid, renewed, [origin]);
    assert.equal(resolveRetention(output, start + 100 * day, extended).expiresAt, start + 125 * day);
    assert.deepEqual(output, original);
    assert.deepEqual(await lifecycle.transition(uid, 'activation-retention', command), paid);
    assert.deepEqual((await ref.get()).data(), renewed);
  });
});

test('reactivation extends a surviving tenure but a later tenure cannot revive expired archives', local, async () => {
  await withAccount(async ({ uid, db, lifecycle, setNow }) => {
    const command = { type: 'activate_paid' as const, expectedRevision: 0, plan: 'lower' as const, periodId: randomUUID(), startsAt: iso(start), expiresAt: iso(start + 30 * day) };
    const paid = await lifecycle.transition(uid, 'first-activation', command);
    const origin = { kind: 'paid' as const, tenureId: paid.retention!.paidTenureId! };
    const context = await readRetentionContext(db, uid, paid, [origin]);
    const policy = retentionPolicy('output', origin, context)!;
    const output = { kind: 'output' as const, expiresAt: policy.promisedUntil, retention: policy };
    setNow(start + 89 * day);
    const returning = await lifecycle.transition(uid, 'returning-activation', { ...command, expectedRevision: paid.revision, periodId: randomUUID(), startsAt: iso(start + 89 * day), expiresAt: iso(start + 119 * day) });
    assert.equal(returning.retention?.paidTenureId, origin.tenureId);
    assert.equal(resolveRetention(output, start + 100 * day, await readRetentionContext(db, uid, returning, [origin])).available, true);
    setNow(start + 179 * day);
    const later = await lifecycle.transition(uid, 'later-activation', { ...command, expectedRevision: returning.revision, periodId: randomUUID(), startsAt: iso(start + 179 * day), expiresAt: iso(start + 209 * day) });
    assert.notEqual(later.retention?.paidTenureId, origin.tenureId);
    assert.equal(resolveRetention(output, start + 180 * day, await readRetentionContext(db, uid, later, [origin])).available, false);
    assert.equal((await db.collection('accounts').doc(uid).collection('retentionTenures').get()).size, 2);
  });
});

test('missing or overflowing tenure facts reject transitions without partial grant or receipt writes', local, async () => {
  await withAccount(async ({ uid, db, ref, lifecycle, setNow }) => {
    const command = { type: 'activate_paid' as const, expectedRevision: 0, plan: 'lower' as const, periodId: randomUUID(), startsAt: iso(start), expiresAt: iso(start + 30 * day) };
    const paid = await lifecycle.transition(uid, 'initial-activation', command);
    const tenureRef = db.collection('accounts').doc(uid).collection('retentionTenures').doc(paid.retention!.paidTenureId!);
    const savedTenure = (await tenureRef.get()).data()!;
    setNow(start + 30 * day);
    const renew = { ...command, type: 'renew' as const, expectedRevision: paid.revision, periodId: randomUUID(), startsAt: iso(start + 30 * day), expiresAt: iso(start + 60 * day) };
    for (const invalid of [null, { ...savedTenure, revision: Number.MAX_SAFE_INTEGER }]) {
      if (invalid) await tenureRef.set(invalid); else await tenureRef.delete();
      await assert.rejects(lifecycle.transition(uid, 'invalid-renewal', renew), { code: 'lifecycle_conflict' });
      assert.deepEqual((await ref.get()).data(), paid);
      assert.equal((await db.collection('accounts').doc(uid).collection('lifecycleTransitions').doc('invalid-renewal').get()).exists, false);
      assert.equal((await db.collection('accounts').doc(uid).collection('allowancePeriods').doc(renew.periodId).get()).exists, false);
    }
  });
});
