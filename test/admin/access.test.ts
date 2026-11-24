import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseRequest, expiry, planRequest } from '../../src/admin/access.js';

import { startTrial, transitionLifecycle } from '../../src/access/lifecycle.js';

const activation = { eventId: 'activation_001', command: { type: 'activate_paid', expectedRevision: 0, plan: 'lower', periodId: 'period_001', startsAt: '2026-11-12T00:00:00Z', expiresAt: '2026-12-12T00:00:00.000Z' } };

test('administrative commands retain stable transition and funding identities', () => {
  assert.deepEqual(parseRequest(activation), activation);
  for (const type of ['upgrade', 'downgrade', 'cancel', 'withdraw']) {
    const request = { eventId: 'transition_001', command: { type, expectedRevision: 2 } };
    assert.deepEqual(parseRequest(request), request);
  }
  assert.deepEqual(parseRequest({ ...activation, command: { ...activation.command, type: 'renew', plan: 'higher' } }).command.type, 'renew');
});

test('administrative input cannot smuggle grant overrides, unknown commands or ambiguous dates', () => {
  for (const request of [null, [], { ...activation, uid: 'other-user' }, { ...activation, eventId: '../bad-id' },
    ...[{ type: 'start_trial' }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: '0' }, { plan: 'custom' }, { periodId: 'short' },
      { startsAt: '11/12/2026' }, { startsAt: '2026-11-12T00:00:00' }, { startsAt: '2026-02-30T00:00:00Z' },
      { expiresAt: '2026-11-01T00:00:00Z' }, { limits: { creationCredits: 999 } }, { type: 'upgrade', plan: 'higher' }]
      .map(change => ({ ...activation, command: { ...activation.command, ...change } }))]) {
    assert.throws(() => parseRequest(request));
  }
});

test('invalid CLI arguments are rejected before Firebase initialization', async () => {
  await assert.rejects(main([]), /Usage/);
  await assert.rejects(main(['--project', 'demo-riflo', '--uid', '../other']), /Usage/);
  await assert.rejects(main(['--project', 'demo-riflo', '--uid', 'test-user', '--grant', 'anything']), /Unknown option/);
});

test('request and emulator target validation happens before Firebase access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-admin-'));
  const request = join(directory, 'request.json');
  const firestore = process.env.FIRESTORE_EMULATOR_HOST;
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  try {
    await writeFile(request, '{');
    await assert.rejects(main(['--project', 'demo-riflo', '--uid', 'test-user', '--request', request]), SyntaxError);
    await writeFile(request, JSON.stringify({ ...activation, command: { type: 'start_trial', expectedRevision: 0 } }));
    await assert.rejects(main(['--project', 'demo-riflo', '--uid', 'test-user', '--request', request]), /supported lifecycle/);
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    await assert.rejects(main(['--project', 'demo-riflo', '--uid', 'test-user']), /both Auth and Firestore/);
  } finally {
    if (firestore === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = firestore;
    if (auth === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST; else process.env.FIREBASE_AUTH_EMULATOR_HOST = auth;
    await rm(directory, { recursive: true });
  }
});

const now = Date.parse('2026-11-12T12:00:00Z');
const until = '2026-12-12T00:00:00.000Z';

test('plan assignment uses ordinary activation and upgrade without resetting the period', () => {
  assert.equal(expiry('2026-12-12'), until);
  assert.throws(() => expiry('2026-02-30'));
  assert.throws(() => expiry('2026-12-12T00:00:00+05:30'));
  const trial = startTrial(null, 'trial_period', now);
  const request = planRequest(trial, 'lower', until, now)!;
  const lower = transitionLifecycle(trial, request.command, now);
  assert.equal(lower.trial, trial.trial);
  assert.equal(lower.paid?.plan, 'lower');
  assert.equal(planRequest(lower, 'lower', until, now), null);
  assert.throws(() => planRequest(lower, 'higher', expiry('2026-12-13'), now), /keep the current expiry/);
  const upgrade = planRequest(lower, 'higher', until, now)!;
  const higher = transitionLifecycle(lower, upgrade.command, now);
  assert.equal(higher.paid?.grant.allowancePeriodId, lower.paid?.grant.allowancePeriodId);
  assert.equal(higher.paid?.grant.expiresAt, lower.paid?.grant.expiresAt);
  const downgrade = planRequest(higher, 'lower', until, now)!;
  const scheduled = transitionLifecycle(higher, downgrade.command, now);
  assert.equal(scheduled.paid?.plan, 'higher');
  assert.equal(scheduled.paid?.nextPlan, 'lower');
  assert.equal(planRequest(scheduled, 'lower', until, now), null);
  assert.throws(() => planRequest(scheduled, 'higher', until, now), /downgrade is already scheduled.*not supported/);
  for (const record of [lower, higher]) {
    const cancelled = transitionLifecycle(record, { type: 'cancel', expectedRevision: record.revision }, now);
    for (const plan of ['lower', 'higher'] as const) {
      assert.throws(() => planRequest(cancelled, plan, until, now), /active paid period is cancelled.*--request/);
    }
  }
  assert.throws(() => planRequest({ status: 'active' }, 'lower', until, now), /migration/);
  assert.throws(() => planRequest({ ...trial, withdrawn: true }, 'lower', until, now), /withdrawn/);
  assert.throws(() => planRequest(null, 'lower', new Date(now).toISOString(), now), /future/);
});

test('convenience arguments reject ambiguous inputs before Firebase access', async () => {
  const target = ['--project', 'demo-riflo', '--uid', 'test-user'];
  for (const args of [['--request', ''], ['--plan', ''], ['--until', ''], ['--plan', 'lower', '--until', ''], ['--plan', 'lower'], ['--until', '2026-12-12'], ['--plan', 'custom', '--until', '2026-12-12'], ['--plan', 'lower', '--until', '2026-02-30'], ['--plan', 'higher', '--until', '2026-12-12', '--request', 'request.json']]) {
    await assert.rejects(main([...target, ...args]));
  }
});
