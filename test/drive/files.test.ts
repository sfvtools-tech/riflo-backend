import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHandler, AuthenticationError } from '../../src/http/app.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createDriveCodec } from '../../src/sources/drive/tokens.js';
import { createDriveFileService, parseDriveFileInput } from '../../src/sources/drive/files.js';
import { createDriveFilesGoogle } from '../../src/sources/drive/files-google.js';
import { DriveError, driveScope, type DriveConnection } from '../../src/sources/drive/service.js';

const fixedTime = Date.parse('2026-10-18T12:00:00Z');
const key = Buffer.alloc(32, 9).toString('base64');
const config = { clientId: 'client-id', clientSecret: 'private-client-secret', redirectUri: 'https://riflo.example/v1/drive/connection/callback', encryptionKey: key, secureCookie: true };
const paidGrant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((id) => [id, 1])) };
const validMetadata = () => ({ id: 'video-id', name: 'My video.mp4', mimeType: 'video/mp4', size: '1024', trashed: false, capabilities: { canDownload: true }, videoMediaMetadata: { durationMillis: '60000' } });

function createFileFixture() {
  const codec = createDriveCodec(key);
  const connections = new Map<string, DriveConnection>([['alice', { version: 1, token: codec.seal('private-refresh-token', 'alice') }]]);
  let metadata: unknown = validMetadata();
  let tokens = { accessToken: 'picker-access-token', expiresIn: 3600, scope: driveScope };
  const refreshCalls: string[] = [];
  const metadataCalls: unknown[] = [];
  let afterRefresh: (() => void) | undefined;
  let afterMetadata: (() => void) | undefined;
  let refreshFailure: Error | undefined;
  const service = createDriveFileService({
    store: { read: async (uid) => connections.get(uid) ?? null }, codec, now: () => fixedTime,
    google: {
      refresh: async (refreshToken) => {
        refreshCalls.push(refreshToken);
        if (refreshFailure) {
          throw refreshFailure;
        }
        afterRefresh?.();
        return tokens;
      },
      metadata: async (accessToken, input) => {
        metadataCalls.push({ accessToken, input });
        afterMetadata?.();
        return metadata;
      },
    },
  });
  return { service, connections, refreshCalls, metadataCalls,
    setMetadata: (value: unknown) => { metadata = value; },
    setTokens: (value: typeof tokens) => { tokens = value; },
    afterRefresh: (action: () => void) => { afterRefresh = action; },
    afterMetadata: (action: () => void) => { afterMetadata = action; },
    failRefresh: (error: Error) => { refreshFailure = error; },
  };
}

async function withApi(
  run: (request: (path: string, options?: { method?: string; token?: string; body?: string; contentType?: string }) => Promise<{ status: number; body: any; cache: string | null }>) => Promise<void>,
  fixture = createFileFixture(), grant: unknown = paidGrant,
) {
  const server = createServer(createHandler({
    verifyToken: async (token) => {
      if (token === 'bad') {
        throw new AuthenticationError();
      }
      return { uid: token };
    },
    loadGrant: async () => grant, now: () => new Date(fixedTime), driveFiles: fixture.service,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(async (path, options = {}) => {
      const headers: Record<string, string> = {};
      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
      }
      if (options.contentType) {
        headers['content-type'] = options.contentType;
      }
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: options.body }) });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Picker access and video validation require sign-in and an active subscription', async () => {
  const routes = [{ path: '/v1/drive/picker-session', method: 'GET' }, { path: '/v1/drive/files/validate', method: 'POST' }];
  await withApi(async (request) => {
    for (const route of routes) {
      for (const token of [undefined, 'bad']) {
        const result = await request(route.path, { method: route.method, token, body: route.method === 'POST' ? '{}' : undefined, contentType: 'application/json' });
        assert.equal(result.status, 401);
        assert.equal(result.cache, 'no-store');
      }
    }
  });
  await withApi(async (request) => {
    for (const route of routes) {
      assert.equal((await request(route.path, { method: route.method, token: 'alice' })).status, 403);
    }
  }, createFileFixture(), null);
});

test('Picker access belongs to the signed-in account and never includes its refresh token', async () => {
  const fixture = createFileFixture();
  await withApi(async (request) => {
    const result = await request('/v1/drive/picker-session', { token: 'alice' });
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    assert.deepEqual(result.body.data, { accessToken: 'picker-access-token', expiresAt: '2026-10-18T13:00:00.000Z' });
    assert.ok(!JSON.stringify(result.body).includes('private-refresh-token'));
    assert.equal((await request('/v1/drive/picker-session', { token: 'bob' })).status, 409);
    assert.deepEqual(fixture.refreshCalls, ['private-refresh-token']);
  }, fixture);
});

test('validation accepts only a small JSON file selection and returns safe metadata', async () => {
  const fixture = createFileFixture();
  await withApi(async (request) => {
    const path = '/v1/drive/files/validate';
    for (const body of ['{', 'null', '[]', '{}', '{"fileId":"https://evil.example/video"}', '{"fileId":"../secret"}', '{"fileId":"video-id","resourceKey":"bad key"}', '{"fileId":"video-id","url":"https://evil.example"}']) {
      assert.equal((await request(path, { method: 'POST', token: 'alice', contentType: 'application/json', body })).status, 400);
    }
    assert.equal((await request(path, { method: 'POST', token: 'alice', body: '{"fileId":"video-id"}' })).status, 415);
    assert.equal((await request(path, { method: 'POST', token: 'alice', contentType: 'application/json', body: JSON.stringify({ fileId: 'x'.repeat(5000) }) })).status, 413);
    assert.equal(fixture.metadataCalls.length, 0);
    const result = await request(path, { method: 'POST', token: 'alice', contentType: 'application/json', body: '{"fileId":"video-id","resourceKey":"resource-key"}' });
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    assert.deepEqual(result.body.data, { fileId: 'video-id', name: 'My video.mp4', mimeType: 'video/mp4', bytes: 1024, durationSeconds: 60, canDownload: true, requiresProbe: true });
    assert.ok(!JSON.stringify(result.body).includes('token'));
    assert.deepEqual(fixture.metadataCalls, [{ accessToken: 'picker-access-token', input: { fileId: 'video-id', resourceKey: 'resource-key' } }]);
  }, fixture);
});

test('file selection rejects malformed identifiers and unsupported fields', () => {
  for (const value of [{ fileId: '' }, { fileId: 'x'.repeat(257) }, { fileId: 'video-id', resourceKey: '' }, { fileId: 'video-id', resourceKey: 1 }, { fileId: 'video-id', uid: 'bob' }]) {
    assert.throws(() => parseDriveFileInput(value));
  }
  assert.deepEqual(parseDriveFileInput({ fileId: 'video-id' }), { fileId: 'video-id' });
});

test('video checks reject unsupported content, blocked downloads, and source limits', async () => {
  const rejected = [
    { ...validMetadata(), mimeType: 'application/pdf' }, { ...validMetadata(), trashed: true },
    { ...validMetadata(), capabilities: { canDownload: false } }, { ...validMetadata(), size: String(2 * 1024 ** 3 + 1) },
    { ...validMetadata(), videoMediaMetadata: { durationMillis: '1800001' } },
  ];
  for (const metadata of rejected) {
    const fixture = createFileFixture();
    fixture.setMetadata(metadata);
    await assert.rejects(fixture.service.validate('alice', { fileId: 'video-id' }), { status: 422 });
  }
  const fixture = createFileFixture();
  fixture.setMetadata({ ...validMetadata(), size: String(2 * 1024 ** 3), videoMediaMetadata: { durationMillis: '1800000' } });
  assert.equal((await fixture.service.validate('alice', { fileId: 'video-id' })).durationSeconds, 1800);
  fixture.setMetadata({ ...validMetadata(), videoMediaMetadata: {} });
  const missingDuration = await fixture.service.validate('alice', { fileId: 'video-id' });
  assert.equal(missingDuration.durationSeconds, null);
  assert.equal(missingDuration.requiresProbe, true);
});

test('invalid Google metadata is rejected instead of being trusted', async () => {
  for (const metadata of [null, {}, { ...validMetadata(), id: 'different-file' }, { ...validMetadata(), size: '-1' }, { ...validMetadata(), size: '1.5' }, { ...validMetadata(), size: '9007199254740992' }, { ...validMetadata(), videoMediaMetadata: { durationMillis: 'not-a-number' } }]) {
    const fixture = createFileFixture();
    fixture.setMetadata(metadata);
    await assert.rejects(fixture.service.validate('alice', { fileId: 'video-id' }), { status: 502 });
  }
});

test('a disconnected or replaced account cannot receive an already requested Picker token', async () => {
  for (const replacement of [undefined, { version: 2 }]) {
    const fixture = createFileFixture();
    fixture.afterRefresh(() => {
      if (replacement) {
        fixture.connections.set('alice', replacement);
      } else {
        fixture.connections.delete('alice');
      }
    });
    await assert.rejects(fixture.service.pickerSession('alice'), { status: 409 });
  }
});

test('disconnecting while file details arrive discards those details', async () => {
  const fixture = createFileFixture();
  fixture.afterMetadata(() => fixture.connections.delete('alice'));
  await assert.rejects(fixture.service.validate('alice', { fileId: 'video-id' }), { status: 409, code: 'stale_connection' });
});

test('API errors explain reconnect and file limits without revealing credentials', async () => {
  const fixture = createFileFixture();
  fixture.setMetadata({ ...validMetadata(), size: String(2 * 1024 ** 3 + 1), privateToken: 'private-provider-secret' });
  await withApi(async (request) => {
    const result = await request('/v1/drive/files/validate', { method: 'POST', token: 'alice', contentType: 'application/json', body: '{"fileId":"video-id"}' });
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'source_too_large');
    assert.equal(result.cache, 'no-store');
    assert.ok(!JSON.stringify(result.body).includes('private-'));
    fixture.failRefresh(new DriveError(409, 'drive_reconnect_required', 'Connect Google Drive again.'));
    const revoked = await request('/v1/drive/picker-session', { token: 'alice' });
    assert.equal(revoked.status, 409);
    assert.equal(revoked.body.error.code, 'drive_reconnect_required');
    assert.equal(revoked.cache, 'no-store');
  }, fixture);
});

test('Google requests use fixed endpoints and send resource keys only in their header', async () => {
  const calls: Array<{ url: URL; options: RequestInit }> = [];
  const google = createDriveFilesGoogle(config, async (input, options) => {
    const url = new URL(String(input));
    calls.push({ url, options: options! });
    return Response.json(url.hostname === 'oauth2.googleapis.com' ? { access_token: 'access-token', expires_in: 3600, scope: driveScope } : validMetadata());
  });
  await google.refresh('private-refresh-token');
  await google.metadata('access-token', { fileId: 'video-id', resourceKey: 'resource-key' });
  assert.equal(calls[0]!.url.href, 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(calls[0]!.options.body as URLSearchParams).get('grant_type'), 'refresh_token');
  assert.equal(calls[1]!.url.origin, 'https://www.googleapis.com');
  assert.equal(calls[1]!.url.pathname, '/drive/v3/files/video-id');
  assert.ok(!calls[1]!.url.href.includes('resource-key'));
  const headers = new Headers(calls[1]!.options.headers);
  assert.equal(headers.get('authorization'), 'Bearer access-token');
  assert.equal(headers.get('x-goog-drive-resource-keys'), 'video-id/resource-key');
  assert.ok(calls.every((call) => call.options.redirect === 'error'));
  await assert.rejects(google.metadata('access-token', { fileId: 'https://evil.example/video' }));
  assert.equal(calls.length, 2);
});

test('Google file access errors are safe and do not forward provider messages', async () => {
  for (const [status, expected] of [[401, 409], [403, 404], [404, 404], [500, 503]]) {
    const google = createDriveFilesGoogle(config, async () => Response.json({ error: 'private-provider-secret' }, { status }));
    await assert.rejects(google.metadata('access-token', { fileId: 'video-id' }), (error: DriveError) => error.status === expected && !error.message.includes('private-provider-secret'));
  }
  const invalidJson = createDriveFilesGoogle(config, async () => new Response('invalid-json'));
  await assert.rejects(invalidJson.metadata('access-token', { fileId: 'video-id' }), { status: 502 });
  const networkFailure = createDriveFilesGoogle(config, async () => { throw Error('private-network-error'); });
  await assert.rejects(networkFailure.refresh('private-refresh-token'), { status: 503 });
});

test('revoked refresh permission and invalid token responses require reconnection', async () => {
  const revoked = createDriveFilesGoogle(config, async () => Response.json({ error: 'invalid_grant', private: 'private-provider-secret' }, { status: 400 }));
  await assert.rejects(revoked.refresh('private-refresh-token'), { status: 409, code: 'drive_reconnect_required' });
  for (const tokens of [
    { accessToken: 'token', expiresIn: 3600, scope: 'openid' },
    { accessToken: 'token', expiresIn: 3600, scope: `${driveScope} openid` },
    { accessToken: 'token', expiresIn: -1, scope: driveScope },
    { accessToken: 'token', expiresIn: 86401, scope: driveScope },
    { accessToken: '', expiresIn: 3600, scope: driveScope },
  ]) {
    const fixture = createFileFixture();
    fixture.setTokens(tokens);
    await assert.rejects(fixture.service.pickerSession('alice'), { status: 409, code: 'drive_reconnect_required' });
  }
});
