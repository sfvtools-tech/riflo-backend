import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AuthenticationError, createHandler, type Dependencies } from '../../src/http/app.js';
import { firestoreOperations, type Notice, type Operation, type OperationObserver } from '../../src/http/operations.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createProjectService, OperationSupersededError, ProjectError, type Project, type ProjectStore } from '../../src/projects/service.js';
import { createGenerationService, type GenerationBatch, type GenerationStore } from '../../src/generation/service.js';
import { createProjectStore } from '../../src/projects/firestore.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const grant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 1800])) };
const eventPath = (operation: Operation) => `/v1/projects/${operation.projectId}/operations/${operation.kind}/${operation.id}/events`;

function fixture() {
  const projects = new Map<string, Project>();
  const requests = new Map<string, Project>();
  const batches = new Map<string, GenerationBatch>();
  const generationRequests = new Map<string, GenerationBatch>();
  const listeners = new Set<{ operation: Operation; changed: (notice: Notice) => void; failed: (error: unknown) => void }>();
  let creates = 0, retries = 0, starts = 0, validations = 0, detached = 0;
  let active = true, configured = true;
  const unused = async (): Promise<never> => { throw Error('Unexpected worker call.'); };
  const own = (uid: string, id: string) => projects.get(id)?.uid === uid;
  const store: ProjectStore = {
    lookup: async (uid, key, input) => {
      const saved = requests.get(`${uid}/${key}`) ?? null;
      if (saved && JSON.stringify(saved.input) !== JSON.stringify(input)) throw new ProjectError(409, 'idempotency_conflict', 'Different input.');
      return saved;
    },
    create: async input => {
      creates++;
      const project: Project = { id: input.id, uid: input.uid, input: input.input, source: input.source, importOperationId: `import-${creates}`, status: 'queued', createdAt: now, updatedAt: now, deadline: now + 1000, sourceExpiresAt: null, storagePath: 'private-storage', attempts: 0, errorCode: null, period: 'private-period', reservedSourceSeconds: 60 };
      projects.set(project.id, project); requests.set(`${input.uid}/${input.key}`, project); return project;
    },
    lookupRetry: async (uid, id, key) => {
      const saved = requests.get(`${uid}/retry/${key}`) ?? null;
      if (saved && saved.id !== id) throw new ProjectError(409, 'idempotency_conflict', 'Different project.');
      return saved;
    },
    retry: async input => {
      retries++;
      const project = projects.get(input.id)!;
      project.status = 'queued'; project.importOperationId = `retry-${retries}`; project.errorCode = null;
      requests.set(`${input.uid}/retry/${input.key}`, { ...project }); return project;
    },
    get: async (uid, id) => own(uid, id) ? projects.get(id)! : null,
    list: async uid => [...projects.values()].filter(project => project.uid === uid),
    usage: async () => ({ limits: { sourceSeconds: 1800 }, reserved: { sourceSeconds: 60 }, consumed: { sourceSeconds: 0 }, remaining: { sourceSeconds: 1740 } }),
    remove: unused, claim: unused, renew: unused, complete: unused, fail: unused, expiredSources: unused, finishCleanup: unused,
  };
  const generationStore: GenerationStore = {
    lookup: async (uid, id, key, selection) => {
      const saved = generationRequests.get(`${uid}/${id}/${key}`) ?? null;
      if (saved && JSON.stringify(saved.selection) !== JSON.stringify(selection)) throw new ProjectError(409, 'idempotency_conflict', 'Different selection.');
      return saved;
    },
    start: async (uid, projectId, key, selection) => {
      if (!own(uid, projectId)) throw new ProjectError(404, 'project_not_found', 'Project not found.');
      starts++;
      const batch: GenerationBatch = { id: `batch-${starts}`, uid, projectId, status: 'queued', selection, slots: [{ id: 'output-1', feature: 'x_posts', ordinal: 1, status: 'pending', attempts: 0, errorCode: null }], createdAt: now, updatedAt: now, deadline: now + 1000, period: 'private-period', transcriptionAttempts: 0, transcriptReady: false, errorCode: null };
      batches.set(projectId, batch); generationRequests.set(`${uid}/${projectId}/${key}`, batch); return batch;
    },
    batch: async (uid, id) => own(uid, id) ? batches.get(id) ?? null : null,
    outputs: async (uid, id) => own(uid, id) && batches.get(id)?.slots[0]?.status === 'ready' ? [{ id: 'output-1', feature: 'x_posts', text: 'Saved output survives sibling failure.', createdAt: now, expiresAt: now + 1000, model: 'test', promptVersion: 'test' }] : [],
    output: unused, asset: unused, claim: unused, renew: unused, transcript: unused, saveTranscript: unused, saveOutput: unused, fail: unused, cleanup: unused, markProviderInvoked: unused,
  };
  const operations: OperationObserver = {
    check: async (uid, operation) => {
      if (!own(uid, operation.projectId)) throw new ProjectError(404, 'project_not_found', 'Project not found.');
      const known = operation.kind === 'import'
        ? [...requests.values()].some(project => project.id === operation.projectId && project.importOperationId === operation.id)
        : [...generationRequests.values()].some(batch => batch.projectId === operation.projectId && batch.id === operation.id);
      if (!known) throw new ProjectError(404, 'operation_not_found', 'Operation not found.');
    },
    subscribe: (_uid, operation, changed, failed) => {
      const listener = { operation, changed, failed }; listeners.add(listener);
      return () => { if (listeners.delete(listener)) detached++; };
    },
  };
  const dependencies: Dependencies = {
    verifyToken: async token => { if (token === 'bad') throw new AuthenticationError('private-auth-secret'); return { uid: token }; },
    loadGrant: async () => active ? grant : undefined, now: () => new Date(now), operations,
    projects: createProjectService({ store, now: () => now, validateSource: async () => { validations++; if (!configured) throw Error('private-provider-secret'); return { fileId: 'video-id', name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true }; } }),
    generation: createGenerationService({ store: generationStore, now: () => now }),
    streamMaxMilliseconds: 5000,
  };
  return { dependencies, operations, projects, batches, listeners, counts: () => ({ creates, retries, starts, validations, detached }), revoke: () => { active = false; configured = false; dependencies.generationConfigured = false; dependencies.intakeConfigured = false; },
    emit: (notice: Notice) => { for (const listener of [...listeners]) listener.changed(notice); },
    fail: () => { for (const listener of [...listeners]) listener.failed(Error('private-database-secret')); },
  };
}

async function withApi(run: (api: { request: (path: string, init?: RequestInit) => Promise<Response>; fixture: ReturnType<typeof fixture> }) => Promise<void>, configure?: (value: ReturnType<typeof fixture>) => void) {
  const value = fixture(); configure?.(value);
  const server = createServer(createHandler(value.dependencies));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({ fixture: value, request: (path, init = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(3000), headers: { authorization: 'Bearer alice', ...init.headers } }) });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const post = (key = 'stable-request-key', body = '{"fileId":"video-id"}', stream = true): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(stream ? { accept: 'text/event-stream' } : {}) }, body });

function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    async next(): Promise<{ event: string; data: any } | null> {
      for (;;) {
        const boundary = pending.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (frame.startsWith(':')) continue;
          assert.match(frame, /^event: [a-z_]+\ndata: [^\n]+$/);
          const [event, data] = frame.split('\n');
          return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) };
        }
        const result = await reader.read();
        if (result.done) { assert.equal(pending, ''); return null; }
        pending += decoder.decode(result.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'stream listener was not cleaned up'); await delay(5); }
}

test('observer capacity rejects before database checks and releases on terminal, failure, and disconnect', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const project = (await (await request('/v1/projects', post('capacity-project-key', undefined, false))).json()).data;
    const path = eventPath({ projectId: project.id, kind: 'import', id: project.importOperationId });
    let checks = 0;
    f.operations.check = async () => { checks++; };
    for (const ending of ['terminal', 'failure', 'disconnect']) {
      const stream = frames(await request(path)); await stream.next();
      const before = checks;
      const own = await request(path);
      assert.equal(own.status, 429); assert.equal(own.headers.get('retry-after'), '5');
      assert.equal((await own.json()).error.code, 'observation_busy');
      assert.equal((await request(path, { headers: { authorization: 'Bearer bob' } })).status, 503);
      assert.equal(checks, before);
      if (ending === 'terminal') f.emit({ status: 'source_ready', terminal: true, outcome: 'succeeded' });
      else if (ending === 'failure') f.fail();
      else await stream.cancel();
      if (ending !== 'disconnect') { await stream.next(); assert.equal(await stream.next(), null); }
      await until(() => f.listeners.size === 0);
    }
    f.operations.check = async () => { throw new ProjectError(404, 'operation_not_found', 'Missing'); };
    assert.equal((await request(path)).status, 404);
    f.operations.check = async () => {};
    const final = frames(await request(path)); await final.next(); await final.cancel();
  }, f => { f.dependencies.streamMaxActive = 1; f.dependencies.streamMaxPerAccount = 1; });
});

test('HTTP disconnect cancels metadata validation before project acceptance and a later request can proceed', async () => {
  await withApi(async ({ request, fixture: f }) => {
    let began!: () => void, cancelled!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    f.dependencies.sourceValidation = async (_uid, _input, _limits, signal) => {
      assert.ok(signal);
      began();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true }));
    };
    const controller = new AbortController();
    const pending = request('/v1/sources/youtube/validate', { ...post('validation-key', '{"url":"https://youtu.be/abcdefghijk"}', false), signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started; controller.abort(); await rejected; await aborted;
    assert.equal(f.counts().creates, 0);
    f.dependencies.sourceValidation = async () => ({ source: 'youtube', videoId: 'abcdefghijk', name: 'Video', mimeType: 'video/mp4', bytes: null, durationSeconds: 60, requiresProbe: true });
    assert.equal((await request('/v1/sources/youtube/validate', post('validation-key', '{"url":"https://youtu.be/abcdefghijk"}', false))).status, 200);
  });
});

test('every streaming command reserves before new work while accepted replays acknowledge without another observer', async () => {
  for (const kind of ['create', 'retry-import', 'restore-source', 'generate', 'retry-transcription']) {
    await withApi(async ({ request, fixture: f }) => {
      const base = kind === 'create' ? undefined : (await (await request('/v1/projects', post('setup-project-key', undefined, false))).json()).data;
      if (kind === 'retry-import' || kind === 'restore-source') {
        const project = f.projects.get(base.id)!;
        project.status = kind === 'retry-import' ? 'failed' : 'source_expired';
        project.retryAvailableAt = now;
      }
      const path = kind === 'create' ? '/v1/projects' : `/v1/projects/${base.id}/${kind}`;
      const body = kind === 'create' ? '{"fileId":"video-id"}' : '{}';
      const command = post('capacity-original-key', body);
      const active = frames(await request(path, command));
      const accepted = await active.next();
      assert.equal(accepted?.event, 'accepted', kind);
      const counts = f.counts();
      const refused = await request(path, post('capacity-different-key', body));
      assert.equal(refused.status, 429, kind);
      assert.equal((await refused.json()).error.code, 'observation_busy');
      assert.deepEqual(f.counts(), counts, `${kind} rejected before work`);
      f.revoke();
      for (let replay = 0; replay < 2; replay++) {
        const stream = frames(await request(path, command));
        assert.deepEqual(await stream.next(), accepted);
        assert.deepEqual(await stream.next(), { event: 'stream_error', data: { version: 1, operation: accepted!.data.operation, code: 'observation_busy' } });
        assert.equal(await stream.next(), null);
        assert.equal(f.listeners.size, 1);
        assert.deepEqual(f.counts(), counts);
      }
      await active.cancel(); await until(() => f.listeners.size === 0);
      const recovered = frames(await request(path, command));
      assert.deepEqual(await recovered.next(), accepted);
      assert.equal(f.listeners.size, 1);
      await recovered.cancel();
    }, f => { f.dependencies.streamMaxActive = 1; f.dependencies.streamMaxPerAccount = 1; });
  }
});

test('a command rejected after stream reservation releases capacity', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const grant = f.dependencies.loadGrant;
    f.dependencies.loadGrant = async () => undefined;
    assert.equal((await request('/v1/projects', post())).status, 403);
    f.dependencies.loadGrant = grant;
    const stream = frames(await request('/v1/projects', post()));
    assert.equal((await stream.next())?.event, 'accepted');
    await stream.cancel();
  }, f => { f.dependencies.streamMaxActive = 1; f.dependencies.streamMaxPerAccount = 1; });
});

test('POST streams acknowledge durable queued imports, preserve exact replay after revoked access, and keep JSON reads canonical', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const response = await request('/v1/projects', post());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^text\/event-stream; charset=utf-8$/);
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const stream = frames(response), accepted = await stream.next();
    assert.equal(accepted?.event, 'accepted');
    const operation = accepted!.data.operation as Operation;
    assert.deepEqual(accepted!.data, { version: 1, operation, refresh: true });
    assert.equal(f.projects.get(operation.projectId)?.status, 'queued');
    assert.equal(f.counts().creates, 1);
    const saved = await request(`/v1/projects/${operation.projectId}`);
    assert.match(saved.headers.get('content-type')!, /^application\/json/);
    const state = (await saved.json()).data;
    assert.equal(state.status, 'queued'); assert.equal(state.importOperationId, operation.id);
    assert.ok(!JSON.stringify(state).includes('private-'));
    await stream.cancel(); await until(() => f.listeners.size === 0);
    f.revoke();
    const replay = frames(await request('/v1/projects', post()));
    assert.deepEqual((await replay.next())?.data.operation, operation);
    assert.equal(f.counts().creates, 1); assert.equal(f.counts().validations, 1);
    await replay.cancel(); await until(() => f.listeners.size === 0);
    const conflict = await request('/v1/projects', post('stable-request-key', '{"fileId":"another-video"}'));
    assert.equal(conflict.status, 409); assert.match(conflict.headers.get('content-type')!, /^application\/json/);
    assert.equal((await request('/v1/projects', post('new-request-key'))).status, 503);
    const recovered = frames(await request(eventPath(operation)));
    assert.equal((await recovered.next())?.event, 'changed');
    await recovered.cancel();
    assert.equal(f.projects.get(operation.projectId)?.status, 'queued');
  });
});

test('stream admission errors stay safe JSON and every attachment authenticates ownership and operation identity', async () => {
  await withApi(async ({ request, fixture: f }) => {
    for (const token of ['', 'Bearer bad']) {
      const response = await request('/v1/projects', { ...post(), headers: { ...post().headers, authorization: token } });
      assert.equal(response.status, 401); assert.match(response.headers.get('content-type')!, /^application\/json/);
      assert.ok(!(await response.text()).includes('private-auth-secret'));
    }
    for (const options of [post('short'), post('valid-request-key', '{'), post('valid-request-key', '{"fileId":"video-id","uid":"bob"}')]) {
      assert.equal((await request('/v1/projects', options)).status, 400);
    }
    assert.equal(f.counts().creates, 0);
    const stream = frames(await request('/v1/projects', post()));
    const operation = (await stream.next())!.data.operation as Operation;
    await stream.cancel(); await until(() => f.listeners.size === 0);
    for (const [path, authorization, status] of [[eventPath(operation), 'Bearer bob', 404], [eventPath(operation), 'Bearer bad', 401], [eventPath({ ...operation, id: 'unknown' }), 'Bearer alice', 404]] as const) {
      const response = await request(path, { headers: { authorization } });
      assert.equal(response.status, status); assert.match(response.headers.get('content-type')!, /^application\/json/);
      assert.ok(!(await response.text()).includes('private-'));
    }
    f.operations.check = async () => { throw Error('private-database-secret'); };
    const unavailable = await request(eventPath(operation));
    assert.equal(unavailable.status, 503); assert.ok(!(await unavailable.text()).includes('private-database-secret'));
    assert.equal(f.listeners.size, 0);
  });
});

test('manual retry and generation POSTs stream the exact operation; partial results remain available after terminal closure', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const original = (await (await request('/v1/projects', post('original-request-key', undefined, false))).json()).data;
    const project = f.projects.get(original.id)!;
    project.status = 'failed'; project.retryAvailableAt = now;
    const retry = frames(await request(`/v1/projects/${project.id}/retry-import`, { method: 'POST', headers: { accept: 'text/event-stream', 'idempotency-key': 'manual-retry-key' } }));
    const retried = await retry.next(); assert.equal(retried?.event, 'accepted');
    assert.notEqual(retried!.data.operation.id, original.importOperationId);
    await retry.cancel(); await until(() => f.listeners.size === 0);
    project.status = 'source_ready';
    const generationPost = post('generation-request-key', '{"outputs":{"x_posts":1,"linkedin_posts":1}}');
    const stream = frames(await request(`/v1/projects/${project.id}/generate`, generationPost));
    const accepted = await stream.next(), operation = accepted!.data.operation as Operation;
    assert.equal(accepted?.event, 'accepted'); assert.equal(operation.kind, 'generation');
    f.emit({ status: 'generating', terminal: false, ready: 0, failed: 0 });
    f.emit({ status: 'generating', terminal: false, ready: 0, failed: 0 });
    assert.equal((await stream.next())?.event, 'changed');
    const batch = f.batches.get(project.id)!;
    batch.status = 'partial'; batch.slots[0]!.status = 'ready';
    batch.slots.push({ id: 'output-2', feature: 'linkedin_posts', ordinal: 1, status: 'failed', attempts: 1, errorCode: 'generation_failed' });
    f.emit({ status: 'partial', terminal: true, outcome: 'partial', ready: 1, failed: 1 });
    const terminal = await stream.next();
    assert.equal(terminal?.event, 'terminal'); assert.equal(terminal!.data.outcome, 'partial');
    assert.equal(await stream.next(), null); assert.equal(f.listeners.size, 0);
    assert.equal((await (await request(`/v1/projects/${project.id}/generation`)).json()).data.status, 'partial');
    assert.equal((await (await request(`/v1/projects/${project.id}/outputs`)).json()).data[0].text, 'Saved output survives sibling failure.');
    f.revoke();
    const replay = frames(await request(`/v1/projects/${project.id}/generate`, generationPost));
    assert.deepEqual((await replay.next())?.data.operation, operation); await replay.cancel();
    assert.equal(f.counts().starts, 1); assert.equal(f.counts().retries, 1);
  });
});

test('completion before attachment and supersession end observation without inventing a job failure', async () => {
  for (const outcome of ['succeeded', 'failed', 'superseded'] as const) {
    await withApi(async ({ request, fixture: f }) => {
      const project = (await (await request('/v1/projects', post('original-request-key', undefined, false))).json()).data;
      const saved = f.projects.get(project.id)!;
      saved.status = outcome === 'failed' ? 'failed' : 'source_ready';
      f.operations.subscribe = (_uid, _operation, changed) => {
        changed({ status: outcome === 'superseded' ? 'superseded' : saved.status, terminal: true, outcome });
        return () => { detached++; };
      };
      let detached = 0;
      const stream = frames(await request(eventPath({ projectId: project.id, kind: 'import', id: project.importOperationId })));
      const initial = await stream.next();
      assert.equal(initial?.event, 'changed'); assert.equal(initial!.data.refresh, true);
      const terminal = await stream.next();
      assert.equal(terminal?.event, 'terminal'); assert.equal(terminal!.data.outcome, outcome);
      assert.equal(await stream.next(), null); assert.equal(detached, 1);
      assert.equal(f.projects.get(project.id)?.status, outcome === 'failed' ? 'failed' : 'source_ready');
    });
  }
});

test('listener failures after headers send a safe observation error, detach, and leave durable work queued', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const stream = frames(await request('/v1/projects', post()));
    const operation = (await stream.next())!.data.operation as Operation;
    f.fail();
    assert.deepEqual(await stream.next(), { event: 'stream_error', data: { version: 1, operation, code: 'observation_unavailable' } });
    assert.equal(await stream.next(), null); assert.equal(f.listeners.size, 0); assert.equal(f.counts().detached, 1);
    assert.equal(f.projects.get(operation.projectId)?.status, 'queued');
  });
});

test('synchronous listener setup failure stays a safe stream error after headers', async () => {
  await withApi(async ({ request, fixture: f }) => {
    f.operations.subscribe = () => { throw Error('private-subscribe-secret'); };
    const response = await request('/v1/projects', post());
    assert.equal(response.status, 200);
    const stream = frames(response);
    const initial = await stream.next();
    assert.equal(initial?.event, 'stream_error');
    assert.equal(initial!.data.code, 'observation_unavailable');
    assert.ok(!JSON.stringify(initial).includes('private-subscribe-secret'));
    assert.equal(await stream.next(), null);
    assert.equal([...f.projects.values()][0]!.status, 'queued');
    assert.equal(f.listeners.size, 0);
  });
});

test('a slow HTTP consumer has a bounded notification buffer and releases observation without cancelling work', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const response = await request('/v1/projects', post());
    const stream = frames(response);
    const operation = (await stream.next())!.data.operation as Operation;
    let published = 0;
    // Hold the HTTP reader while publishing more than the socket can buffer.
    while (f.listeners.size && published < 20_000) {
      f.emit({ status: 'generating', terminal: false, ready: ++published, failed: 0 });
    }
    assert.ok(published < 20_000, 'slow consumer retained an unbounded observer');
    assert.equal(f.listeners.size, 0); assert.equal(f.counts().detached, 1);
    let received = 0;
    while (await stream.next()) received++;
    assert.ok(received < 2000, 'slow client accumulated too many notifications');
    assert.equal(f.projects.get(operation.projectId)?.status, 'queued');
    assert.equal(f.counts().creates, 1);
  });
});

test('configured connection lifetime, token expiry, revocation and shutdown close observation and release listeners', async () => {
  for (const reason of ['lifetime', 'expiry', 'revoked', 'transient', 'shutdown'] as const) {
    const shutdown = new AbortController(); let revoked = false;
    await withApi(async ({ request, fixture: f }) => {
      const stream = frames(await request('/v1/projects', post()));
      const operation = (await stream.next())!.data.operation as Operation;
      if (reason === 'revoked' || reason === 'transient') revoked = true;
      if (reason === 'shutdown') shutdown.abort();
      const error = await stream.next();
      assert.equal(error?.event, 'stream_error');
      assert.equal(error!.data.code, reason === 'revoked' ? 'authentication_required' : reason === 'transient' ? 'observation_unavailable' : reason === 'shutdown' ? 'server_shutdown' : 'stream_expired');
      assert.ok(!JSON.stringify(error).includes('private-'));
      assert.equal(await stream.next(), null); assert.equal(f.listeners.size, 0);
      assert.equal(f.projects.get(operation.projectId)?.status, 'queued');
    }, f => {
      f.dependencies.shutdown = shutdown.signal;
      f.dependencies.streamMaxMilliseconds = reason === 'lifetime' ? 40 : 2000;
      f.dependencies.streamHeartbeatMilliseconds = 10;
      f.dependencies.verifyToken = async token => {
        if (revoked) throw reason === 'transient' ? Error('private-provider-unavailable') : new AuthenticationError('private-revocation-secret');
        return { uid: token, ...(reason === 'expiry' ? { exp: (Date.now() + 80) / 1000 } : {}) };
      };
    });
  }
});

test('superseded accepted requests resolve their original identity through safe JSON without admitting new work', async () => {
  await withApi(async ({ request, fixture: f }) => {
    const current = (await (await request('/v1/projects', post('initial-operation-key', undefined, false))).json()).data;
    const project = f.projects.get(current.id)!;
    const originalOperation = { projectId: project.id, kind: 'import', id: project.importOperationId };
    project.importOperationId = 'newer-operation'; project.status = 'source_ready';
    f.dependencies.projects!.create = async () => { throw new OperationSupersededError(project.id, originalOperation.id!); };
    for (const stream of [false, true]) {
      const replay = await request('/v1/projects', post('initial-operation-key', undefined, stream));
      assert.equal(replay.status, 409);
      assert.match(replay.headers.get('content-type')!, /^application\/json/);
      const body = await replay.json();
      assert.deepEqual(body.error.operation, originalOperation);
      assert.equal(body.error.accepted, true);
      assert.equal(body.error.code, 'operation_superseded');
      assert.equal(f.counts().creates, 1); assert.equal(f.listeners.size, 0);
      const saved = (await (await request(`/v1/projects/${project.id}`)).json()).data;
      assert.equal(saved.importOperationId, 'newer-operation'); assert.equal(saved.status, 'source_ready');
    }
  });
});

test('real Firestore snapshots drive HTTP notifications after commit and recover already completed imports', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const uid = `stream-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const operation: Operation = { projectId: randomUUID(), kind: 'import', id: randomUUID() };
  const ref = db.collection('accounts').doc(uid).collection('projects').doc(operation.projectId);
  const server = createServer(createHandler({
    verifyToken: async token => ({ uid: token }), loadGrant: async () => undefined,
    operations: firestoreOperations(db), streamMaxMilliseconds: 5000,
    projects: createProjectService({ store: createProjectStore(db), validateSource: async () => { throw Error('Read-only observation cannot import.'); } }),
  }));
  try {
    await ref.set({ id: operation.projectId, uid, importOperationId: operation.id, status: 'queued', source: { fileId: 'video-id', name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true }, input: { fileId: 'video-id' }, createdAt: now, updatedAt: now, deadline: now + 1000, sourceExpiresAt: null, storagePath: null, attempts: 0, errorCode: null, period: 'private-period', reservedSourceSeconds: 60 });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (path: string, token = uid) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    assert.equal((await request(eventPath(operation), 'another-owner')).status, 404);
    const stream = frames(await request(eventPath(operation)));
    assert.equal((await stream.next())?.data.refresh, true);
    const queued = await stream.next(); assert.equal(queued?.event, 'changed'); assert.equal(queued!.data.status, 'queued');
    assert.equal(queued!.data.importAttempt, 0); assert.equal(queued!.data.importUpdatedAt, now);
    const progress = { attempt: 1, stage: 'download', transferredBytes: 4, totalBytes: 9 };
    await ref.update({ status: 'importing', attempts: 1, updatedAt: now + 1, importProgress: progress });
    const importing = (await stream.next())!.data;
    assert.deepEqual(importing.importProgress, progress);
    assert.equal(importing.importAttempt, 1); assert.equal(importing.importUpdatedAt, now + 1);
    progress.transferredBytes = 8;
    await ref.update({ importProgress: progress });
    assert.deepEqual((await stream.next())!.data.importProgress, progress, 'same-status byte updates must survive SSE deduplication');
    assert.deepEqual((await (await request(`/v1/projects/${operation.projectId}`)).json()).data.importProgress, progress);
    await ref.update({ status: 'source_ready', updatedAt: now + 1 });
    const terminal = await stream.next();
    assert.equal(terminal?.event, 'terminal'); assert.equal(terminal!.data.outcome, 'succeeded');
    assert.equal((await (await request(`/v1/projects/${operation.projectId}`)).json()).data.status, 'source_ready');
    assert.equal(await stream.next(), null);
    const reconnect = frames(await request(eventPath(operation)));
    assert.equal((await reconnect.next())?.data.refresh, true);
    assert.equal((await reconnect.next())?.event, 'terminal');
    assert.equal(await reconnect.next(), null);
    assert.equal((await db.collection('intakeJobs').where('uid', '==', uid).get()).empty, true);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await db.recursiveDelete(db.collection('accounts').doc(uid));
    await db.terminate(); await deleteApp(app);
  }
});
