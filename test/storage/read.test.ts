import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer, get, type ServerResponse, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { initializeApp, applicationDefault, deleteApp } from 'firebase-admin/app';
import { boundedStorageBucket, disposeStorageDeletions } from '../../src/storage/delete.js';
import { readStorageFile, StorageReadWorker, disposeStorageReads, maxConcurrentStorageReads, isTransientStorageReadError } from '../../src/storage/read.js';
import { createHandler, type Dependencies } from '../../src/http/app.js';
import { createVideoRenderer } from '../../src/generation/video.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import type { GenerationStore, GenerationProviders, GenerationClaim } from '../../src/generation/service.js';
import { createAudioExtractor } from '../../src/generation/audio.js';
import type { Project } from '../../src/projects/service.js';
import { createOutputStorage } from '../../src/generation/assets.js';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fixture(context: TestContext, mode: string, handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer((request, response) => { request.on('error', () => undefined); handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const entry = new URL('./read-fixture.ts', import.meta.url).href;
  let active = 0, total = 0;
  context.mock.method(StorageReadWorker.prototype as unknown as { createWorker(): Worker }, 'createWorker', () => {
    const worker = new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`, { eval: true, execArgv: [], workerData: { mode, origin } });
    active++; total++;
    worker.once('exit', () => { active--; });
    return worker;
  });
  const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, `storage-read-${crypto.randomUUID()}`);
  const bucket = boundedStorageBucket(app, 'demo-riflo.appspot.com');
  return { app, bucket, active: () => active, total: () => total, async close() { await disposeStorageDeletions(); await deleteApp(app); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const mode of ['oauth', 'metadata']) test(`${mode} read cancellation closes held native authentication and prevents late object requests`, { timeout: 6000 }, async context => {
  let started!: () => void, closed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gone = new Promise<void>(resolve => { closed = resolve; });
  let auth: ServerResponse | undefined, objects = 0;
  const f = await fixture(context, mode, (request, response) => {
    request.resume();
    if (request.url === '/token' || request.url?.includes('/service-accounts/default/token')) { auth = response; response.once('close', closed); started(); }
    else { objects++; response.end('must-not-download'); }
  });
  try {
    const output = readStorageFile(f.bucket, 'source.mp4'); output.on('error', () => undefined); output.resume();
    await waiting;
    const done = once(output, 'close'); output.destroy(); await done; await gone;
    assert.equal(f.active(), 0, 'close waits for authentication worker termination');
    assert.equal(objects, 0);
    auth!.end(JSON.stringify({ access_token: 'late-token', expires_in: 3600, token_type: 'Bearer' }));
    await delay(50); assert.equal(objects, 0);
  } finally { await f.close(); }
});

test('real SDK cancellation before delayed headers closes the socket and survives late response wiring', { timeout: 6000 }, async context => {
  let started!: () => void, closed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gone = new Promise<void>(resolve => { closed = resolve; });
  let held: ServerResponse | undefined;
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); held = response; response.once('close', closed); started(); });
  try {
    const output = readStorageFile(f.bucket, 'source.mp4'); output.resume(); await waiting;
    const done = once(output, 'close'); output.destroy(); await done; await gone;
    assert.equal(f.active(), 0);
    // The old in-process early destroy raised ERR_STREAM_UNABLE_TO_PIPE on this late response.
    held!.writeHead(200); held!.end('late-content'); await delay(30);
    assert.equal(output.destroyed, true);
  } finally { await f.close(); }
});

test('real SDK bytes and natural EOF release the read worker', { timeout: 6000 }, async context => {
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); response.end('saved-content'); });
  try {
    const output = readStorageFile(f.bucket, 'source.mp4'); const closed = once(output, 'close');
    const chunks: Buffer[] = []; for await (const chunk of output) chunks.push(chunk);
    await closed; assert.equal(Buffer.concat(chunks).toString(), 'saved-content'); assert.equal(f.active(), 0);
  } finally { await f.close(); }
});

test('active response cancellation preserves backpressure and closes the owned socket', { timeout: 6000 }, async context => {
  let started!: () => void, closed!: () => void, sent = 0;
  const waiting = new Promise<void>(resolve => { started = resolve; }); const gone = new Promise<void>(resolve => { closed = resolve; });
  const f = await fixture(context, 'valid', (request, response) => {
    request.resume(); response.writeHead(200); response.flushHeaders(); started();
    const write = () => { while (sent < 64 * 1024 * 1024) { sent += 65536; if (!response.write(Buffer.alloc(65536))) { response.once('drain', write); return; } } response.end(); };
    response.once('close', closed); write();
  });
  try {
    const output = readStorageFile(f.bucket, 'source.mp4'); output.on('error', () => undefined); await waiting;
    await delay(70); const stopped = sent; await delay(50);
    assert.equal(sent, stopped, 'an unread consumer must stop the real socket producer');
    assert.ok(sent < 16 * 1024 * 1024, `buffered ${sent} bytes`);
    const done = once(output, 'close'); output.destroy(); await done; await gone; assert.equal(f.active(), 0);
  } finally { await f.close(); }
});

test('SDK failures are safe and actual bytes enforce the read ceiling', { timeout: 6000 }, async context => {
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); if (request.url?.includes('missing')) { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 404, message: 'private-provider-sentinel' } })); } else response.end('oversized'); });
  try {
    for (const [path, maxBytes] of [['missing', 100], ['large', 3]] as const) {
      const output = readStorageFile(f.bucket, path, { maxBytes });
      await assert.rejects(async () => { for await (const _chunk of output) { /* Real SDK consumption. */ } }, (error: any) => error.code === (path === 'missing' ? 404 : 'storage_read_too_large') && !String(error).includes('private-provider-sentinel'));
      if (!output.closed) await once(output, 'close'); assert.equal(f.active(), 0);
    }
  } finally { await f.close(); }
});

test('pre-aborted reads create no worker and deadline/abort destroy held reads', { timeout: 8000 }, async context => {
  let started!: () => void, closed!: () => void;
  let waiting = new Promise<void>(resolve => { started = resolve; }); let gone = new Promise<void>(resolve => { closed = resolve; });
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); response.once('close', closed); started(); });
  try {
    const before = new AbortController(); before.abort(); assert.throws(() => readStorageFile(f.bucket, 'early', { signal: before.signal }), { name: 'AbortError' }); assert.equal(f.total(), 0);
    for (const kind of ['abort', 'deadline']) {
      const controller = new AbortController();
      const output = readStorageFile(f.bucket, kind, { signal: controller.signal, milliseconds: kind === 'deadline' ? 900 : 5000 });
      const result = assert.rejects(async () => { for await (const _ of output) {} }, { code: kind === 'deadline' ? 'storage_read_timeout' : 'ABORT_ERR' });
      await waiting; if (kind === 'abort') controller.abort(); await result; if (!output.closed) await once(output, 'close'); await gone; assert.equal(f.active(), 0);
      waiting = new Promise<void>(resolve => { started = resolve; }); gone = new Promise<void>(resolve => { closed = resolve; });
    }
  } finally { await f.close(); }
});

test('cancelled output delivery leaves a live concurrent sibling read intact', { timeout: 6000 }, async context => {
  let held!: ServerResponse, siblingResponse!: ServerResponse, started!: () => void, siblingStarted!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const siblingWaiting = new Promise<void>(resolve => { siblingStarted = resolve; });
  const f = await fixture(context, 'valid', (request, response) => {
    request.resume();
    if (request.url?.includes('held')) { held = response; started(); }
    else { siblingResponse = response; response.write('sibling-'); siblingStarted(); }
  });
  try {
    const storage = createOutputStorage(f.app, f.bucket.name);
    const cancelled = await storage.read('held.mp4'); const first = Readable.fromWeb(cancelled.body as never); first.resume(); await waiting;
    const sibling = await storage.read('sibling.mp4'); const siblingResult = new Response(sibling.body).text(); void siblingResult.catch(() => undefined); await siblingWaiting;
    assert.equal(f.active(), 2, 'both SDK reads must be live together');
    const done = once(first, 'close'); first.destroy(); await done;
    assert.equal(f.active(), 1, 'only the cancelled read worker ended');
    siblingResponse.end('output'); assert.equal(await siblingResult, 'sibling-output');
    held.end('late'); await delay(30); assert.equal(f.active(), 0);
  } finally { await f.close(); }
});

test('unregistered/custom credential buckets fail closed', async () => {
  const app = initializeApp({ projectId: 'demo-riflo', credential: { getAccessToken: async () => ({ access_token: 'custom', expires_in: 3600 }) } }, `custom-read-${crypto.randomUUID()}`);
  try {
    assert.throws(() => boundedStorageBucket(app, 'demo-riflo.appspot.com'), { code: 'unsupported_cleanup_credentials' });
  } finally { await deleteApp(app); }
  const unregistered = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, `unregistered-read-${crypto.randomUUID()}`);
  try {
    const { getStorage } = await import('firebase-admin/storage');
    assert.throws(() => readStorageFile(getStorage(unregistered).bucket('demo-riflo.appspot.com'), 'private'), { code: 'unsupported_cleanup_credentials' });
  } finally { await deleteApp(unregistered); }
});

test('default read-worker bootstrap reads real SDK source and output objects from the owned emulator', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST, timeout: 6000 }, async () => {
  const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, `default-read-${crypto.randomUUID()}`);
  const bucket = boundedStorageBucket(app, 'demo-riflo.appspot.com');
  const path = `accounts/read-${crypto.randomUUID()}/projects/project/source/attempt-1.mp4`;
  try {
    await bucket.file(path).save('emulated-private-source', { resumable: false });
    const source = readStorageFile(bucket, path); const closed = once(source, 'close');
    const bytes: Buffer[] = []; for await (const chunk of source) bytes.push(chunk);
    await closed; assert.equal(Buffer.concat(bytes).toString(), 'emulated-private-source');
    const output = await createOutputStorage(app, bucket.name).read(path);
    assert.equal(await new Response(output.body).text(), 'emulated-private-source');
  } finally { await disposeStorageDeletions(); await bucket.file(path).delete({ ignoreNotFound: true }); await deleteApp(app); }
});


test('actual asset HTTP client disconnect terminates a held SDK read before headers', { timeout: 6000 }, async context => {
  let started!: () => void, socketClosed!: () => void, streamClosed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gone = new Promise<void>(resolve => { socketClosed = resolve; });
  const terminated = new Promise<void>(resolve => { streamClosed = resolve; });
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); response.once('close', socketClosed); started(); });
  const originalRead = StorageReadWorker.prototype.read;
  context.mock.method(StorageReadWorker.prototype, 'read', function (this: StorageReadWorker, ...args: Parameters<typeof originalRead>) {
    const output = originalRead.apply(this, args); output.once('close', streamClosed); return output;
  });
  const storage = createOutputStorage(f.app, f.bucket.name);
  const app = createServer(createHandler({ verifyToken: async () => ({ uid: 'alice' }), loadGrant: async () => null,
    generation: { asset: async () => ({ id: 'asset', storagePath: 'held.mp4', contentType: 'video/mp4' }) } as unknown as Dependencies['generation'],
    readOutputAsset: path => storage.read(path),
  }));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const client = get(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/projects/project/outputs/output/assets/asset/download`, { headers: { Authorization: 'Bearer fixture' } });
    client.on('error', () => undefined);
    await waiting; client.destroy(); await terminated; await gone; assert.equal(f.active(), 0);
  } finally { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); await f.close(); }
});


test('immediate cancellation during worker bootstrap completes without a late SDK request', { timeout: 6000 }, async context => {
  let requests = 0;
  const f = await fixture(context, 'valid', (request, response) => { requests++; request.resume(); response.end('unexpected'); });
  try {
    const output = readStorageFile(f.bucket, 'startup'); const closed = once(output, 'close'); output.destroy(); await closed;
    assert.equal(f.active(), 0); await delay(40); assert.equal(requests, 0);
  } finally { await f.close(); }
});


test('source audio pipeline abort closes held SDK authentication before returning its safe error', { timeout: 6000 }, async context => {
  let started!: () => void, closed!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gone = new Promise<void>(resolve => { closed = resolve; });
  let objects = 0;
  const f = await fixture(context, 'oauth', (request, response) => {
    request.resume(); if (request.url === '/token') { response.once('close', closed); started(); }
    else { objects++; response.end('unexpected'); }
  });
  try {
    const controller = new AbortController();
    const extract = createAudioExtractor({ ffmpegPath: '/must-not-run', readSource: path => readStorageFile(f.bucket, path) });
    const pending = extract({ id: 'source', storagePath: 'private-source.mp4' } as Project, controller.signal);
    const rejected = assert.rejects(pending, { code: 'generation_interrupted', retryable: true });
    await waiting; controller.abort(); await rejected; await gone;
    assert.equal(f.active(), 0); assert.equal(objects, 0);
  } finally { await f.close(); }
});


test('read concurrency is finite, rejects without starting a worker, and releases a cancelled slot', { timeout: 10000 }, async context => {
  let count = 0, allStarted!: () => void;
  const waiting = new Promise<void>(resolve => { allStarted = resolve; });
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); count++; if (count === maxConcurrentStorageReads) allStarted(); });
  const streams: Readable[] = [];
  try {
    for (let index = 0; index < maxConcurrentStorageReads; index++) { const stream = readStorageFile(f.bucket, `held-${index}`); stream.on('error', () => undefined); stream.resume(); streams.push(stream); }
    await waiting;
    assert.equal(f.active(), maxConcurrentStorageReads);
    assert.throws(() => readStorageFile(f.bucket, 'excess'), { code: 'storage_read_busy' }); assert.equal(f.total(), maxConcurrentStorageReads);
    const storage = createOutputStorage(f.app, f.bucket.name);
    const api = createServer(createHandler({ verifyToken: async () => ({ uid: 'alice' }), loadGrant: async () => null,
      generation: { asset: async () => ({ id: 'asset', storagePath: 'excess.mp4', contentType: 'video/mp4' }) } as unknown as Dependencies['generation'], readOutputAsset: path => storage.read(path) }));
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}/v1/projects/project/outputs/output/assets/asset/download`, { headers: { Authorization: 'Bearer fixture' } });
      assert.equal(response.status, 503); assert.equal((await response.json() as any).error.code, 'service_unavailable'); assert.equal(f.total(), maxConcurrentStorageReads);
    } finally { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
    const closed = once(streams[0]!, 'close'); streams[0]!.destroy(); await closed;
    const replacement = readStorageFile(f.bucket, 'replacement'); replacement.on('error', () => undefined); streams.push(replacement);
    assert.equal(f.total(), maxConcurrentStorageReads + 1);
    await disposeStorageReads(); assert.equal(f.active(), 0); assert.ok(streams.every(stream => stream.closed));
  } finally { await f.close(); }
});

test('global disposal closes an unconsumed EOF stream and cancels its deadline timer', { timeout: 6000 }, async context => {
  let ended!: () => void;
  const responseEnded = new Promise<void>(resolve => { ended = resolve; });
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); response.end('unconsumed-eof', ended); });
  const realCreate = (StorageReadWorker.prototype as unknown as { createWorker(): Worker }).createWorker;
  let completed!: () => void;
  const workerCompleted = new Promise<void>(resolve => { completed = resolve; });
  context.mock.method(StorageReadWorker.prototype as unknown as { createWorker(): Worker }, 'createWorker', function (this: StorageReadWorker) {
    const worker = realCreate.call(this); worker.on('message', (message: { ok?: boolean }) => { if (message.ok) completed(); }); return worker;
  });
  try {
    const output = readStorageFile(f.bucket, 'small', { milliseconds: 700 }); output.on('error', () => undefined);
    await responseEnded; await workerCompleted;
    assert.equal(output.readableEnded, false, 'the caller has not consumed the buffered EOF');
    await disposeStorageReads(); assert.equal(output.closed, true); assert.equal(f.active(), 0);
    await delay(750); assert.equal(output.errored, null, 'disposed EOF must not later report its deadline');
  } finally { await f.close(); }
});


test('read capacity and deadline are retryable source-processing failures for audio and video', async () => {
  for (const code of ['storage_read_busy', 'storage_read_timeout']) {
  const busy = () => { throw Object.assign(new Error(code), { code }); };
  const signal = new AbortController().signal;
  const project = { uid: 'alice', id: 'source', storagePath: 'source.mp4', source: { durationSeconds: 12 } } as Project;
  await assert.rejects(createAudioExtractor({ ffmpegPath: '/not-reached', readSource: busy })(project, signal), { code: 'audio_extraction_failed', retryable: true });
  const render = createVideoRenderer({ ffmpegPath: '/not-reached', ffprobePath: '/not-reached', readSource: busy, storage: { uploadFile: async () => undefined, remove: async () => undefined } });
  await assert.rejects(render({ status: 'ok', segments: [{ startSeconds: 1, endSeconds: 11 }] }, { project, slot: { id: 'slot' }, attempt: 1 } as GenerationClaim,
    { text: 'Source speech.', words: [{ text: 'Source', start: 1, end: 2 }, { text: 'speech.', start: 10, end: 11 }] }, signal), { code: 'video_render_failed', retryable: true });
  }
});


test('actual SDK temporary service and socket failures remain retryable through both source consumers', { timeout: 12000 }, async context => {
  const f = await fixture(context, 'valid', (request, response) => {
    request.resume();
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path.includes('reset')) { request.socket.destroy(); return; }
    const status = Number(path.match(/status-(\d+)/)?.[1] ?? 200);
    if (status !== 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: status, message: 'private-sdk-error-sentinel' } })); }
    else response.end('oversized-payload');
  });
  const project = { uid: 'alice', id: 'source', storagePath: 'fixture', source: { durationSeconds: 12 } } as Project;
  const claim = { project, slot: { id: 'slot' }, attempt: 1 } as GenerationClaim;
  const transcript = { text: 'Source speech.', words: [{ text: 'Source', start: 1, end: 2 }, { text: 'speech.', start: 10, end: 11 }] };
  try {
    for (const [path, retryable, rawCode] of [
      ['status-429', true, 429], ['status-500', true, 500], ['status-503', true, 503], ['reset', true, 'ECONNRESET'],
      ['status-401', false, 401], ['status-403', false, 403], ['status-404', false, 404], ['large', false, 'storage_read_too_large'],
    ] as const) {
      const readSource = () => readStorageFile(f.bucket, path, path === 'large' ? { maxBytes: 3 } : undefined);
      const raw = readSource();
      await assert.rejects(async () => { for await (const _ of raw) {} }, (error: any) => error.code === rawCode && !error.message.includes('private-sdk-error-sentinel'));
      const audio = createAudioExtractor({ ffmpegPath: '/must-not-run', readSource });
      const video = createVideoRenderer({ ffmpegPath: '/must-not-run', ffprobePath: '/must-not-run', readSource, storage: { uploadFile: async () => { throw Error('must not upload'); }, remove: async () => undefined } });
      await assert.rejects(audio(project, new AbortController().signal), { code: 'audio_extraction_failed', retryable });
      await assert.rejects(video({ status: 'ok', segments: [{ startSeconds: 1, endSeconds: 11 }] }, claim, transcript, new AbortController().signal), { code: 'video_render_failed', retryable });
      assert.equal(f.active(), 0, `all SDK workers closed for ${path}`);
    }
    for (const [path, retryable] of [['status-503', true], ['reset', true], ['status-404', false]] as const) {
      const audio = createAudioExtractor({ ffmpegPath: '/must-not-run', readSource: () => readStorageFile(f.bucket, path) });
      const deadline = Date.now() + 60_000;
      const workClaim = { project: { ...project, sourceExpiresAt: deadline }, batch: { deadline }, stage: 'transcribe', slot: null } as GenerationClaim;
      let recorded: Parameters<GenerationStore['fail']>[1] | undefined;
      let providerRequests = 0;
      const store = { claim: async () => workClaim, renew: async () => true, markProviderInvoked: async () => { providerRequests++; return true; }, fail: async (_claim: GenerationClaim, error: Parameters<GenerationStore['fail']>[1]) => { recorded = error; return true; } } as unknown as GenerationStore;
      const providers: GenerationProviders = { transcribe: async (source, signal) => { await audio(source, signal); throw Error('unexpected success'); }, generate: async () => { throw Error('must not generate'); } };
      assert.equal(await createGenerationWorker({ store, providers }).runOnce(), true);
      assert.equal(recorded!.code, 'audio_extraction_failed'); assert.equal(recorded!.retryable, retryable); assert.equal(providerRequests, 0);
    }
    if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH) {
      const readSource = () => readStorageFile(f.bucket, 'invalid-media');
      await assert.rejects(createAudioExtractor({ ffmpegPath: process.env.FFMPEG_PATH, readSource })(project, new AbortController().signal), { code: 'audio_extraction_failed', retryable: false });
      const render = createVideoRenderer({ ffmpegPath: process.env.FFMPEG_PATH, ffprobePath: process.env.FFPROBE_PATH, readSource, storage: { uploadFile: async () => { throw Error('must not upload'); }, remove: async () => undefined } });
      await assert.rejects(render({ status: 'ok', segments: [{ startSeconds: 1, endSeconds: 11 }] }, claim, transcript, new AbortController().signal), { code: 'video_render_failed', retryable: false });
    }
    for (const code of [429, '429', 503, '503', 'ECONNRESET', 'ABORT_ERR']) assert.equal(isTransientStorageReadError({ code }), true);
    for (const code of [401, '403', 404, 'storage_read_too_large', 'ENOTFOUND', 'unknown', null, true, 500.5]) assert.equal(isTransientStorageReadError({ code }), false);
  } finally { await f.close(); }
});


test('independently aborted or timed-out SDK reads remain retryable in both caller signal contexts', { timeout: 6000 }, async context => {
  let started!: () => void;
  let waiting = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(context, 'valid', (request, response) => { request.resume(); started(); });
  const project = { uid: 'alice', id: 'source', storagePath: 'held.mp4', source: { durationSeconds: 12 } } as Project;
  const transcript = { text: 'Source speech.', words: [{ text: 'Source', start: 1, end: 2 }, { text: 'speech.', start: 10, end: 11 }] };
  try {
    for (const kind of ['abort', 'deadline']) for (const caller of ['audio', 'video']) {
      const readAbort = new AbortController(), outer = new AbortController();
      const readSource = () => readStorageFile(f.bucket, 'held', { signal: readAbort.signal, milliseconds: kind === 'deadline' ? 500 : 3000 });
      const pending = caller === 'audio'
        ? createAudioExtractor({ ffmpegPath: '/must-not-run', readSource })(project, outer.signal)
        : createVideoRenderer({ ffmpegPath: '/must-not-run', ffprobePath: '/must-not-run', readSource, storage: { uploadFile: async () => undefined, remove: async () => undefined } })({ status: 'ok', segments: [{ startSeconds: 1, endSeconds: 11 }] }, { project, slot: { id: 'slot' }, attempt: 1 } as GenerationClaim, transcript, outer.signal);
      const rejected = assert.rejects(pending, { code: caller === 'audio' ? 'audio_extraction_failed' : 'video_render_failed', retryable: true });
      await waiting; if (kind === 'abort') readAbort.abort(); await rejected;
      assert.equal(outer.signal.aborted, false); assert.equal(f.active(), 0);
      waiting = new Promise<void>(resolve => { started = resolve; });
    }
  } finally { await f.close(); }
});
