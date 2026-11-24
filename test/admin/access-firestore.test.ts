import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const exec = promisify(execFile);
const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST };

test('real admin CLI replans convenience commands and preserves explicit immutable retries', local, async () => {
  const project = 'demo-riflo';
  const uid = `admin-${randomUUID()}`;
  const app = initializeApp({ projectId: project }, uid);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const directory = await mkdtemp(join(tmpdir(), 'riflo-admin-cli-'));
  const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const base = ['--project', project, '--uid', uid];
  const plan = (value: string) => ['--plan', value, '--until', until];
  const cli = async (args: string[], code = 0) => {
    let result: { stdout: string; stderr: string; code?: number };
    try {
      result = await exec(process.execPath, ['--import', 'tsx', resolve('src/admin/access.ts'), ...base, ...args], { env: { ...process.env, HOME: directory }, timeout: 30_000 });
    } catch (error) { result = error as typeof result; }
    assert.equal(result.code ?? 0, code, result.stderr);
    assert.match(result.stderr, new RegExp(`Target: project=${project} uid=${uid} emulators firestore=`));
    assert.ok(result.stderr.includes(`auth=${process.env.FIREBASE_AUTH_EMULATOR_HOST}`));
    if (code) assert.equal(result.stdout, '');
    return { ...result, state: result.stdout ? JSON.parse(result.stdout) : undefined };
  };
  const ref = db.collection('subscriptionGrants').doc(uid);
  const account = db.collection('accounts').doc(uid);
  const current = async () => (await ref.get()).data()!;
  const explicit = async (type: string, revision: number) => {
    const path = join(directory, `${type}.json`);
    await writeFile(path, JSON.stringify({ eventId: randomUUID(), command: { type, expectedRevision: revision } }));
    return ['--request', path];
  };
  try {
    await auth.createUser({ uid });
    const first = await cli(plan('lower'));
    assert.equal(first.state.lifecycle.paid.plan, 'lower');
    assert.ok(first.state.eventId);
    const initial = await current();
    const ledger = account.collection('allowances').doc(`shared-${initial.paid.grant.allowancePeriodId}`);
    const counters = { reserved: { creationCredits: 3, sourceSeconds: 60 }, consumed: { creationCredits: 7, sourceSeconds: 120 } };
    await ledger.set(counters);
    const retry = await cli(plan('lower'));
    assert.equal(retry.state.eventId, undefined);
    const read = await cli([]);
    assert.deepEqual(read.state, retry.state);
    assert.deepEqual(await current(), initial);
    const upgrade = await cli(plan('higher'));
    assert.equal(upgrade.state.lifecycle.paid.plan, 'higher');
    const higher = await current();
    assert.equal(higher.paid.grant.allowancePeriodId, initial.paid.grant.allowancePeriodId);
    assert.equal(higher.paid.grant.expiresAt, initial.paid.grant.expiresAt);
    const repeatHigher = await cli(plan('higher'));
    assert.equal(repeatHigher.state.eventId, undefined);
    assert.deepEqual(await current(), higher);
    const downgrade = await cli(plan('lower'));
    assert.equal(downgrade.state.lifecycle.paid.plan, 'higher');
    assert.equal(downgrade.state.lifecycle.paid.nextPlan, 'lower');
    const scheduled = await current();
    const scheduledReplay = await cli(plan('lower'));
    assert.equal(scheduledReplay.state.lifecycle.paid.nextPlan, 'lower');
    assert.equal(scheduledReplay.state.eventId, undefined);
    assert.deepEqual(await current(), scheduled);
    const refused = await cli(plan('higher'), 1);
    assert.match(refused.stderr, /downgrade is already scheduled.*not supported/);
    assert.deepEqual(await current(), scheduled);
    const cancelRequest = await explicit('cancel', scheduled.revision);
    const concurrent = await Promise.all([cli(cancelRequest), cli(cancelRequest)]);
    assert.equal(concurrent[0].state.eventId, concurrent[1].state.eventId);
    const cancelled = await current();
    await cli(plan('lower'), 1);
    const withdrawRequest = await explicit('withdraw', cancelled.revision);
    await cli(withdrawRequest);
    const withdrawn = await current();
    // Replaying an older explicit event displays the current account state.
    const explicitReplay = await cli(cancelRequest);
    assert.equal(explicitReplay.state.revision, withdrawn.revision);
    assert.equal(explicitReplay.state.lifecycle.paid.cancelAtPeriodEnd, true);
    assert.deepEqual(await current(), withdrawn);
    assert.deepEqual((await ledger.get()).data(), counters);
    assert.equal((await account.collection('allowancePeriods').get()).size, 1);
    assert.equal((await account.collection('retentionTenures').get()).size, 1);
    assert.equal((await account.collection('lifecycleTransitions').get()).size, 5);
  } finally {
    await auth.deleteUser(uid).catch(() => {});
    await db.recursiveDelete(account);
    await ref.delete();
    await db.terminate();
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled active plans reject fresh convenience changes without changing access', local, async () => {
  const { createLifecycleStore } = await import('../../src/access/lifecycle-firestore.js');
  const app = initializeApp({ projectId: 'demo-riflo' }, `cancelled-admin-${randomUUID()}`);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const store = createLifecycleStore(db);
  const directory = await mkdtemp(join(tmpdir(), 'riflo-admin-cancelled-'));
  try {
    for (const plan of ['lower', 'higher'] as const) {
      const uid = `admin-${randomUUID()}`;
      const now = Date.now();
      const until = new Date(now + 30 * 86_400_000).toISOString();
      const account = db.collection('accounts').doc(uid);
      const ref = db.collection('subscriptionGrants').doc(uid);
      try {
        await auth.createUser({ uid });
        const activated = await store.transition(uid, randomUUID(), { type: 'activate_paid', expectedRevision: 0, plan, periodId: randomUUID(), startsAt: new Date(now).toISOString(), expiresAt: until });
        await store.transition(uid, randomUUID(), { type: 'cancel', expectedRevision: activated.revision });
        const before = (await ref.get()).data();
        await assert.rejects(exec(process.execPath, ['--import', 'tsx', resolve('src/admin/access.ts'), '--project', 'demo-riflo', '--uid', uid, '--plan', plan === 'lower' ? 'higher' : 'lower', '--until', until], { env: { ...process.env, HOME: directory }, timeout: 30_000 }), (error: unknown) => {
          const failure = error as { code: number; stderr: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr, /lifecycle_conflict.*active paid period is cancelled.*--request/);
          return true;
        });
        assert.deepEqual((await ref.get()).data(), before);
        assert.equal((await account.collection('lifecycleTransitions').get()).size, 2);
        assert.equal((await account.collection('allowancePeriods').get()).size, 1);
      } finally {
        await auth.deleteUser(uid).catch(() => {});
        await db.recursiveDelete(account);
        await ref.delete();
      }
    }
  } finally {
    await db.terminate();
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
