import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHandler, type Dependencies } from '../../src/http/app.js';
import { readTrialConfig } from '../../src/config.js';
import { startTrial, transitionLifecycle } from '../../src/access/lifecycle.js';
import { publicProject, type Project } from '../../src/projects/service.js';

const now = Date.parse('2026-10-29T12:00:00Z');
const source = { source: 'youtube' as const, videoId: 'abcdefghijk', name: 'Video', mimeType: 'video/mp4', bytes: null, durationSeconds: 30, requiresProbe: true };

async function withApi(overrides: Partial<Dependencies>, run: (request: (path: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const server = createServer(createHandler({ verifyToken: async token => ({ uid: token }), loadGrant: async () => null, now: () => new Date(now), ...overrides }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((path, body) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json', 'idempotency-key': 'trial_import_001' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('real-user trial activation is disabled by default and configuration fails closed', () => {
  assert.equal(readTrialConfig({}), false);
  assert.equal(readTrialConfig({ TRIAL_ENABLED: 'false' }), false);
  assert.equal(readTrialConfig({ TRIAL_ENABLED: 'true' }), true);
  for (const value of ['', 'TRUE', '1', 'yes', ' false ']) assert.throws(() => readTrialConfig({ TRIAL_ENABLED: value }));
});

test('trial-disabled capabilities and source preparation cannot enable an unstarted account', async () => {
  let inspections = 0;
  await withApi({ sourceValidation: async () => { inspections++; return source; } }, async request => {
    const capabilities = await (await request('/v1/capabilities')).json();
    assert.equal(capabilities.data.subscription.active, false);
    assert.notEqual(capabilities.data.intake?.available, true);
    assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' })).status, 403);
  });
  assert.equal(inspections, 0);
});

test('eligible source preparation and Drive setup do not activate trial or expose generation entitlement', async () => {
  let grantReads = 0;
  const calls: string[] = [];
  await withApi({ trialEnabled: true, loadGrant: async () => { grantReads++; return null; }, sourceValidation: async uid => { calls.push(`source:${uid}`); return source; }, driveFiles: {
    pickerSession: async uid => { calls.push(`picker:${uid}`); return { accessToken: 'fixture', expiresAt: new Date(now + 1000).toISOString() }; },
    validate: async () => { throw Error('Unused'); },
  }, drive: {
    authorize: async uid => { calls.push(`oauth:${uid}`); return { authorizationUrl: 'https://example.test/authorize' }; },
    complete: async () => {}, status: async () => ({ configured: true, connected: false }), disconnect: async () => ({ configured: true, connected: false, revocation: 'not_needed' }),
  } }, async request => {
    const response = await request('/v1/capabilities');
    assert.equal(response.status, 200);
    const capabilities = (await response.json()).data;
    assert.equal(capabilities.subscription.active, false);
    assert.equal(capabilities.intake.available, true);
    assert.equal(capabilities.features.x_posts.entitled, false);
    assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' })).status, 200);
    assert.equal((await request('/v1/drive/picker-session')).status, 200);
    assert.equal((await request('/v1/drive/connection/authorize', {})).status, 200);
  });
  assert.ok(grantReads >= 4);
  assert.deepEqual(calls, ['source:alice', 'picker:alice', 'oauth:alice']);
});

test('malformed, revoked, expired and withdrawn accounts cannot use trial preparation', async () => {
  const trial = startTrial(undefined, 'trial_period_001', now - 8 * 86_400_000);
  const withdrawn = transitionLifecycle(startTrial(undefined, 'trial_period_002', now), { type: 'withdraw', expectedRevision: 1 });
  for (const grant of [{}, { status: 'revoked' }, trial, withdrawn]) {
    await withApi({ trialEnabled: true, loadGrant: async () => grant, sourceValidation: async () => assert.fail('Ineligible account cannot inspect upstream') }, async request => {
      assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' })).status, 403);
      const capabilities = (await (await request('/v1/capabilities')).json()).data;
      assert.notEqual(capabilities.intake?.available, true);
    });
  }
});

test('inactive and unstarted accounts retain project and usage reads without activating trial', async () => {
  const project: Project = { id: 'saved-project', uid: 'alice', status: 'source_expired', input: { fileId: 'source-file' }, source: { fileId: 'source-file', name: 'Saved source', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: false }, createdAt: now - 1000, updatedAt: now, deadline: now + 1000, sourceExpiresAt: now, storagePath: null, attempts: 1, errorCode: null, period: 'saved-period', reservedSourceSeconds: 0 };
  const saved = publicProject(project, now);
  const usage = { limits: {}, reserved: {}, consumed: {}, remaining: {} };
  const unexpected = async (): Promise<never> => assert.fail('A read must not invoke a command');
  const projects: NonNullable<Dependencies['projects']> = { create: unexpected, retry: unexpected, restoreSource: unexpected, remove: unexpected, get: async uid => { assert.equal(uid, 'alice'); return saved; }, list: async () => [saved], usage: async () => usage };
  for (const raw of [null, { status: 'revoked' }]) {
    await withApi({ trialEnabled: true, loadGrant: async () => raw, projects }, async request => {
      assert.equal((await request('/v1/projects')).status, 200);
      assert.deepEqual((await (await request('/v1/projects/saved-project')).json()).data, saved);
      assert.deepEqual((await (await request('/v1/usage')).json()).data, usage);
    });
  }
});
