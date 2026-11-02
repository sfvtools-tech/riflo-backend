import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AuthenticationError, createHandler } from '../../src/http/app.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createProjectService, ProjectError, type Project, type ProjectStore } from '../../src/projects/service.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const grant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, 1800])) };

function createApiFixture() {
  const projects = new Map<string, Project>();
  const keys = new Map<string, string>();
  let validateCalls = 0;
  let sourceUnavailable = false;
  const unused = async (): Promise<never> => { throw Error('Unexpected worker operation.'); };
  const store: ProjectStore = {
    lookup: async (uid, key, input) => {
      const project = projects.get(keys.get(`${uid}/${key}`) ?? '') ?? null;
      if (project && JSON.stringify(project.input) !== JSON.stringify(input)) throw new ProjectError(409, 'idempotency_conflict', 'This request key belongs to a different video.');
      return project;
    },
    create: async (input) => {
      const project: Project = {
        id: input.id, uid: input.uid, status: 'queued', input: input.input, source: input.source,
        createdAt: input.now, updatedAt: input.now, deadline: input.now + 86_400_000,
        sourceExpiresAt: null, storagePath: 'private-storage-path', attempts: 0, errorCode: null,
        period: 'internal-period', reservedSourceSeconds: 60,
      };
      projects.set(project.id, project);
      keys.set(`${input.uid}/${input.key}`, project.id);
      return project;
    },
    get: async (uid, id) => projects.get(id)?.uid === uid ? projects.get(id)! : null,
    list: async (uid) => [...projects.values()].filter((project) => project.uid === uid),
    usage: async () => ({ limits: { sourceSeconds: 1800 }, reserved: { sourceSeconds: 60 }, consumed: { sourceSeconds: 0 }, remaining: { sourceSeconds: 1740 } }),
    remove: async (uid, id) => {
      const project = projects.get(id);
      if (!project || project.uid !== uid) throw new ProjectError(404, 'project_not_found', 'Project not found.');
      project.status = 'deleted';
      return project.storagePath;
    },
    lookupRetry: async (uid, id, key) => {
      const saved = keys.get(`${uid}/retry/${key}`);
      if (!saved) return null;
      if (saved !== id) throw new ProjectError(409, 'idempotency_conflict', 'Different project.');
      return projects.get(id)!;
    },
    retry: async (input) => {
      const project = projects.get(input.id)!;
      if (project.status !== 'failed') throw new ProjectError(409, 'import_not_failed', 'Already changed.');
      project.status = 'queued'; project.source = input.source; project.errorCode = null;
      keys.set(`${input.uid}/retry/${input.key}`, input.id);
      return project;
    },
    claim: unused, renew: unused, complete: unused, fail: unused, expiredSources: unused, finishCleanup: unused,
  };
  const service = createProjectService({ store, now: () => now, validateSource: async (uid, input) => {
    validateCalls++;
    assert.equal(uid, 'alice');
    if (sourceUnavailable) throw Error('Drive access revoked.');
    if ('source' in input) return { source: 'youtube', videoId: input.videoId, name: 'YouTube video', mimeType: 'video/mp4', bytes: null, durationSeconds: null, requiresProbe: true };
    return { fileId: input.fileId, name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true };
  } });
  return { service, projects, store, validationCount: () => validateCalls, revokeSource: () => { sourceUnavailable = true; } };
}

async function withApi(run: (request: (path: string, options?: { token?: string; method?: string; key?: string; body?: string }) => Promise<{ status: number; body: any; cache: string | null; retryAfter: string | null }>, fixture: ReturnType<typeof createApiFixture>) => Promise<void>, activeGrant: unknown = grant) {
  const fixture = createApiFixture();
  const server = createServer(createHandler({
    verifyToken: async (token) => {
      if (token === 'bad') throw new AuthenticationError();
      return { uid: token };
    },
    loadGrant: async () => typeof activeGrant === 'function' ? activeGrant() : activeGrant, now: () => new Date(now), projects: fixture.service,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(async (path, options = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (options.key) headers['idempotency-key'] = options.key;
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: options.body }) });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control'), retryAfter: response.headers.get('retry-after') };
    }, fixture);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('project reads retain the external source link after the private copy expires', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { method: 'POST', token: 'alice', key: 'source-link-key', body: JSON.stringify({ fileId: 'video-id', resourceKey: 'source-resource-key' }) });
    assert.equal(created.status, 202);
    const expected = 'https://drive.google.com/file/d/video-id/view?resourcekey=source-resource-key';
    assert.equal(created.body.data.sourceUrl, expected);
    assert.match(created.body.data.id, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'source_expired';
    project.storagePath = null;
    const expired = await request(`/v1/projects/${project.id}`, { token: 'alice' });
    assert.equal(expired.status, 200);
    assert.equal(expired.body.data.sourceUrl, expected);
    assert.equal(expired.body.data.storagePath, undefined);
    assert.equal(expired.body.data.input, undefined);
    assert.equal((await request(`/v1/projects/${project.id}`, { token: 'bob' })).status, 404);
  });
});

for (const access of ['active', 'inactive', 'denied'] as const) {
  for (const status of ['failed', 'source_expired'] as const) {
    test(`project detail preserves source restore eligibility for ${status} imports with ${access} access`, async () => {
      const fixture = createApiFixture();
      const created = await fixture.service.create('alice', { fileId: 'video-id' }, 'restore-eligibility-key');
      const project = fixture.projects.get(created.id)!;
      project.status = status;
      project.storagePath = null;
      project.retryAvailableAt = now;
      if (status === 'source_expired') {
        project.importedAt = now - 86_400_000;
        project.sourceExpiresAt = now - 1;
      }
      const usage = await fixture.store.usage('alice', now);
      fixture.store.usage = async () => {
        if (access === 'denied') throw new ProjectError(403, 'subscription_required', 'Subscription required.');
        return { ...usage, access: { active: access === 'active', reason: access === 'active' ? 'active' : 'subscription_required', expiresAt: null } };
      };
      const result = await fixture.service.get('alice', project.id);
      assert.deepEqual(result.sourceRestore, {
        available: status === 'source_expired' && access === 'active',
        reason: status === 'failed' ? 'source_restore_not_available' : access === 'active' ? 'revalidation_required' : 'subscription_required',
        availableAt: null,
      });
      assert.equal(result.importRetry.available, status === 'failed' && access === 'active');
      if (access !== 'active') assert.equal(result.importRetry.reason, 'subscription_required');
    });
  }
}

test('project creation requires sign-in, paid access, valid JSON and a request key', async () => {
  await withApi(async (request, fixture) => {
    for (const token of [undefined, 'bad']) {
      assert.equal((await request('/v1/projects', { method: 'POST', token })).status, 401);
    }
    for (const key of [undefined, 'short', 'bad key value']) {
      assert.equal((await request('/v1/projects', { method: 'POST', token: 'alice', key, body: '{"fileId":"video-id"}' })).status, 400);
    }
    for (const body of ['{', '{"fileId":"video-id","uid":"bob"}', '{"fileId":"https://evil.example/video"}']) {
      assert.equal((await request('/v1/projects', { method: 'POST', token: 'alice', key: 'valid-request-key', body })).status, 400);
    }
    assert.equal(fixture.validationCount(), 0);
  });
  await withApi(async (request, fixture) => {
    assert.equal((await request('/v1/projects', { method: 'POST', token: 'alice', key: 'valid-request-key', body: '{"fileId":"video-id"}' })).status, 403);
    assert.equal(fixture.validationCount(), 0);
  }, null);
});

test('project responses expose progress only to their owner and replay without Drive access', async () => {
  await withApi(async (request, fixture) => {
    const options = { method: 'POST', token: 'alice', key: 'valid-request-key', body: '{"fileId":"video-id","resourceKey":"private-resource-key"}' };
    const created = await request('/v1/projects', options);
    assert.equal(created.status, 202);
    assert.equal(created.cache, 'no-store');
    assert.equal(created.body.data.status, 'queued');
    const id = created.body.data.id;
    fixture.revokeSource();
    assert.deepEqual((await request('/v1/projects', options)).body, created.body);
    assert.equal(fixture.validationCount(), 1);
    const project = fixture.projects.get(id)!;
    project.status = 'source_ready';
    project.attempts = 2;
    project.source.requiresProbe = false;
    const ready = (await request(`/v1/projects/${id}`, { token: 'alice' })).body.data;
    assert.equal(ready.status, 'source_ready');
    assert.equal(ready.attempts, undefined);
    assert.equal(project.attempts, 2);
    assert.equal((await request(`/v1/projects/${id}`, { token: 'bob' })).status, 404);
    assert.equal((await request(`/v1/projects/${id}`, { method: 'DELETE', token: 'bob' })).status, 404);
    assert.deepEqual((await request('/v1/projects', { token: 'bob' })).body.data, []);
    const owned = await request('/v1/projects', { token: 'alice' });
    assert.equal(owned.body.data.length, 1);
    const text = JSON.stringify(owned.body);
    assert.equal(owned.body.data[0].sourceUrl, 'https://drive.google.com/file/d/video-id/view?resourcekey=private-resource-key');
    for (const secret of ['private-storage-path', 'internal-period', 'alice']) assert.ok(!text.includes(secret));
    assert.equal(owned.body.data[0].input, undefined);
    const usage = await request('/v1/usage', { token: 'alice' });
    assert.equal(usage.cache, 'no-store');
    assert.equal(usage.body.data.consumed.sourceSeconds, 0);
    assert.equal((await request(`/v1/projects/${id}`, { method: 'DELETE', token: 'alice' })).status, 200);
    assert.equal((await request(`/v1/projects/${id}`, { token: 'alice' })).body.data.status, 'deleted');
  });
});

test('canonical YouTube projects use the same private queue and replay without revalidating their source', async () => {
  await withApi(async (request, fixture) => {
    const options = { method: 'POST', token: 'alice', key: 'youtube-request-key', body: '{"source":"youtube","videoId":"abcdefghijk"}' };
    const created = await request('/v1/projects', options);
    assert.equal(created.status, 202);
    assert.equal(created.body.data.source.source, 'youtube');
    assert.equal(created.body.data.source.bytes, null);
    const id = created.body.data.id;
    fixture.revokeSource();
    assert.deepEqual((await request('/v1/projects', options)).body, created.body);
    assert.equal(fixture.validationCount(), 1);
    assert.equal((await request('/v1/projects', { ...options, body: '{"source":"youtube","videoId":"lmnopqrstuv"}' })).status, 409);
    assert.equal((await request(`/v1/projects/${id}`, { token: 'bob' })).status, 404);
    assert.deepEqual((await request('/v1/projects', { token: 'bob' })).body.data, []);
  });
});

for (const initial of [{ source: 'youtube', url: 'https://youtu.be/abcdefghijk?si=shared' }, { source: 'youtube', videoId: 'abcdefghijk' }]) {
  test(`YouTube ${'url' in initial ? 'URL' : 'legacy ID'} admission replays equivalent source forms after access is revoked`, async () => {
    let active = true;
    await withApi(async (request, fixture) => {
      const options = { method: 'POST', token: 'alice', key: 'direct-youtube-key', body: JSON.stringify(initial) };
      const created = await request('/v1/projects', options);
      assert.equal(created.status, 202);
      assert.equal(created.body.data.status, 'queued');
      assert.deepEqual(fixture.projects.get(created.body.data.id)!.input, { source: 'youtube', videoId: 'abcdefghijk' });
      fixture.revokeSource();
      active = false;
      for (const input of [initial, { source: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk&t=30' }, { source: 'youtube', videoId: 'abcdefghijk' }]) {
        const replay = await request('/v1/projects', { ...options, body: JSON.stringify(input) });
        assert.equal(replay.status, 202);
        assert.deepEqual(replay.body, created.body);
      }
      assert.equal((await request('/v1/projects', { ...options, body: JSON.stringify({ source: 'youtube', url: 'https://youtu.be/lmnopqrstuv' }) })).status, 409);
      assert.equal(fixture.validationCount(), 1);
      assert.equal(fixture.projects.size, 1);
    }, () => active ? grant : null);
  });
}

test('invalid direct YouTube imports fail before source validation or queue admission', async () => {
  await withApi(async (request, fixture) => {
    for (const input of [
      { source: 'youtube', url: 'http://127.0.0.1/video' },
      { source: 'youtube', url: 'https://youtu.be/abcdefghijk', videoId: 'abcdefghijk' },
      { source: 'youtube', url: 'https://youtube.com/watch?v=abcdefghijk&list=playlist' },
      { source: 'youtube', url: null },
    ]) {
      assert.equal((await request('/v1/projects', { method: 'POST', token: 'alice', key: 'invalid-youtube-key', body: JSON.stringify(input) })).status, 400);
    }
    assert.equal(fixture.validationCount(), 0);
    assert.equal(fixture.projects.size, 0);
  });
});

test('direct URL normalization precedes service hooks and preserves trial activation order', async () => {
  const fixture = createApiFixture();
  const canonical = { source: 'youtube' as const, videoId: 'abcdefghijk' };
  const calls: string[] = [];
  const lookup = fixture.store.lookup;
  fixture.store.lookup = async (uid, key, input) => { calls.push('lookup'); assert.deepEqual(input, canonical); return lookup(uid, key, input); };
  fixture.store.preflight = async () => { calls.push('preflight'); };
  const service = createProjectService({ store: fixture.store, now: () => now,
    beforeValidateSource: async (_uid, input) => { calls.push('budget'); assert.deepEqual(input, canonical); },
    startTrial: async (_uid, _now, input) => { calls.push('trial'); assert.deepEqual(input, canonical); },
    validateSource: async (_uid, input) => {
      calls.push('validate'); assert.deepEqual(input, canonical);
      return { ...canonical, name: 'YouTube video', mimeType: 'video/mp4', bytes: null, durationSeconds: 60, requiresProbe: true };
    },
  });
  const authorize = async () => { calls.push('authorize'); };
  const accepted = await service.create('alice', { source: 'youtube', url: 'https://youtu.be/abcdefghijk' }, 'direct-service-key', authorize);
  assert.deepEqual(calls, ['lookup', 'authorize', 'preflight', 'budget', 'trial', 'validate']);
  calls.length = 0;
  assert.deepEqual(await service.create('alice', canonical, 'direct-service-key', authorize), accepted);
  assert.deepEqual(calls, ['lookup']);
});

test('retry import is authenticated, owner-only, failed-only and revalidates the original input once per request key', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'original-source-key', body: '{"source":"youtube","videoId":"abcdefghijk"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    const path = `/v1/projects/${project.id}/retry-import`;
    assert.equal((await request(path, { method: 'POST' })).status, 401);
    assert.equal((await request(path, { token: 'alice' })).status, 405);
    assert.equal((await request(path, { token: 'bob', method: 'POST', key: 'retry-source-key' })).status, 404);
    assert.equal((await request(path, { token: 'alice', method: 'POST', key: 'retry-source-key' })).status, 409);
    project.status = 'failed'; project.retryAvailableAt = now; project.errorCode = 'youtube_video_unavailable';
    const failed = await request(`/v1/projects/${project.id}`, { token: 'alice' });
    assert.deepEqual(failed.body.data.importRetry, { available: false, reason: 'allowance_exceeded', availableAt: new Date(now).toISOString(), allowance: { requiredSeconds: 1800, remainingSeconds: 1740 } });
    assert.equal((await request(path, { token: 'alice', method: 'POST' })).status, 400);
    const retried = await request(path, { token: 'alice', method: 'POST', key: 'retry-source-key' });
    assert.equal(retried.status, 202);
    assert.equal(retried.body.data.id, project.id);
    assert.equal(retried.body.data.status, 'queued');
    assert.equal(retried.body.data.importRetry.available, false);
    assert.equal(fixture.validationCount(), 2);
    assert.equal((await request(path, { token: 'alice', method: 'POST', key: 'retry-source-key' })).status, 202);
    assert.equal(fixture.validationCount(), 2);
    assert.equal(fixture.projects.size, 1);
  });
});

test('retry validation failure leaves the failed project unchanged and inactive subscribers cannot retry', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'original-source-key', body: '{"fileId":"video-id"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'failed'; project.retryAvailableAt = now;
    fixture.revokeSource();
    assert.equal((await request(`/v1/projects/${project.id}/retry-import`, { token: 'alice', method: 'POST', key: 'retry-source-key' })).status, 503);
    assert.equal(project.status, 'failed');
  });
  await withApi(async request => {
    assert.equal((await request('/v1/projects/project-id/retry-import', { token: 'alice', method: 'POST', key: 'retry-source-key' })).status, 403);
  }, null);
});


test('retry cooldown is backend-driven and rejects before contacting the source', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'original-source-key', body: '{"fileId":"video-id"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'failed'; project.retryAvailableAt = now + 60_000;
    const path = `/v1/projects/${project.id}`;
    const current = await request(path, { token: 'alice' });
    assert.deepEqual(current.body.data.importRetry, { available: false, reason: 'retry_cooldown', availableAt: new Date(now + 60_000).toISOString(), allowance: { requiredSeconds: 60, remainingSeconds: 1740 } });
    const retry = await request(`${path}/retry-import`, { token: 'alice', method: 'POST', key: 'retry-source-key' });
    assert.equal(retry.status, 429);
    assert.equal(retry.retryAfter, '60');
    assert.equal(retry.body.error.code, 'retry_cooldown');
    assert.equal(fixture.validationCount(), 1);
  });
});


test('accepted retry HTTP replay survives revoked access while new requests remain blocked', async () => {
  let active = true;
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'original-source-key', body: '{"fileId":"video-id"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'failed'; project.retryAvailableAt = now;
    const path = `/v1/projects/${project.id}/retry-import`;
    const accepted = await request(path, { token: 'alice', method: 'POST', key: 'accepted-retry-key' });
    assert.equal(accepted.status, 202);
    const calls = fixture.validationCount();
    active = false;
    fixture.revokeSource();
    assert.deepEqual((await request(path, { token: 'alice', method: 'POST', key: 'accepted-retry-key' })).body, accepted.body);
    assert.equal((await request(path, { token: 'alice', method: 'POST', key: 'new-retry-key' })).status, 403);
    assert.equal((await request(path, { token: 'bob', method: 'POST', key: 'accepted-retry-key' })).status, 403);
    assert.equal((await request(path, { method: 'POST', key: 'accepted-retry-key' })).status, 401);
    assert.equal(fixture.validationCount(), calls);
    assert.equal(project.status, 'queued');
    assert.equal(fixture.projects.size, 1);
  }, () => active ? grant : null);
});


test('retry allowance rejection returns structured 403 details without cooldown headers', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'quota-original-key', body: '{"fileId":"video-id"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'failed'; project.updatedAt = now - 60_001;
    fixture.store.retry = async () => { throw new ProjectError(403, 'allowance_exceeded', 'Not enough source video allowance remains.', undefined, { requiredSeconds: 1025, remainingSeconds: 775 }); };
    const result = await request(`/v1/projects/${project.id}/retry-import`, { token: 'alice', method: 'POST', key: 'quota-rejected-key' });
    assert.equal(result.status, 403);
    assert.equal(result.retryAfter, null);
    assert.deepEqual(result.body.error, { code: 'allowance_exceeded', message: 'Not enough source video allowance remains.', allowance: { requiredSeconds: 1025, remainingSeconds: 775 } });
    assert.equal(project.status, 'failed');
  });
});


test('accepted import replays after access expires without metadata calls or new projects', async () => {
  let active = true;
  await withApi(async (request, fixture) => {
    let creates = 0;
    const create = fixture.store.create;
    fixture.store.create = async input => { creates++; return create(input); };
    const options = { method: 'POST', token: 'alice', key: 'accepted-import-key', body: '{"fileId":"video-id"}' };
    const accepted = await request('/v1/projects', options);
    assert.equal(accepted.status, 202);
    active = false;
    fixture.revokeSource();
    const replay = await request('/v1/projects', options);
    assert.equal(replay.status, 202);
    assert.deepEqual(replay.body, accepted.body);
    assert.equal((await request('/v1/projects', { ...options, body: '{"fileId":"different-id"}' })).status, 409);
    for (const changed of [{ key: 'brand-new-import-key' }, { token: 'bob' }]) {
      const denied = await request('/v1/projects', { ...options, ...changed });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.code, 'subscription_required');
    }
    assert.equal((await request('/v1/projects', { ...options, token: 'bad' })).status, 401);
    assert.equal(fixture.validationCount(), 1);
    assert.equal(fixture.projects.size, 1);
    assert.equal(creates, 1);
  }, () => active ? grant : undefined);
});

const publicProjectKeys = ['id', 'importOperationId', 'status', 'source', 'sourceUrl', 'createdAt', 'sourceExpiresAt', 'errorCode', 'importRetry', 'sourceRestore'].sort();

function assertPublicContract(value: any, project: Project) {
  assert.deepEqual(Object.keys(value).sort(), publicProjectKeys);
  const youtube = project.source.source === 'youtube';
  assert.deepEqual(Object.keys(value.source).sort(), ['source', youtube ? 'videoId' : 'fileId', 'name', 'bytes', 'durationSeconds'].sort());
  assert.deepEqual(value.source, {
    source: youtube ? 'youtube' : 'drive',
    ...(youtube ? { videoId: (project.source as { videoId: string }).videoId } : { fileId: (project.source as { fileId: string }).fileId }),
    name: project.source.name, bytes: project.source.bytes, durationSeconds: project.source.durationSeconds,
  });
  assert.equal(value.errorCode, project.status === 'failed' ? project.errorCode : null);
  assert.equal(value.importOperationId, project.importOperationId ?? null);
  assert.equal(value.createdAt, new Date(project.createdAt).toISOString());
  assert.equal(value.sourceExpiresAt, project.sourceExpiresAt === null ? null : new Date(project.sourceExpiresAt).toISOString());
}

for (const source of ['drive', 'youtube'] as const) {
  test(`${source} public project contract covers create, retry, replay, detail and list without changing stored data`, async () => {
    await withApi(async (request, fixture) => {
      const options = { token: 'alice', method: 'POST', key: 'public-contract-key', body: JSON.stringify(source === 'drive' ? { fileId: 'video-id' } : { source, videoId: 'abcdefghijk' }) };
      const created = await request('/v1/projects', options);
      assert.equal(created.status, 202);
      const project = fixture.projects.get(created.body.data.id)!;
      assertPublicContract(created.body.data, project);
      project.importOperationId = 'saved-import-operation';
      project.attempts = 7;
      project.errorCode = 'drive_file_unavailable';
      Object.assign(project.source, { canDownload: true, unknownProviderField: 'private-extra', ...(source === 'drive' ? { videoId: 'wrong-source-id' } : { fileId: 'wrong-source-id' }) });
      for (const status of ['queued', 'importing', 'source_ready', 'failed', 'source_expired', 'deleted'] as const) {
        project.status = status;
        project.sourceExpiresAt = status === 'source_expired' ? now - 1 : null;
        const before = structuredClone(project);
        const detail = await request(`/v1/projects/${project.id}`, { token: 'alice' });
        const list = await request('/v1/projects', { token: 'alice' });
        const replay = await request('/v1/projects', options);
        assert.equal(detail.status, 200);
        assert.equal(list.status, 200);
        assert.equal(replay.status, 202);
        for (const value of [detail.body.data, list.body.data[0], replay.body.data]) assertPublicContract(value, project);
        assert.deepEqual(project, before);
        assert.equal(project.errorCode, 'drive_file_unavailable');
      }
      project.status = 'failed';
      project.retryAvailableAt = now;
      const retryOptions = { token: 'alice', method: 'POST', key: 'public-retry-key' };
      const retryPath = `/v1/projects/${project.id}/retry-import`;
      const retried = await request(retryPath, retryOptions);
      assert.equal(retried.status, 202);
      assertPublicContract(retried.body.data, project);
      project.errorCode = 'historical-import-error';
      const before = structuredClone(project);
      const replay = await request(retryPath, retryOptions);
      assert.equal(replay.status, 202);
      assertPublicContract(replay.body.data, project);
      assert.deepEqual(project, before);
    });
  });
}

test('source access retry guidance includes Drive errors and preserves cooldown, allowance and subscription precedence', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'drive-guidance-key', body: '{"fileId":"video-id"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'failed'; project.retryAvailableAt = now;
    const path = `/v1/projects/${project.id}`;
    for (const errorCode of ['drive_file_unavailable', 'drive_reconnect_required', 'youtube_video_restricted', 'youtube_video_unavailable', 'youtube_verification_required', 'file_not_found', 'file_access_denied']) {
      project.errorCode = errorCode;
      const read = await request(path, { token: 'alice' });
      assert.equal(read.body.data.importRetry.reason, 'source_access_required', errorCode);
      assert.equal(read.body.data.importRetry.available, true);
      assert.equal(read.body.data.errorCode, errorCode);
    }
    for (const errorCode of ['drive_file_unavailable', 'drive_reconnect_required']) {
      project.errorCode = errorCode;
      project.retryAvailableAt = now + 60_000;
      project.source.durationSeconds = 1800;
      assert.equal((await request(path, { token: 'alice' })).body.data.importRetry.reason, 'retry_cooldown');
      project.retryAvailableAt = now;
      assert.equal((await request(path, { token: 'alice' })).body.data.importRetry.reason, 'allowance_exceeded');
      const usage = fixture.store.usage;
      fixture.store.usage = async () => { throw new ProjectError(403, 'subscription_required', 'Subscription required.'); };
      const inactive = await request(path, { token: 'alice' });
      assert.equal(inactive.body.data.importRetry.reason, 'subscription_required');
      assert.equal(inactive.body.data.importRetry.available, false);
      fixture.store.usage = usage;
    }
  });
});

test('unknown-duration retry feedback uses current admission caps after an access change', async () => {
  await withApi(async (request, fixture) => {
    const created = await request('/v1/projects', { token: 'alice', method: 'POST', key: 'changed-caps-key', body: '{"source":"youtube","videoId":"abcdefghijk"}' });
    const project = fixture.projects.get(created.body.data.id)!;
    project.status = 'failed'; project.retryAvailableAt = now; project.errorCode = 'source_import_failed'; project.source.durationSeconds = null;
    project.sourceLimits = { maxSourceSeconds: 3600, maxSourceBytes: 6000000000 };
    fixture.store.usage = async () => ({ sourceLimits: { maxSourceSeconds: 1800, maxSourceBytes: 3000000000 }, limits: { sourceSeconds: 2700 }, reserved: { sourceSeconds: 0 }, consumed: { sourceSeconds: 0 }, remaining: { sourceSeconds: 2700 } });
    let result = await request(`/v1/projects/${project.id}`, { token: 'alice' });
    assert.equal(result.body.data.importRetry.available, true);
    assert.deepEqual(result.body.data.importRetry.allowance, { requiredSeconds: 1800, remainingSeconds: 2700 });
    project.sourceLimits = { maxSourceSeconds: 1800, maxSourceBytes: 3000000000 };
    fixture.store.usage = async () => ({ sourceLimits: { maxSourceSeconds: 3600, maxSourceBytes: 6000000000 }, limits: { sourceSeconds: 2700 }, reserved: { sourceSeconds: 0 }, consumed: { sourceSeconds: 0 }, remaining: { sourceSeconds: 2700 } });
    result = await request(`/v1/projects/${project.id}`, { token: 'alice' });
    assert.equal(result.body.data.importRetry.available, false);
    assert.deepEqual(result.body.data.importRetry.allowance, { requiredSeconds: 3600, remainingSeconds: 2700 });
    delete project.sourceLimits;
    assert.equal((await request(`/v1/projects/${project.id}`, { token: 'alice' })).body.data.importRetry.allowance.requiredSeconds, 3600);
    assert.equal('sourceLimits' in (await request('/v1/usage', { token: 'alice' })).body.data, false);
  });
});
