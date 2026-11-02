import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AuthenticationError, createHandler } from '../../src/http/app.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createDriveService, driveScope, hash, type DriveSession, type DriveConnection, type DriveStore } from '../../src/sources/drive/service.js';
import { createDriveOAuth } from '../../src/sources/drive/google.js';
import { createDriveCodec } from '../../src/sources/drive/tokens.js';
import { readDriveConfig } from '../../src/sources/drive/config.js';

const key = Buffer.alloc(32, 7).toString('base64');
const config = { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://riflo.example/v1/drive/connection/callback', encryptionKey: key, secureCookie: true };
const fixedTime = Date.parse('2026-10-18T12:00:00Z');
const paidGrant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((id) => [id, 1])) };

function createDriveFixture() {
  const sessions = new Map<string, DriveSession>();
  const connections = new Map<string, DriveConnection>();
  let clock = fixedTime;
  const codec = createDriveCodec(key);
  const exchanged: Array<{ code: string; verifier: string }> = [];
  const revoked: string[] = [];
  let tokens = { refreshToken: 'private-refresh-token', scope: driveScope };
  let exchangeFailure: Error | undefined;
  let exchangeWait: Promise<void> | undefined;
  let revokeFailure = false;
  const store: DriveStore = {
    async begin(state, session) {
      const previous = connections.get(session.uid);
      const version = (previous?.version ?? 0) + 1;
      connections.set(session.uid, { ...previous, version });
      sessions.set(state, { ...session, version });
    },
    async consume(state, binding, now) {
      const session = sessions.get(state);
      if (!session || session.bindingHash !== binding || session.expiresAt <= now || connections.get(session.uid)?.version !== session.version) {
        return null;
      }
      sessions.delete(state);
      return session;
    },
    async save(uid, version, token) {
      if (connections.get(uid)?.version !== version) {
        return false;
      }
      connections.set(uid, { version, token });
      return true;
    },
    async read(uid) { return connections.get(uid) ?? null; },
    async remove(uid) {
      const previous = connections.get(uid) ?? null;
      connections.set(uid, { version: (previous?.version ?? 0) + 1 });
      return previous;
    },
  };
  const oauth = {
    authorizationUrl: (state: string, challenge: string) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state, code_challenge: challenge })}`,
    async exchange(code: string, verifier: string) {
      exchanged.push({ code, verifier });
      await exchangeWait;
      if (exchangeFailure) {
        throw exchangeFailure;
      }
      return tokens;
    },
    async revoke(token: string) {
      revoked.push(token);
      if (revokeFailure) {
        throw Error('private-revoke-error');
      }
    },
  };
  const drive = createDriveService({ store, oauth, codec, now: () => clock });
  return {
    drive, sessions, connections, codec, exchanged, revoked,
    tick: (milliseconds: number) => { clock += milliseconds; },
    setTokens: (value: typeof tokens) => { tokens = value; },
    failExchange: () => { exchangeFailure = Error('private-provider-error'); },
    failRevoke: () => { revokeFailure = true; },
    pauseExchange: () => {
      let resume!: () => void;
      exchangeWait = new Promise<void>((resolve) => { resume = resolve; });
      return resume;
    },
  };
}

async function withApi(
  run: (request: (
    path: string,
    options?: { method?: string; token?: string; cookie?: string },
  ) => Promise<{ status: number; body: any; cookie: string | null }>) => Promise<void>,
  drive: ReturnType<typeof createDriveService> | null = createDriveFixture().drive,
  grant: unknown = paidGrant,
) {
  const server = createServer(createHandler({
    verifyToken: async (token) => {
      if (token === 'bad') {
        throw new AuthenticationError();
      }
      return { uid: token };
    },
    loadGrant: async () => grant, now: () => new Date(fixedTime), ...(drive ? { drive } : {}), driveSecureCookie: true,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(async (path, options = {}) => {
      const headers: Record<string, string> = {};
      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
      }
      if (options.cookie) {
        headers.cookie = options.cookie;
      }
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: options.method ?? 'GET', headers });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Drive authorization requires sign-in and an active paid subscription', async () => {
  await withApi(async (request) => {
    for (const token of [undefined, 'bad']) {
      assert.equal((await request('/v1/drive/connection/authorize', { method: 'POST', token })).status, 401);
    }
  });
  for (const grant of [undefined, { ...paidGrant, expiresAt: '2026-10-17T00:00:00Z' }]) {
    await withApi(async (request) => {
      assert.equal((await request('/v1/drive/connection/authorize', { method: 'POST', token: 'alice' })).status, 403);
      assert.equal((await request('/v1/drive/connection', { token: 'alice' })).status, 200);
    }, createDriveFixture().drive, grant ?? null);
  }
});

test('missing Drive configuration does not break health or subscription discovery', async () => {
  await withApi(async (request) => {
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/v1/capabilities', { token: 'alice' })).status, 200);
    assert.equal((await request('/v1/drive/connection/authorize', { method: 'POST', token: 'alice' })).status, 503);
    assert.equal((await request('/v1/drive/connection', { token: 'alice' })).body.data.configured, false);
  }, null);
});

test('callback consent errors are safe JSON and consume their matching request', async () => {
  const fixture = createDriveFixture();
  await withApi(async (request) => {
    const authorize = await request('/v1/drive/connection/authorize', { method: 'POST', token: 'alice' });
    const state = new URL(authorize.body.data.authorizationUrl).searchParams.get('state')!;
    const cookie = authorize.cookie!.split(';')[0]!;
    const denied = await request(`/v1/drive/connection/callback?state=${state}&error=access_denied`, { cookie });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'drive_consent_denied');
    assert.equal((await request(`/v1/drive/connection/callback?state=${state}&code=code`, { cookie })).status, 400);
    assert.equal(fixture.exchanged.length, 0);
  }, fixture.drive);
});

test('only the original browser can finish connecting Drive for its account', async () => {
  const fixture = createDriveFixture();
  await withApi(async (request) => {
    const authorize = await request('/v1/drive/connection/authorize', { method: 'POST', token: 'alice' });
    assert.equal(authorize.status, 200);
    const state = new URL(authorize.body.data.authorizationUrl).searchParams.get('state')!;
    assert.match(authorize.cookie!, /HttpOnly/i);
    assert.match(authorize.cookie!, /SameSite=Lax/i);
    assert.match(authorize.cookie!, /Secure/i);
    assert.match(authorize.cookie!, /Path=\/v1\/drive\/connection\/callback/);
    const cookie = authorize.cookie!.split(';')[0]!;
    const callback = `/v1/drive/connection/callback?state=${state}&code=google-code`;
    assert.equal((await request(callback)).status, 400);
    assert.equal((await request(callback, { cookie: `riflo_drive_oauth=${'x'.repeat(43)}` })).status, 400);
    assert.equal(fixture.exchanged.length, 0);
    const completed = await request(callback, { cookie });
    assert.equal(completed.status, 200);
    assert.equal((await request(callback, { cookie })).status, 400);
    assert.equal(fixture.exchanged.length, 1);
    assert.equal(hash(fixture.exchanged[0]!.verifier), new URL(authorize.body.data.authorizationUrl).searchParams.get('code_challenge'));
    assert.equal(fixture.codec.open(fixture.connections.get('alice')!.token!, 'alice'), 'private-refresh-token');
    assert.ok(!fixture.connections.get('alice')!.token!.includes('private-refresh-token'));
    const alice = await request('/v1/drive/connection', { token: 'alice' });
    const bob = await request('/v1/drive/connection', { token: 'bob' });
    assert.equal(alice.body.data.connected, true);
    assert.equal(bob.body.data.connected, false);
    assert.ok(!JSON.stringify([completed.body, alice.body]).includes('private-refresh-token'));
  }, fixture.drive);
});

test('expired requests and denied consent cannot exchange tokens', async () => {
  const fixture = createDriveFixture();
  let url = await fixture.drive.authorize('alice', 'browser');
  fixture.tick(600_000);
  await assert.rejects(fixture.drive.complete(new URL(url.authorizationUrl).searchParams.get('state')!, 'browser', { code: 'code' }), { code: 'invalid_oauth_state' });
  url = await fixture.drive.authorize('alice', 'browser');
  const state = new URL(url.authorizationUrl).searchParams.get('state')!;
  await assert.rejects(fixture.drive.complete(state, 'browser', { error: 'access_denied' }), { code: 'drive_consent_denied' });
  await assert.rejects(fixture.drive.complete(state, 'browser', { code: 'code' }), { code: 'invalid_oauth_state' });
  assert.equal(fixture.exchanged.length, 0);
});

test('failed reconnection preserves an existing token and rejects incomplete Google permissions', async () => {
  for (const tokens of [{ refreshToken: '', scope: driveScope }, { refreshToken: 'new-private-token', scope: 'openid email' }]) {
    const fixture = createDriveFixture();
    fixture.connections.set('alice', { version: 1, token: fixture.codec.seal('existing-token', 'alice') });
    fixture.setTokens(tokens);
    const { authorizationUrl } = await fixture.drive.authorize('alice', 'browser');
    await assert.rejects(fixture.drive.complete(new URL(authorizationUrl).searchParams.get('state')!, 'browser', { code: 'code' }), { code: 'drive_permission_required' });
    assert.equal(fixture.codec.open(fixture.connections.get('alice')!.token!, 'alice'), 'existing-token');
  }
  const fixture = createDriveFixture();
  fixture.connections.set('alice', { version: 1, token: fixture.codec.seal('existing-token', 'alice') });
  fixture.failExchange();
  const { authorizationUrl } = await fixture.drive.authorize('alice', 'browser');
  await assert.rejects(fixture.drive.complete(new URL(authorizationUrl).searchParams.get('state')!, 'browser', { code: 'code' }));
  assert.equal(fixture.codec.open(fixture.connections.get('alice')!.token!, 'alice'), 'existing-token');
});

test('callback reports exchange failures and missing offline permission without leaking provider details', async () => {
  for (const mode of ['failure', 'missing-refresh', 'missing-scope']) {
    const fixture = createDriveFixture();
    if (mode === 'failure') {
      fixture.failExchange();
    } else {
      fixture.setTokens({ refreshToken: mode === 'missing-refresh' ? '' : 'private-refresh-token', scope: mode === 'missing-scope' ? 'openid' : driveScope });
    }
    await withApi(async (request) => {
      const authorize = await request('/v1/drive/connection/authorize', { method: 'POST', token: 'alice' });
      const state = new URL(authorize.body.data.authorizationUrl).searchParams.get('state')!;
      const result = await request(`/v1/drive/connection/callback?state=${state}&code=private-auth-code`, { cookie: authorize.cookie!.split(';')[0]! });
      assert.equal(result.status, mode === 'failure' ? 503 : 400);
      assert.equal(result.body.error.code, mode === 'failure' ? 'service_unavailable' : 'drive_permission_required');
      assert.ok(!JSON.stringify(result.body).includes('private-'));
      assert.equal((await fixture.drive.status('alice')).connected, false);
    }, fixture.drive);
  }
});

test('disconnect invalidates callbacks already exchanging tokens and keeps other accounts connected', async () => {
  const fixture = createDriveFixture();
  fixture.connections.set('bob', { version: 1, token: fixture.codec.seal('bob-token', 'bob') });
  const { authorizationUrl } = await fixture.drive.authorize('alice', 'browser');
  const resume = fixture.pauseExchange();
  const completion = fixture.drive.complete(new URL(authorizationUrl).searchParams.get('state')!, 'browser', { code: 'code' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.exchanged.length, 1);
  await fixture.drive.disconnect('alice');
  resume();
  await assert.rejects(completion, { code: 'stale_connection' });
  assert.equal((await fixture.drive.status('alice')).connected, false);
  assert.equal((await fixture.drive.status('bob')).connected, true);
  assert.deepEqual(await fixture.drive.disconnect('bob'), { connected: false, revocation: 'revoked' });
  assert.deepEqual(fixture.revoked, ['bob-token']);
});

test('expired subscribers can disconnect even when Google revocation fails', async () => {
  const fixture = createDriveFixture();
  fixture.connections.set('alice', { version: 1, token: fixture.codec.seal('alice-token', 'alice') });
  fixture.connections.set('bob', { version: 1, token: fixture.codec.seal('bob-token', 'bob') });
  fixture.failRevoke();
  await withApi(async (request) => {
    const response = await request('/v1/drive/connection', { method: 'DELETE', token: 'alice' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { connected: false, revocation: 'failed' });
    assert.equal((await fixture.drive.status('alice')).connected, false);
    assert.equal((await fixture.drive.status('bob')).connected, true);
    assert.deepEqual(fixture.revoked, ['alice-token']);
  }, fixture.drive, { ...paidGrant, expiresAt: '2026-10-17T00:00:00Z' });
});

test('starting a new Drive connection cancels the previous connection request', async () => {
  const fixture = createDriveFixture();
  const first = await fixture.drive.authorize('alice', 'browser');
  const second = await fixture.drive.authorize('alice', 'browser');
  await assert.rejects(fixture.drive.complete(new URL(first.authorizationUrl).searchParams.get('state')!, 'browser', { code: 'code' }), { code: 'invalid_oauth_state' });
  assert.equal(fixture.exchanged.length, 0);
  await fixture.drive.complete(new URL(second.authorizationUrl).searchParams.get('state')!, 'browser', { code: 'code' });
  assert.equal(fixture.exchanged.length, 1);
});

test('refresh-token encryption rejects tampering and a different owner', () => {
  const codec = createDriveCodec(key);
  const token = codec.seal('refresh-token', 'alice');
  assert.equal(codec.open(token, 'alice'), 'refresh-token');
  assert.notEqual(codec.seal('refresh-token', 'alice'), token);
  assert.throws(() => codec.open(token, 'bob'));
  const bytes = Buffer.from(token, 'base64url');
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  assert.throws(() => codec.open(bytes.toString('base64url'), 'alice'));
});

test('Drive configuration is optional but complete configuration requires safe redirects', () => {
  assert.equal(readDriveConfig({}), undefined);
  assert.throws(() => readDriveConfig({ GOOGLE_DRIVE_CLIENT_ID: 'id' }));
  const env = { NODE_ENV: 'production', GOOGLE_DRIVE_CLIENT_ID: config.clientId, GOOGLE_DRIVE_CLIENT_SECRET: config.clientSecret, GOOGLE_DRIVE_REDIRECT_URI: config.redirectUri, DRIVE_TOKEN_ENCRYPTION_KEY: key };
  assert.equal(readDriveConfig(env)?.secureCookie, true);
  for (const uri of ['http://localhost/v1/drive/connection/callback', 'https://riflo.example/wrong', `${config.redirectUri}?spoof=1`, 'https://user:pass@riflo.example/v1/drive/connection/callback']) {
    assert.throws(() => readDriveConfig({ ...env, GOOGLE_DRIVE_REDIRECT_URI: uri }));
  }
  assert.equal(readDriveConfig({ ...env, NODE_ENV: 'development', GOOGLE_DRIVE_REDIRECT_URI: 'http://localhost/v1/drive/connection/callback' })?.secureCookie, false);
});

test('Google adapter requests only per-file offline access and exchanges with PKCE', async () => {
  const calls: Array<{ url: string; body: URLSearchParams; redirect: RequestRedirect | undefined }> = [];
  const oauth = createDriveOAuth(config, async (input, init) => {
    calls.push({ url: String(input), body: init!.body as URLSearchParams, redirect: init!.redirect });
    return Response.json({ refresh_token: 'refresh-token', scope: driveScope });
  });
  const url = new URL(oauth.authorizationUrl('state', 'challenge'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), driveScope);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await oauth.exchange('auth-code', 'verifier');
  assert.equal(calls[0]!.body.get('code_verifier'), 'verifier');
  assert.equal(calls[0]!.body.get('client_secret'), config.clientSecret);
  assert.equal(calls[0]!.redirect, 'error');
  for (const response of [new Response('private-error', { status: 500 }), new Response('private-error', { status: 400 }), new Response('not-json')]) {
    const failing = createDriveOAuth(config, async () => response);
    await assert.rejects(failing.exchange('code', 'verifier'), (error: Error) => !error.message.includes('private-error'));
  }
});
