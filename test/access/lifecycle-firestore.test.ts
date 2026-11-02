import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createProjectService } from '../../src/projects/service.js';
import { planGrant } from '../../src/access/plans.js';
import { emptyCounters } from '../../src/access/accounting.js';
import { isLifecycle, transitionLifecycle } from '../../src/access/lifecycle.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-29T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const paid = (expectedRevision: number) => ({ type: 'activate_paid' as const, expectedRevision, plan: 'lower' as const, periodId: `paid_${randomUUID()}`, startsAt: iso(now), expiresAt: iso(now + 31 * 86_400_000) });

async function withAccount(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const value = await setup();
  try { await run(value); }
  finally {
    for (const collection of ['intakeJobs', 'generationJobs']) {
      const jobs = await value.db.collection(collection).where('uid', '==', value.uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    await value.db.recursiveDelete(value.db.collection('accounts').doc(value.uid));
    await value.db.recursiveDelete(value.ref);
    await value.db.terminate();
    await deleteApp(value.app);
  }
}

async function setup() {
  const uid = `lifecycle-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const ref = db.collection('subscriptionGrants').doc(uid);
  let clock = now;
  const setNow = (value: number) => { clock = value; };
  const lifecycle = createLifecycleStore(db, { now: () => clock });
  const projects = createProjectStore(db);
  return { uid, app, db, ref, lifecycle, projects, setNow };
}

test('concurrent first initiations persist one trial clock and never reset an expired trial', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref }) => {
    await Promise.all(Array.from({ length: 6 }, (_, index) => lifecycle.startTrial(uid, now + index)));
    const original = (await ref.get()).data()!;
    assert.ok(Date.parse(original.trial.startsAt) >= now && Date.parse(original.trial.startsAt) <= now + 5);
    assert.equal(Date.parse(original.trial.expiresAt) - Date.parse(original.trial.startsAt), 7 * 86_400_000);
    await lifecycle.startTrial(uid, now + 8 * 86_400_000);
    assert.deepEqual((await ref.get()).data(), original);
    assert.equal((await ref.collection('allowances').get()).size, 0);
  });
});

test('transition receipts replay old results after later events and reject changed payload or stale predecessors', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, db }) => {
    const command = paid(0);
    const first = await lifecycle.transition(uid, 'paid_activation_01', command);
    const snapshot = (await ref.get()).data()!;
    const ledger = db.collection('accounts').doc(uid).collection('allowances').doc(`shared-${command.periodId}`);
    const counters = emptyCounters();
    counters.reserved.creationCredits = 3;
    counters.consumed.creationCredits = 17;
    counters.reserved.sourceSeconds = 50;
    counters.consumed.sourceSeconds = 100;
    await ledger.set(counters);
    await lifecycle.transition(uid, 'upgrade_paid_0001', { type: 'upgrade', expectedRevision: snapshot.revision });
    const upgraded = (await ref.get()).data()!;
    assert.equal(upgraded.paid.plan, 'higher');
    assert.equal(upgraded.paid.grant.allowancePeriodId, snapshot.paid.grant.allowancePeriodId);
    assert.deepEqual((await ledger.get()).data(), counters);
    assert.deepEqual(await lifecycle.transition(uid, 'paid_activation_01', command), first);
    assert.deepEqual((await ref.get()).data(), upgraded);
    await assert.rejects(lifecycle.transition(uid, 'paid_activation_01', { ...command, plan: 'higher' }));
    await assert.rejects(lifecycle.transition(uid, 'stale_cancel_0001', { type: 'cancel', expectedRevision: snapshot.revision }));
    assert.deepEqual((await ref.get()).data(), upgraded);
  });
});

test('racing paid activation and first import cannot grant a second trial or overwrite paid state', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref }) => {
    const [trial, activation] = await Promise.allSettled([lifecycle.startTrial(uid, now), lifecycle.transition(uid, 'race_activation_01', paid(0))]);
    assert.equal(trial.status, 'fulfilled');
    let saved = (await ref.get()).data()!;
    if (activation.status === 'rejected') {
      assert.equal(activation.reason.code, 'lifecycle_conflict');
      assert.equal(saved.paid, null);
      assert.equal(saved.revision, 1);
      assert.equal(saved.trial.startsAt, iso(now));
      await lifecycle.transition(uid, 'race_activation_02', paid(saved.revision));
      saved = (await ref.get()).data()!;
    } else {
      assert.deepEqual(saved, activation.value);
      assert.equal(saved.trial, null);
      assert.equal(saved.revision, 1);
    }
    assert.equal(saved.paid.plan, 'lower');
    const original = structuredClone(saved);
    await lifecycle.startTrial(uid, now + 1000).catch(() => undefined);
    assert.deepEqual((await ref.get()).data(), original);
    if (saved.trial) assert.equal(saved.trial.startsAt, iso(now));
  });
});

test('upstream import failure preserves activated trial and consumes no source allowance', local, async () => {
  await withAccount(async ({ uid, lifecycle, projects, ref, db }) => {
    let validations = 0;
    const service = createProjectService({ store: projects, now: () => now, validateSource: async () => {
      validations++;
      assert.ok((await ref.get()).data()!.trial);
      throw Error('Fixture source validation failure');
    } });
    const authorize = async () => { await lifecycle.startTrial(uid, now); };
    await assert.rejects(service.create(uid, { fileId: 'source-file' }, 'failed_import_01', authorize), /Fixture source validation failure/);
    const trial = (await ref.get()).data()!;
    assert.equal(trial.trial.startsAt, iso(now));
    assert.equal(validations, 1);
    assert.equal((await projects.list(uid)).length, 0);
    assert.equal((await db.collection('accounts').doc(uid).collection('allowances').get()).size, 0);
    await assert.rejects(service.create(uid, { fileId: 'source-file' }, 'failed_import_02', authorize));
    assert.deepEqual((await ref.get()).data(), trial);
  });
});

test('invalid local requests never activate a trial and accepted replay skips authorization and validation', local, async () => {
  await withAccount(async ({ uid, lifecycle, projects, ref }) => {
    let validations = 0;
    let authorizations = 0;
    const service = createProjectService({ store: projects, now: () => now, validateSource: async () => {
      validations++;
      return { fileId: 'source-file', name: 'source.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true };
    } });
    const authorize = async () => { authorizations++; await lifecycle.startTrial(uid, now); };
    for (const [input, key] of [[{ fileId: 'source-file' }, 'bad'], [{ fileId: 'https://invalid.example' }, 'invalid_source_01']] as const) {
      await assert.rejects(service.create(uid, input, key, authorize));
    }
    assert.equal((await ref.get()).exists, false);
    assert.equal(authorizations, 0);
    assert.equal(validations, 0);
    const accepted = await service.create(uid, { fileId: 'source-file' }, 'accepted_import_01', authorize);
    const before = (await ref.get()).data();
    assert.deepEqual(await service.create(uid, { fileId: 'source-file' }, 'accepted_import_01', async () => assert.fail('Replay must skip activation')), accepted);
    assert.equal(validations, 1);
    assert.deepEqual((await ref.get()).data(), before);
    await assert.rejects(service.create(uid, { fileId: 'different-file' }, 'accepted_import_01', authorize), { code: 'idempotency_conflict' });
    assert.equal(validations, 1);
  });
});

test('manual grant ownership stays isolated and cannot receive an automatic trial', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref }) => {
    const existing = planGrant('lower', 'manual_period_001', iso(now - 1000), iso(now + 1000));
    await ref.set(existing);
    await lifecycle.startTrial(uid, now).catch(() => undefined);
    assert.deepEqual((await ref.get()).data(), existing);
    const otherUid = `${uid}-other`;
    const otherRef = ref.parent.doc(otherUid);
    try {
      await lifecycle.startTrial(otherUid, now);
      assert.ok((await otherRef.get()).data()!.trial);
      assert.deepEqual((await ref.get()).data(), existing);
    } finally { await otherRef.firestore.recursiveDelete(otherRef); }
  });
});

test('an unused historical paid identity cannot be recycled to grant fresh limits', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, setNow }) => {
    const first = paid(0);
    await lifecycle.transition(uid, 'period_history_01', first);
    let state = (await ref.get()).data()!;
    const second = { ...first, type: 'renew' as const, expectedRevision: state.revision, periodId: 'second_paid_period', startsAt: first.expiresAt, expiresAt: iso(now + 62 * 86_400_000) };
    setNow(Date.parse(second.startsAt));
    await lifecycle.transition(uid, 'period_history_02', second);
    state = (await ref.get()).data()!;
    setNow(Date.parse(second.expiresAt));
    await assert.rejects(lifecycle.transition(uid, 'period_history_03', { ...second, expectedRevision: state.revision, periodId: first.periodId, startsAt: second.expiresAt, expiresAt: iso(now + 93 * 86_400_000) }), { code: 'lifecycle_conflict' });
    assert.deepEqual((await ref.get()).data(), state);
  });
});

test('expired canceled access reactivates once while preserving old balances and receipts', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, db, setNow }) => {
    const trial = await lifecycle.startTrial(uid, now);
    const activation = paid(trial.revision);
    await lifecycle.transition(uid, 'first_paid_activation', activation);
    let saved = (await ref.get()).data()!;
    await lifecycle.transition(uid, 'cancel_first_period', { type: 'cancel', expectedRevision: saved.revision });
    saved = (await ref.get()).data()!;
    const ledger = db.collection('accounts').doc(uid).collection('allowances').doc(`shared-${activation.periodId}`);
    const counters = emptyCounters();
    counters.reserved.creationCredits = 4;
    counters.consumed.creationCredits = 12;
    await ledger.set(counters);
    const end = Date.parse(saved.paid.grant.expiresAt);
    const next = { ...activation, expectedRevision: saved.revision, periodId: 'resubscribed_paid_period', startsAt: iso(end), expiresAt: iso(end + 31 * 86_400_000) };
    await assert.rejects(lifecycle.transition(uid, 'early_resubscription', next), { code: 'lifecycle_conflict' });
    assert.deepEqual((await ref.get()).data(), saved);
    setNow(end);
    const result = await lifecycle.transition(uid, 'paid_resubscription', next);
    assert.deepEqual(result.trial, trial.trial);
    assert.equal(result.paid.grant.allowancePeriodId, next.periodId);
    assert.equal(result.paid.cancelAtPeriodEnd, false);
    assert.deepEqual((await ledger.get()).data(), counters);
    assert.deepEqual(await lifecycle.transition(uid, 'paid_resubscription', next), result);
    assert.deepEqual((await ref.get()).data(), result);
    assert.deepEqual((await ledger.get()).data(), counters);
    assert.equal((await db.collection('accounts').doc(uid).collection('lifecycleTransitions').get()).size, 3);
  });
});

test('invalid tagged records and overflowing transitions preserve grants, ledgers and transition evidence', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, db }) => {
    const command = paid(0);
    const lower = transitionLifecycle(undefined, command, now);
    const account = db.collection('accounts').doc(uid);
    const ledger = account.collection('allowances').doc(`shared-${command.periodId}`);
    const counters = emptyCounters();
    counters.reserved.creationCredits = 3;
    counters.consumed.creationCredits = 17;
    await ledger.set(counters);
    const unchanged = async (saved: unknown) => {
      assert.deepEqual((await ref.get()).data(), saved);
      assert.deepEqual((await ledger.get()).data(), counters);
      assert.equal((await account.collection('lifecycleTransitions').get()).size, 0);
      assert.equal((await account.collection('allowancePeriods').get()).size, 0);
      assert.equal((await account.collection('allowances').get()).size, 1);
    };
    for (const version of [1, 2]) {
      const invalid = { ...lower.paid!.grant, kind: 'lifecycle', version, revision: 1, withdrawn: true, trial: {}, paid: null };
      await ref.set(invalid);
      await assert.rejects(lifecycle.startTrial(uid, now), { status: 409, code: 'lifecycle_conflict' });
      await assert.rejects(lifecycle.transition(uid, `invalid_tagged_${version}`, { type: 'withdraw', expectedRevision: 1 }), { status: 409, code: 'lifecycle_conflict' });
      await unchanged(invalid);
    }
    for (const meter of ['creationCredits', 'sourceSeconds'] as const) {
      const corrected = structuredClone(lower);
      corrected.paid!.grant.limits[meter] = Number.MAX_SAFE_INTEGER;
      assert.ok(isLifecycle(corrected));
      await ref.set(corrected);
      await assert.rejects(lifecycle.transition(uid, `overflow_${meter}`, { type: 'upgrade', expectedRevision: corrected.revision }), { status: 409, code: 'lifecycle_conflict' });
      await unchanged(corrected);
    }
    const exhausted = { ...lower, revision: Number.MAX_SAFE_INTEGER };
    await ref.set(exhausted);
    for (const type of ['withdraw', 'cancel', 'upgrade'] as const) {
      await assert.rejects(lifecycle.transition(uid, `overflow_${type}`, { type, expectedRevision: exhausted.revision }), { status: 409, code: 'lifecycle_conflict' });
      await unchanged(exhausted);
    }
    const eligible = { ...exhausted, paid: null };
    await ref.set(eligible);
    await assert.rejects(lifecycle.startTrial(uid, now), { status: 409, code: 'lifecycle_conflict' });
    await unchanged(eligible);
    await assert.rejects(lifecycle.transition(uid, 'overflow_activation', { ...command, expectedRevision: eligible.revision }), { status: 409, code: 'lifecycle_conflict' });
    await unchanged(eligible);
  });
});
