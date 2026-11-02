import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createTrialAbuseStore, trialOwnerKey, trialSubjectKey, type RequestIdentity } from '../../src/access/trial-abuse.js';
import { readTrialAbuseKey } from '../../src/config.js';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { startTrial, transitionLifecycle } from '../../src/access/lifecycle.js';
import { createProjectService } from '../../src/projects/service.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { emptyCounters } from '../../src/access/accounting.js';
import { operationalLimits } from '../../src/access/policy.js';

const key = Buffer.alloc(32, 0x35);
const now = Date.parse('2026-10-30T10:00:00Z');
const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const identity = (uid = `abuse-${randomUUID()}`, subject = randomUUID()): RequestIdentity => ({ uid, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': [subject] } } });
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const source = { source: 'youtube' as const, videoId: 'abcdefghijk', name: 'Fixture', mimeType: 'video/mp4', bytes: null, durationSeconds: 30, requiresProbe: true };

async function fixture(run: (value: { db: ReturnType<typeof getFirestore>; abuse: ReturnType<typeof createTrialAbuseStore>; lifecycle: ReturnType<typeof createLifecycleStore>; identities: RequestIdentity[]; add: (value?: RequestIdentity) => RequestIdentity }) => Promise<void>) {
  const app = initializeApp({ projectId: 'demo-riflo' }, `trial-abuse-${randomUUID()}`);
  const db = getFirestore(app);
  const identities: RequestIdentity[] = [];
  const add = (value = identity()) => { identities.push(value); return value; };
  try { await run({ db, abuse: createTrialAbuseStore(db, key), lifecycle: createLifecycleStore(db, { retentionEnabled: true }), identities, add }); }
  finally {
    for (const item of identities) {
      const subject = trialSubjectKey(item, key);
      await Promise.all([
        db.collection('trialAbuseClaims').doc(subject).delete(), db.collection('trialAbuseRates').doc(subject).delete(),
        db.collection('trialAbuseBindings').doc(trialOwnerKey(item.uid)).delete(), db.collection('trialAbuseRates').doc(`uid-${trialOwnerKey(item.uid)}`).delete(),
        db.collection('subscriptionGrants').doc(item.uid).delete(), db.recursiveDelete(db.collection('accounts').doc(item.uid)),
      ]);
      const jobs = await db.collection('intakeJobs').where('uid', '==', item.uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    await db.terminate();
    await deleteApp(app);
  }
}

test('dedicated trial key is explicit and verified reserved Google claims are required', () => {
  assert.equal(readTrialAbuseKey({}), undefined);
  assert.deepEqual(readTrialAbuseKey({ TRIAL_ABUSE_HMAC_KEY: '35'.repeat(32) }), key);
  for (const value of ['', '35'.repeat(31), 'x'.repeat(64), 'a'.repeat(65)]) assert.throws(() => readTrialAbuseKey({ TRIAL_ABUSE_HMAC_KEY: value }));
  const valid = identity();
  assert.match(trialSubjectKey(valid, key), /^[a-f0-9]{64}$/);
  assert.equal(trialSubjectKey({ ...valid, uid: 'other-uid' }, key), trialSubjectKey(valid, key));
  assert.notEqual(trialSubjectKey(valid, Buffer.alloc(32, 1)), trialSubjectKey(valid, key));
  assert.throws(() => trialSubjectKey(valid), code('trial_not_configured'));
  for (const value of [ { uid: valid.uid }, { ...valid, email_verified: false }, { ...valid, firebase: { ...valid.firebase, sign_in_provider: 'password' } }, { ...valid, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': [] } } }, { ...valid, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['one', 'two'] } } }, { ...valid, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['bad/subject'] } } } ]) assert.throws(() => trialSubjectKey(value, key), code('trial_identity_required'));
});

test('concurrent different UIDs sharing Google identity activate at most one trial', local, async () => fixture(async ({ db, lifecycle, add }) => {
  const first = add(); const second = add(identity());
  // Keep the provider subject identical while Riflo UIDs remain independent.
  second.firebase = first.firebase;
  const subject = trialSubjectKey(first, key);
  const results = await Promise.allSettled([lifecycle.startTrial(first.uid, now, subject), lifecycle.startTrial(second.uid, now, subject)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'trial_already_used');
  assert.equal((await db.collection('trialAbuseClaims').doc(subject).get()).data()!.startedAt, now);
  assert.equal((await Promise.all([lifecycle.get(first.uid), lifecycle.get(second.uid)])).filter(Boolean).length, 1);
}));

test('same UID concurrency preserves its clock and claim; account/lifecycle reset cannot regain a trial', local, async () => fixture(async ({ db, lifecycle, abuse, add }) => {
  const user = add(); const subject = trialSubjectKey(user, key);
  await Promise.all([lifecycle.startTrial(user.uid, now, subject), lifecycle.startTrial(user.uid, now + 1, subject)]);
  const saved = await lifecycle.get(user.uid);
  await lifecycle.startTrial(user.uid, now + 8 * 86_400_000, subject);
  assert.deepEqual(await lifecycle.get(user.uid), saved);
  await db.recursiveDelete(db.collection('accounts').doc(user.uid));
  await db.collection('subscriptionGrants').doc(user.uid).delete();
  await assert.rejects(abuse.prepare(user, now), code('trial_already_used'));
  const changedGoogle = add(identity(user.uid));
  await assert.rejects(abuse.prepare(changedGoogle, now), code('trial_already_used'));
  await assert.rejects(lifecycle.startTrial(user.uid, now + 99, trialSubjectKey(changedGoogle, key)), code('trial_already_used'));
  const recreated = add(identity(undefined)); recreated.firebase = user.firebase;
  await assert.rejects(abuse.prepare(recreated, now), code('trial_already_used'));
  assert.equal(await lifecycle.get(user.uid), null);
}));

test('independent Google identities and UIDs retain separate trials; paid/full allowances bypass the gate', local, async () => fixture(async ({ db, lifecycle, abuse, add }) => {
  const first = add(); const second = add();
  await Promise.all([lifecycle.startTrial(first.uid, now, trialSubjectKey(first, key)), lifecycle.startTrial(second.uid, now, trialSubjectKey(second, key))]);
  const current = await lifecycle.get(first.uid);
  const paid = transitionLifecycle(current, { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: `paid_${randomUUID()}`, startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 31 * 86_400_000).toISOString() }, now);
  await db.collection('subscriptionGrants').doc(first.uid).set(paid);
  await Promise.all(Array.from({ length: 70 }, () => abuse.prepare({ uid: first.uid }, now)));
  assert.equal(paid.paid!.grant.limits.creationCredits, 120);
  assert.equal(paid.trial!.limits.creationCredits, 15);
  assert.equal(paid.trial!.startsAt, (current as any).trial.startsAt);
  await db.collection('subscriptionGrants').doc(first.uid).set({ status: 'active' });
  await abuse.prepare({ uid: first.uid }, now);
}));

test('shared persistent minute/hour budget bounds concurrent provider work and supplies exact retry delay', local, async () => fixture(async ({ abuse, add, db }) => {
  const user = add();
  const results = await Promise.allSettled(Array.from({ length: 14 }, () => abuse.prepare(user, now)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
  for (const result of results.filter(result => result.status === 'rejected') as PromiseRejectedResult[]) {
    assert.equal(result.reason.code, 'trial_rate_limited'); assert.equal(result.reason.retryAfterSeconds, 60);
  }
  const rate = (await db.collection('trialAbuseRates').doc(trialSubjectKey(user, key)).get()).data()!;
  assert.equal(rate.minute.count, 10); assert.equal(rate.hour.count, 10);
  assert.equal(rate.expiresAt.toMillis(), now + 86_400_000);
  await assert.rejects(abuse.prepare(user, now - 10), (error: any) => error.code === 'trial_rate_limited' && error.retryAfterSeconds === 61);
  for (let minute = 1; minute < 6; minute++) for (let count = 0; count < 10; count++) await abuse.prepare(user, now + minute * 60_000);
  await assert.rejects(abuse.prepare(user, now + 6 * 60_000), (error: any) => error.code === 'trial_rate_limited' && error.retryAfterSeconds === 3240);
  await abuse.prepare(user, now + 3_600_000);
}));

test('new trial work uses same subject budget after activation; old trials need no new sign-in/key', local, async () => fixture(async ({ abuse, lifecycle, add, db }) => {
  const user = add();
  for (let i = 0; i < 9; i++) await abuse.prepare(user, now);
  const current = await lifecycle.startTrial(user.uid, now, trialSubjectKey(user, key));
  await abuse.prepare({ uid: user.uid }, now);
  await assert.rejects(abuse.prepare({ uid: user.uid }, now), code('trial_rate_limited'));
  const legacy = add(); const old = startTrial(null, 'old-trial-period', now);
  await db.collection('subscriptionGrants').doc(legacy.uid).set(old);
  const noSecret = createTrialAbuseStore(db);
  await noSecret.prepare({ uid: legacy.uid }, now);
  assert.equal((await db.collection('trialAbuseRates').doc(`uid-${trialOwnerKey(legacy.uid)}`).get()).exists, true);
  await assert.rejects(noSecret.prepare(add(), now), code('trial_not_configured'));
}));

test('malformed private rate/binding records fail safely and durable claims never silently reset', local, async () => fixture(async ({ abuse, db, add }) => {
  const user = add(); const subject = trialSubjectKey(user, key);
  const ref = db.collection('trialAbuseRates').doc(subject);
  await ref.set({ version: 1, minute: { startsAt: now, count: -1 } });
  await assert.rejects(abuse.prepare(user, now), /Invalid trial rate state/);
  await ref.delete();
  await db.collection('trialAbuseClaims').doc(subject).set({ broken: true });
  await assert.rejects(abuse.prepare(user, now), code('trial_already_used'));
  await db.collection('trialAbuseClaims').doc(subject).delete();
  await db.collection('trialAbuseBindings').doc(trialOwnerKey(user.uid)).set({ broken: true });
  await db.collection('subscriptionGrants').doc(user.uid).set(startTrial(null, 'legacy-period', now));
  await assert.rejects(abuse.prepare({ uid: user.uid }, now), /Invalid trial identity binding/);
}));

test('cheap queue/source rejection precedes provider cost, rate reservation and trial clock; failed validation keeps clock', local, async () => fixture(async ({ abuse, lifecycle, db, add }) => {
  const user = add(); const store = createProjectStore(db);
  let providers = 0;
  const service = createProjectService({ store, now: () => now,
    beforeValidateSource: async () => abuse.prepare(user, now, true),
    startTrial: async () => { await lifecycle.startTrial(user.uid, now, trialSubjectKey(user, key)); },
    validateSource: async () => { providers++; throw Error('controlled metadata failure'); },
  });
  await assert.rejects(service.create(user.uid, { source: 'youtube', videoId: 'bad' }, 'valid_key_001'), code('invalid_source'));
  await db.collection('accounts').doc(user.uid).collection('processing').doc('current').set({ active: null, queued: operationalLimits.queuedProjects });
  await assert.rejects(service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'valid_key_001'), code('queue_full'));
  assert.equal(await lifecycle.get(user.uid), null); assert.equal(providers, 0);
  assert.equal((await db.collection('trialAbuseRates').doc(trialSubjectKey(user, key)).get()).exists, false);
  await db.collection('accounts').doc(user.uid).collection('processing').doc('current').delete();
  await assert.rejects(service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'valid_key_001'), /controlled metadata failure/);
  const saved = await lifecycle.get(user.uid) as any;
  assert.equal(saved.trial.startsAt, new Date(now).toISOString()); assert.equal(providers, 1);
  await assert.rejects(service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'valid_key_002'), /controlled metadata failure/);
  assert.deepEqual(await lifecycle.get(user.uid), saved);
  const counters = emptyCounters(); counters.consumed.sourceSeconds = 2700;
  await db.collection('accounts').doc(user.uid).collection('allowances').doc(`shared-${saved.trial.allowancePeriodId}`).set(counters);
  await assert.rejects(service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'valid_key_003'), code('allowance_exceeded'));
  assert.equal(providers, 2);
}));

test('accepted import replay stays free under lost configuration, rate rejection and revoked new access', local, async () => fixture(async ({ abuse, lifecycle, db, add }) => {
  const user = add(); const store = createProjectStore(db); let gate = 0; let providers = 0;
  const service = createProjectService({ store, now: () => now,
    beforeValidateSource: async () => { gate++; await abuse.prepare(user, now, true); },
    startTrial: async () => { await lifecycle.startTrial(user.uid, now, trialSubjectKey(user, key)); },
    validateSource: async () => { providers++; return source; },
  });
  const first = await service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'replay_key_001');
  const rate = db.collection('trialAbuseRates').doc(trialSubjectKey(user, key));
  await rate.update({ workCount: 120 });
  await assert.rejects(service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'fresh_key_002'), code('trial_work_limited'));
  assert.deepEqual(await service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'replay_key_001'), first);
  await db.collection('subscriptionGrants').doc(user.uid).set({ status: 'revoked' });
  const replay = await service.create(user.uid, { source: 'youtube', videoId: 'abcdefghijk' }, 'replay_key_001', async () => { throw Error('new request denied'); });
  assert.deepEqual(replay, first); assert.equal(providers, 1); assert.equal(gate, 2);
}));

test('paid activation race never overwrites paid state or leaves claim without a newly started trial', local, async () => fixture(async ({ db, lifecycle, add }) => {
  const user = add(); const subject = trialSubjectKey(user, key);
  const command = { type: 'activate_paid' as const, expectedRevision: 0, plan: 'lower' as const, periodId: `paid_${randomUUID()}`, startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 31 * 86_400_000).toISOString() };
  await Promise.allSettled([lifecycle.startTrial(user.uid, now, subject), lifecycle.transition(user.uid, 'abuse_paid_race_01', command)]);
  const saved = await lifecycle.get(user.uid) as any;
  assert.equal((await db.collection('trialAbuseClaims').doc(subject).get()).exists, Boolean(saved.trial));
  assert.ok(saved.trial || saved.paid);
  if (saved.paid) assert.equal(saved.paid.grant.limits.creationCredits, 120);
}));


test('trial costly commands have a cumulative atomic ceiling across windows while cheap checks stay available', local, async () => fixture(async ({ db, abuse, lifecycle, add }) => {
  const user = add(); const subject = trialSubjectKey(user, key);
  // The first import reserves before activation; failures keep their reservation.
  await abuse.prepare(user, now, true);
  await lifecycle.startTrial(user.uid, now + 1, subject);
  for (let i = 1; i < 119; i++) await abuse.prepare({ uid: user.uid }, now + i * 120_000, true);
  const later = now + 119 * 120_000;
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => abuse.prepare({ uid: user.uid }, later, true)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected') as PromiseRejectedResult[]) {
    assert.equal(result.reason.status, 403); assert.equal(result.reason.code, 'trial_work_limited'); assert.equal(result.reason.retryAfterSeconds, undefined);
  }
  const before = (await db.collection('trialAbuseRates').doc(subject).get()).data()!;
  assert.equal(before.workCount, 120);
  assert.ok(before.expiresAt.toMillis() >= now + 1 + 8 * 86_400_000);
  await abuse.prepare({ uid: user.uid }, now + 86_400_000);
  const after = (await db.collection('trialAbuseRates').doc(subject).get()).data()!;
  assert.equal(after.workCount, 120); assert.equal(after.expiresAt.toMillis(), before.expiresAt.toMillis());
  await assert.rejects(abuse.prepare({ uid: user.uid }, now + 2 * 86_400_000, true), code('trial_work_limited'));
}));

test('legacy active trials acquire the command ceiling without new identity configuration; malformed counters fail closed', local, async () => fixture(async ({ db, add }) => {
  const user = add(); const noSecret = createTrialAbuseStore(db);
  await db.collection('subscriptionGrants').doc(user.uid).set(startTrial(null, 'legacy-command-period', now));
  const ref = db.collection('trialAbuseRates').doc(`uid-${trialOwnerKey(user.uid)}`);
  await noSecret.prepare({ uid: user.uid }, now, true);
  const saved = (await ref.get()).data()!;
  assert.equal(saved.workCount, 1); assert.equal(saved.expiresAt.toMillis(), now + 8 * 86_400_000);
  await ref.set({ ...saved, workCount: 120 });
  await assert.rejects(noSecret.prepare({ uid: user.uid }, now + 3_600_000, true), code('trial_work_limited'));
  for (const workCount of [null, -1, 1.5, '120']) {
    await ref.set({ ...saved, workCount });
    await assert.rejects(noSecret.prepare({ uid: user.uid }, now, true), /Invalid trial command state/);
  }
}));
