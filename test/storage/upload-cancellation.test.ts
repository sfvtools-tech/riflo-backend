import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, applicationDefault, deleteApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { createSourceStorage } from '../../src/projects/adapters.js';
import { createOutputStorage } from '../../src/generation/assets.js';
import { disposeStorageDeletions, StorageIOWorker, boundedStorageBucket, uploadStorageObject, deleteStorageObject } from '../../src/storage/delete.js';

for (const mode of ['oauth', 'metadata']) for (const kind of ['source', 'output-bytes', 'output-file'] as const) test(`${mode} ${kind} upload abort fences upload after held native OAuth refresh`, { timeout: 5000 }, async context => {
  let tokenResponse: ServerResponse | undefined;
  let tokenClosed!: () => void;
  const authClosed = new Promise<void>(resolve => { tokenClosed = resolve; });
  let tokenStarted!: () => void;
  const tokenPending = new Promise<void>(resolve => { tokenStarted = resolve; });
  const uploads: { bytes: number; ended: boolean; containsPayload: boolean }[] = [];
  const server = createServer((request, response) => {
    request.on('error', () => {});
    if (request.url === '/token' || request.url?.includes('/service-accounts/default/token')) { request.resume(); tokenResponse = response; response.once('close', tokenClosed); tokenStarted(); return; }
    const upload = { bytes: 0, ended: false, containsPayload: false }; uploads.push(upload);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { upload.bytes += chunk.length; chunks.push(chunk); });
    request.on('end', () => { upload.ended = true; upload.containsPayload = Buffer.concat(chunks).includes(Buffer.from('fabricated-')); });
    response.writeHead(412, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 412 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const priorFirebaseHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const priorStorageHost = process.env.STORAGE_EMULATOR_HOST;
  delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  delete process.env.STORAGE_EMULATOR_HOST;
  const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, `upload-cancel-${kind}`);
  const directory = await mkdtemp(join(tmpdir(), 'riflo-upload-cancel-'));
  try {
    const localPath = join(directory, 'video.mp4'); await writeFile(localPath, 'fabricated-local-content');
    const bucket = getStorage(app).bucket('demo-riflo.appspot.com');
    bucket.storage.apiEndpoint = origin;
    const entry = new URL('./upload-fixture.ts', import.meta.url).href;
    context.mock.method(StorageIOWorker.prototype as unknown as { createWorker(): Worker }, 'createWorker', () => new Worker(
      `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`,
      { eval: true, execArgv: [], workerData: { mode, origin } },
    ));
    const abort = new AbortController();
    const sourcePath = 'accounts/alice/projects/project/source/attempt-1.mp4';
    const outputPath = 'accounts/alice/projects/project/outputs/slot/attempt-1/clip.mp4';
    const storage = kind === 'source' ? createSourceStorage(app, bucket.name) : createOutputStorage(app, bucket.name);
    const pending = kind === 'source'
      ? (storage as ReturnType<typeof createSourceStorage>).upload(localPath, sourcePath, abort.signal, 'video/mp4')
      : kind === 'output-file'
        ? (storage as ReturnType<typeof createOutputStorage>).uploadFile(outputPath, localPath, abort.signal)
        : (storage as ReturnType<typeof createOutputStorage>).uploadBytes(outputPath.replace('clip.mp4', 'slide-1.png'), Buffer.from('fabricated-image'), abort.signal);
    await tokenPending;
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await authClosed;
    assert.equal(uploads.length, 0, 'no upload started before token release');
    tokenResponse!.writeHead(200, { 'content-type': 'application/json' });
    tokenResponse!.end(JSON.stringify({ access_token: 'local-access-token', expires_in: 3600, token_type: 'Bearer' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    context.diagnostic(JSON.stringify({ lateRequests: uploads.length, uploads }));
    assert.equal(uploads.length, 0, 'aborted pipeline must prevent SDK from starting an upload after authentication finishes');
  } finally {
    await disposeStorageDeletions(); await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (priorFirebaseHost === undefined) delete process.env.FIREBASE_STORAGE_EMULATOR_HOST; else process.env.FIREBASE_STORAGE_EMULATOR_HOST = priorFirebaseHost;
    if (priorStorageHost === undefined) delete process.env.STORAGE_EMULATOR_HOST; else process.env.STORAGE_EMULATOR_HOST = priorStorageHost;
  }
});


test('source stream stays bounded during held auth and cleanup runs in a separate lane', { timeout: 6000 }, async context => {
  let authStarted!: () => void, authClosed!: () => void;
  const started = new Promise<void>(resolve => { authStarted = resolve; });
  const closed = new Promise<void>(resolve => { authClosed = resolve; });
  let fences = 0;
  const server = createServer((request, response) => {
    if (request.url === '/token') { request.resume(); response.once('close', authClosed); authStarted(); return; }
    request.resume(); fences++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'fence', crc32c: 'AAAAAA==' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const entry = new URL('./upload-fixture.ts', import.meta.url).href;
  let workers = 0;
  context.mock.method(StorageIOWorker.prototype as unknown as { createWorker(): Worker }, 'createWorker', () => new Worker(
    `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`,
    { eval: true, execArgv: [], workerData: { mode: workers++ === 0 ? 'oauth' : 'valid', origin } },
  ));
  const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, 'stream-backpressure');
  let emitted = 0;
  const source = new Readable({ highWaterMark: 65_536, read() {
    if (emitted >= 16 * 1024 * 1024) this.push(null);
    else { emitted += 65_536; this.push(Buffer.alloc(65_536)); }
  } });
  const abort = new AbortController();
  const bucket = boundedStorageBucket(app, 'demo-riflo.appspot.com');
  const upload = uploadStorageObject(bucket, 'accounts/alice/projects/project/source/attempt-1.mp4', source, { contentType: 'video/mp4' }, abort.signal);
  try {
    await started;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(emitted < 1024 * 1024, `backpressure bounded production to ${emitted} bytes`);
    await deleteStorageObject(bucket, 'accounts/alice/projects/project/source/attempt-2.mp4', 3000);
    assert.equal(fences, 1, 'cleanup did not wait for foreground authentication');
    abort.abort(); await assert.rejects(upload, { name: 'AbortError' }); await closed;
    assert.equal(source.destroyed, true);
    context.diagnostic(`source buffered at most ${emitted} bytes before cancellation`);
  } finally {
    abort.abort(); await upload.catch(() => {});
    await disposeStorageDeletions(); await deleteApp(app);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('real SDK upload byte messages do not complete an operation before its server response', { timeout: 8000 }, async context => {
  const { CRC32C } = await import('@google-cloud/storage');
  const payload = Buffer.alloc(512 * 1024, 1);
  let respond!: () => void, received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      respond = () => {
        const crc = new CRC32C(); crc.update(payload);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ name: 'progress', generation: '1', crc32c: crc.toString() }));
      };
      received();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const entry = new URL('./upload-fixture.ts', import.meta.url).href;
  context.mock.method(StorageIOWorker.prototype as unknown as { createWorker(): Worker }, 'createWorker', () => new Worker(
    `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`,
    { eval: true, execArgv: [], workerData: { mode: 'valid', origin } },
  ));
  const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, 'progress-tests');
  const bytes: number[] = [];
  const abort = new AbortController();
  let completed = false;
  const pending = uploadStorageObject(boundedStorageBucket(app, 'demo-riflo.appspot.com'), 'progress', payload, {}, abort.signal, count => bytes.push(count)).then(() => { completed = true; });
  try {
    await arrived;
    assert.equal(bytes.at(-1), payload.length);
    assert.equal(completed, false);
    assert.ok(bytes.length <= 3);
    respond(); await pending;
    assert.equal(completed, true);
  } finally {
    abort.abort(); await pending.catch(() => {});
    await disposeStorageDeletions(); await deleteApp(app);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
