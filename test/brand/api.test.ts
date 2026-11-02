import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AuthenticationError, createHandler } from '../../src/http/app.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { brandBodyLimit, brandLimits, createBrandService, type BrandProfile } from '../../src/brand/service.js';

async function withApi(run: (request: (options?: { method?: string; body?: string; token?: string | null; path?: string; contentType?: string }) => Promise<{ status: number; body: any; cache: string | null; allow: string | null }>, profiles: Map<string, BrandProfile>) => Promise<void>, failStorage = false, active = true) {
  const profiles = new Map<string, BrandProfile>();
  const brand = createBrandService({
    read: async (uid) => { if (failStorage) throw Error('private-database-detail'); return profiles.get(uid) ?? null; },
    save: async (uid, profile) => { if (failStorage) throw Error('private-database-detail'); profiles.set(uid, profile); },
  });
  const server = createServer(createHandler({
    brand,
    verifyToken: async (token) => {
      if (token === 'bad') throw new AuthenticationError('private-auth-detail');
      return { uid: token === 'alice-token' ? 'alice' : 'bob' };
    },
    loadGrant: async () => active ? { status: 'active', startsAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 100])) } : null,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(async (options = {}) => {
      const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/json' };
      if (options.token !== null) headers.authorization = `Bearer ${options.token ?? 'alice-token'}`;
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${options.path ?? '/v1/brand'}`, {
        method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: options.body }),
      });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control'), allow: response.headers.get('allow') };
    }, profiles);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('brand API uses verified account, saves optional settings and replaces them with active access', async () => {
  await withApi(async (request, profiles) => {
    const initial = await request();
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { data: null });
    assert.equal(initial.cache, 'no-store');
    const saved = await request({ method: 'PUT', body: JSON.stringify({ name: 'Example', voice: 'Warm' }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { data: { name: 'Example', voice: 'Warm' } });
    assert.deepEqual(profiles.get('alice'), saved.body.data);
    assert.deepEqual((await request({ token: 'bob-token' })).body, { data: null });
    await request({ method: 'PUT', token: 'bob-token', body: '{"name":"Bob"}' });
    const injected = await request({ method: 'PUT', body: '{"uid":"bob","name":"Changed"}' });
    assert.equal(injected.status, 400);
    assert.deepEqual(profiles.get('bob'), { name: 'Bob' });
    const replacement = await request({ method: 'PUT', body: '{"audience":"Educators"}' });
    assert.deepEqual(replacement.body, { data: { audience: 'Educators' } });
    assert.deepEqual((await request()).body, replacement.body);
    assert.deepEqual((await request({ method: 'PUT', body: '{}' })).body, { data: {} });
    assert.deepEqual((await request({ token: 'bob-token' })).body, { data: { name: 'Bob' } });
  });
});

test('brand API rejects unauthenticated requests, invalid JSON/media, methods, query parameters and oversized bodies', async () => {
  await withApi(async (request, profiles) => {
    for (const token of [null, 'bad']) {
      for (const method of ['GET', 'PUT']) {
        const response = await request({ token, method, ...(method === 'PUT' ? { body: '{}' } : {}) });
        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, 'unauthenticated');
        assert.ok(!JSON.stringify(response.body).includes('private-auth-detail'));
      }
    }
    assert.equal((await request({ method: 'PUT', body: '{' })).status, 400);
    assert.equal((await request({ method: 'PUT', body: '{}', contentType: 'text/plain' })).status, 415);
    const method = await request({ method: 'POST', body: '{}' });
    assert.equal(method.status, 405);
    assert.equal(method.allow, 'GET, PUT');
    assert.equal((await request({ path: '/v1/brand?uid=bob' })).status, 400);
    const tooLarge = await request({ method: 'PUT', body: JSON.stringify({ writingExample: 'x'.repeat(brandBodyLimit) }) });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error.code, 'request_too_large');
    assert.equal(profiles.size, 0);
    const unicode = { writingExample: '界'.repeat(8000) };
    assert.equal((await request({ method: 'PUT', body: JSON.stringify(unicode) })).status, 200);
    assert.deepEqual((await request()).body, { data: unicode });
  });
});

test('brand body budget accepts every field at its text limit, including multibyte and escaped JSON', async () => {
  const profile = Object.fromEntries(Object.entries(brandLimits).map(([field, limit]) => [field,
    typeof limit === 'number' ? '界'.repeat(limit)
      : Array.from({ length: limit.count }, () => field === 'colours' ? '#abcdef' : '界'.repeat(limit.length)),
  ]));
  await withApi(async request => {
    const compact = JSON.stringify(profile);
    assert.ok(Buffer.byteLength(compact) > 32_768);
    const escaped = compact.replace(/[\u0080-\uffff]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    for (const body of [compact, escaped]) {
      assert.ok(Buffer.byteLength(body) <= brandBodyLimit);
      const result = await request({ method: 'PUT', body });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data, profile);
    }
  });
});

test('brand API hides storage failures and saved metadata', async () => {
  await withApi(async (request) => {
    for (const method of ['GET', 'PUT']) {
      const response = await request({ method, ...(method === 'PUT' ? { body: '{}' } : {}) });
      assert.equal(response.status, 503);
      assert.ok(!JSON.stringify(response.body).includes('private-database-detail'));
      assert.equal(typeof response.body.error.code, 'string');
    }
  }, true);
  await withApi(async (request, profiles) => {
    profiles.set('alice', { name: 'Example', privateToken: 'never-return' } as BrandProfile);
    assert.deepEqual((await request()).body, { data: { name: 'Example' } });
    profiles.set('alice', { name: 42 } as unknown as BrandProfile);
    const corrupt = await request();
    assert.equal(corrupt.status, 503);
    assert.equal(corrupt.body.error.code, 'brand_unavailable');
  });
});

 test('brand settings remain readable after access ends but updates require active access', async () => {
  await withApi(async (request, profiles) => {
    profiles.set('alice', { voice: 'Direct' });
    assert.deepEqual((await request()).body, { data: { voice: 'Direct' } });
    const denied = await request({ method: 'PUT', body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'subscription_required');
    assert.deepEqual(profiles.get('alice'), { voice: 'Direct' });
  }, false, false);
});
