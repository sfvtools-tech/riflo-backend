import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AuthenticationError, createHandler } from '../../src/http/app.js';
import { featureIds, quotaKeys, generationBatchLimits } from '../../src/access/policy.js';

const now = new Date('2026-10-18T12:00:00Z');
const grant = () => ({
  status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z',
  features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, 0])),
});

async function request(options: Parameters<typeof createHandler>[0], path = '/v1/capabilities', token?: string, method = 'GET') {
  const server = createServer(createHandler(options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method, headers: token === undefined ? {} : { authorization: token },
    });
    return { status: response.status, body: await response.json(), allow: response.headers.get('allow'), challenge: response.headers.get('www-authenticate') };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('health is public; unknown routes and unsupported methods have JSON errors', async () => {
  const options = {
    verifyToken: async () => { throw Error('must not authenticate'); },
    loadGrant: async () => { throw Error('must not read'); },
  };
  assert.deepEqual((await request(options, '/health')).body, { data: { status: 'ok' } });
  const missing = await request(options, '/missing');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error.code, 'string');
  const method = await request(options, '/health', undefined, 'POST');
  assert.equal(method.status, 405);
  assert.equal(method.allow, 'GET');
});

test('missing, malformed, and rejected credentials cannot read account data', async () => {
  let reads = 0;
  const options = {
    verifyToken: async () => { throw new AuthenticationError('private provider failure'); },
    loadGrant: async () => {
      reads++;
      return grant();
    },
  };
  for (const token of [undefined, 'Basic token', 'Bearer ', 'Bearer rejected']) {
    const result = await request(options, '/v1/capabilities', token);
    assert.equal(result.status, 401);
    assert.equal(result.challenge, 'Bearer');
    assert.equal(typeof result.body.error.code, 'string');
    assert.ok(!JSON.stringify(result.body).includes('private provider failure'));
  }
  assert.equal(reads, 0);
});

test('OAuth callback validation errors do not advertise Firebase authentication', async () => {
  const result = await request({ verifyToken: async () => { throw Error('must not authenticate'); }, loadGrant: async () => undefined, drive: {} as NonNullable<Parameters<typeof createHandler>[0]['drive']> }, '/v1/drive/connection/callback');
  assert.equal(result.status, 400);
  assert.equal(result.challenge, null);
});

test('capabilities use the verified account and keep planned features unavailable', async () => {
  const loadedAccounts: string[] = [];
  const result = await request({
    verifyToken: async (token) => { assert.equal(token, 'valid'); return { uid: 'account-a' }; },
    loadGrant: async (uid) => { loadedAccounts.push(uid); return { ...grant(), privateCredential: 'secret-key' }; }, now: () => now,
  }, '/v1/capabilities', 'Bearer valid');
  assert.equal(result.status, 200);
  assert.deepEqual(loadedAccounts, ['account-a']);
  assert.equal(result.body.data.subscription.active, true);
  assert.deepEqual(result.body.data.limits, grant().limits);
  assert.deepEqual(result.body.data.generationBatchLimits, generationBatchLimits);
  assert.deepEqual(result.body.data.services, { drive: { configured: false }, intake: { configured: false }, generation: { configured: false }, sources: { drive: { configured: false }, youtube: { configured: false } } });
  for (const id of featureIds) {
    assert.equal(result.body.data.features[id].entitled, true);
    assert.equal(result.body.data.features[id].implemented, false);
    assert.equal(result.body.data.features[id].available, false);
    assert.equal(result.body.data.features[id].reason, 'not_implemented');
  }
  assert.ok(!JSON.stringify(result.body).includes('secret-key'));
});

test('missing, expired, future, and malformed subscriptions grant no feature access', async () => {
  const cases = [
    [undefined, 'subscription_required'],
    [{ ...grant(), expiresAt: now.toISOString() }, 'subscription_expired'],
    [{ ...grant(), startsAt: '2026-10-19T00:00:00Z' }, 'subscription_not_started'],
    [{ ...grant(), limits: {} }, 'invalid_subscription'],
    [{ ...grant(), limits: { ...grant().limits, sourceSeconds: -1 } }, 'invalid_subscription'],
    [{ ...grant(), limits: { ...grant().limits, sourceSeconds: 1.5 } }, 'invalid_subscription'],
    [{ ...grant(), expiresAt: 'invalid' }, 'invalid_subscription'],
    [{ ...grant(), startsAt: '2026-02-30T00:00:00Z' }, 'invalid_subscription'],
    [{ ...grant(), features: ['unknown'] }, 'invalid_subscription'],
  ] as const;
  for (const [raw, reason] of cases) {
    const result = await request({ verifyToken: async () => ({ uid: 'a' }), loadGrant: async () => raw, now: () => now }, '/v1/capabilities', 'Bearer valid');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.subscription.active, false);
    assert.equal(result.body.data.subscription.reason, reason);
    assert.equal(result.body.data.limits, null);
    for (const feature of Object.values(result.body.data.features) as Array<{ entitled: boolean; available: boolean }>) {
      assert.equal(feature.entitled, false);
      assert.equal(feature.available, false);
    }
  }
});

test('account overrides are rejected and storage failures do not leak details', async () => {
  let reads = 0;
  const options = {
    verifyToken: async () => ({ uid: 'a' }),
    loadGrant: async () => {
      reads++;
      throw Error('database-secret');
    },
  };
  const override = await request(options, '/v1/capabilities?uid=b', 'Bearer valid');
  assert.equal(override.status, 400);
  assert.equal(reads, 0);
  const unavailable = await request(options, '/v1/capabilities', 'Bearer valid');
  assert.equal(unavailable.status, 503);
  assert.equal(typeof unavailable.body.error.code, 'string');
  assert.ok(!JSON.stringify(unavailable.body).includes('database-secret'));
});

test('subscription features and account isolation come only from the verified identity', async () => {
  const options = {
    verifyToken: async (token: string) => ({ uid: token }),
    loadGrant: async (uid: string) => uid === 'alice' ? { ...grant(), features: ['x_posts'] } : undefined,
    now: () => now,
  };
  const alice = await request(options, '/v1/capabilities', 'Bearer alice');
  const bob = await request(options, '/v1/capabilities', 'Bearer bob');
  assert.equal(alice.body.data.features.x_posts.entitled, true);
  assert.equal(alice.body.data.features.linkedin_posts.entitled, false);
  assert.equal(alice.body.data.features.linkedin_posts.reason, 'feature_not_in_plan');
  assert.equal(bob.body.data.subscription.reason, 'subscription_required');
});

test('production startup rejects emulator configuration before connecting', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'demo-riflo', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Firebase emulators require/);
});

test('capabilities distinguish configured intake from unavailable generation without granting access', async () => {
  const result = await request({
    verifyToken: async () => ({ uid: 'a' }),
    loadGrant: async () => undefined,
    projects: {} as NonNullable<Parameters<typeof createHandler>[0]['projects']>,
    now: () => now,
  }, '/v1/capabilities', 'Bearer valid');
  assert.equal(result.body.data.services.intake.configured, true);
  assert.equal(result.body.data.services.generation.configured, false);
  assert.equal(result.body.data.subscription.active, false);
  assert.equal(result.body.data.features.x_posts.available, false);
});

test('source readiness comes from the backend and does not hide existing project access', async () => {
  const result = await request({
    verifyToken: async () => ({ uid: 'a' }), loadGrant: async () => undefined,
    projects: {} as NonNullable<Parameters<typeof createHandler>[0]['projects']>,
    intakeConfigured: false,
    sourceAvailability: { drive: { configured: false }, youtube: { configured: true } },
  }, '/v1/capabilities', 'Bearer valid');
  assert.deepEqual(result.body.data.services.sources, { drive: { configured: false }, youtube: { configured: true } });
  assert.equal(result.body.data.services.intake.configured, false);
  assert.equal(result.body.data.subscription.active, false);
});
