import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AuthenticationError, createHandler, type Dependencies } from '../../src/http/app.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { SourceError } from '../../src/sources/source.js';

const now = new Date('2026-10-18T12:00:00Z');
const grant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, 1800])) };
const metadata = { source: 'youtube' as const, videoId: 'abcdefghijk', name: 'Video', mimeType: 'video/mp4', bytes: null, durationSeconds: null, requiresProbe: true };

async function withApi(overrides: Partial<Dependencies>, run: (request: (options?: { token?: string | null; body?: unknown; method?: string; contentType?: string }) => Promise<Response>) => Promise<void>) {
  const server = createServer(createHandler({
    verifyToken: async (token) => { if (token === 'bad') throw new AuthenticationError(); return { uid: token }; },
    loadGrant: async () => grant, now: () => now, sourceValidation: async () => metadata, ...overrides,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(async (options = {}) => {
      const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/json' };
      if (options.token !== null) headers.authorization = `Bearer ${options.token ?? 'alice'}`;
      const method = options.method ?? 'POST';
      const body = Object.hasOwn(options, 'body') ? options.body : { url: 'https://youtu.be/abcdefghijk' };
      return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sources/youtube/validate`, { method, headers, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('YouTube validation requires verified paid access before source inspection', async () => {
  let calls = 0;
  const sourceValidation: NonNullable<Dependencies['sourceValidation']> = async () => { calls++; return metadata; };
  await withApi({ sourceValidation }, async (request) => {
    for (const token of [null, 'bad']) assert.equal((await request({ token })).status, 401);
    assert.equal((await request({ method: 'GET' })).status, 405);
  });
  await withApi({ sourceValidation, loadGrant: async () => null }, async (request) => {
    assert.equal((await request({ body: '{malformed' })).status, 403);
  });
  assert.equal(calls, 0);
});

test('YouTube validation passes only canonical input and the verified owner and returns uncached metadata', async () => {
  const calls: unknown[] = [];
  await withApi({ sourceValidation: async (uid, input) => { calls.push({ uid, input }); return metadata; } }, async (request) => {
    const response = await request({ token: 'bob', body: { url: 'https://www.youtube.com/watch?v=abcdefghijk&si=shared' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: { input: { source: 'youtube', videoId: 'abcdefghijk' }, source: metadata } });
  });
  assert.deepEqual(calls, [{ uid: 'bob', input: { source: 'youtube', videoId: 'abcdefghijk' } }]);
});

test('YouTube validation rejects malformed bodies and unsafe links before invoking the adapter', async () => {
  let calls = 0;
  await withApi({ sourceValidation: async () => { calls++; return metadata; } }, async (request) => {
    for (const body of ['{', [], null, {}, { url: 123 }, { url: 'https://youtu.be/abcdefghijk', uid: 'bob' }, { url: 'https://127.0.0.1/video' }, { url: 'https://youtube.com/watch?v=abcdefghijk&list=playlist' }]) {
      assert.equal((await request({ body })).status, 400);
    }
    assert.equal((await request({ body: { url: 'https://youtu.be/abcdefghijk' }, contentType: 'text/plain' })).status, 415);
    assert.equal((await request({ body: 'x'.repeat(4097) })).status, 413);
  });
  assert.equal(calls, 0);
});

test('unconfigured YouTube and provider failures return safe structured errors', async () => {
  await withApi({ sourceValidation: undefined }, async (request) => { assert.equal((await request()).status, 503); });
  await withApi({ sourceValidation: async () => { throw new SourceError(422, 'youtube_verification_required', 'YouTube requires verification.'); } }, async (request) => {
    const response = await request();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'youtube_verification_required');
  });
  await withApi({ sourceValidation: async () => { throw Error('private-subprocess-details'); } }, async (request) => {
    const response = await request();
    assert.equal(response.status, 503);
    assert.ok(!JSON.stringify(await response.json()).includes('private-subprocess-details'));
  });
});
