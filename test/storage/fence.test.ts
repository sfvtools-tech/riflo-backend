import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initializeApp, applicationDefault, deleteApp } from 'firebase-admin/app';
import { CRC32C } from '@google-cloud/storage';
import { createOutputStorage } from '../../src/generation/assets.js';
import { boundedStorageBucket, deleteStorageObject, disposeStorageDeletions, StorageIOWorker } from '../../src/storage/delete.js';

const path = 'accounts/alice/projects/project/outputs/slot/attempt-1/slide-1.png';
type Stored = { payload: Buffer; metadata: Record<string, unknown> };

test('real SDK fences both upload orders, late server commits, lost replies, and checksum cleanup', { timeout: 12_000 }, async context => {
  const objects = new Map<string, Stored>();
  const requests: { method: string; condition: string | null; fence: boolean }[] = [];
  let holdPrivate = false, holdFence = false, mismatch = false;
  let privateArrived!: () => void, fenceArrived!: () => void, deleteArrived!: () => void;
  let releasePrivate: (() => void) | undefined, releaseDelete: (() => void) | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const name = url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
    const condition = url.searchParams.get('ifGenerationMatch');
    const reject = (code: number) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code } })); };
    if (request.method === 'DELETE') {
      requests.push({ method: 'DELETE', condition, fence: false });
      releaseDelete = () => { if (condition === '0' && objects.has(name)) reject(412); else { objects.delete(name); response.writeHead(204); response.end(); } };
      deleteArrived(); return;
    }
    const chunks: Buffer[] = [];
    request.on('error', () => {});
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('binary');
      const boundary = String(request.headers['content-type']).split('boundary=')[1];
      const parts = body.split(`--${boundary}`);
      const metadata = JSON.parse(parts[1].slice(parts[1].indexOf('\r\n\r\n') + 4).trim());
      const media = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4);
      const payload = Buffer.from(media.slice(0, -2), 'binary');
      const fence = metadata.metadata?.rifloPayloadDeleted === 'true';
      requests.push({ method: request.method!, condition, fence });
      const commit = () => {
        if (condition === '0' && objects.has(name)) { reject(412); return; }
        objects.set(name, { payload, metadata });
        if (fence && holdFence) { holdFence = false; fenceArrived(); return; }
        const crc = new CRC32C(); crc.update(payload);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ name, generation: '1', crc32c: mismatch && !fence ? 'AAAAAA==' : crc.toString() }));
      };
      if (!fence && holdPrivate) { holdPrivate = false; releasePrivate = commit; privateArrived(); }
      else commit();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const entry = new URL('./upload-fixture.ts', import.meta.url).href;
  let workersCreated = 0;
  context.mock.method(StorageIOWorker.prototype as unknown as { createWorker(): Worker }, 'createWorker', () => { workersCreated++; return new Worker(
    `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`,
    { eval: true, execArgv: [], workerData: { mode: 'valid', origin } },
  ); });
  const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() }, 'fence-tests');
  const storage = createOutputStorage(app, 'gs://demo-riflo.appspot.com/');
  const bareStorage = createOutputStorage(app, 'demo-riflo.appspot.com');
  const bucket = boundedStorageBucket(app, 'demo-riflo.appspot.com');
  try {
    await storage.uploadBytes(path, Buffer.from('private-payload'), new AbortController().signal);
    assert.equal(objects.get(path)!.payload.toString(), 'private-payload');
    await bareStorage.remove(path);
    assert.equal(objects.get(path)!.payload.length, 0);
    assert.deepEqual(objects.get(path)!.metadata, { contentType: 'application/octet-stream', cacheControl: 'private, no-store', metadata: { rifloPayloadDeleted: 'true' } });
    await assert.rejects(storage.uploadBytes(path, Buffer.from('late-private'), new AbortController().signal), { code: 412 });
    assert.equal(objects.get(path)!.payload.length, 0);

    assert.equal(workersCreated, 2, 'bare and gs:// aliases share one foreground lane and one cleanup lane');

    // The server has all private bytes; its commit runs after client abort and fence acknowledgment.
    const latePath = path.replace('attempt-1', 'attempt-2');
    holdPrivate = true;
    const arrived = new Promise<void>(resolve => { privateArrived = resolve; });
    const abort = new AbortController();
    const pending = storage.uploadBytes(latePath, Buffer.from('accepted-private'), abort.signal);
    await arrived; abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await storage.remove(latePath);
    releasePrivate!();
    assert.equal(objects.get(latePath)!.payload.length, 0);

    // A fence is durable even when its acknowledgment is lost; retry only overwrites with empty bytes.
    const lostPath = path.replace('attempt-1', 'attempt-3');
    holdFence = true;
    const fenced = new Promise<void>(resolve => { fenceArrived = resolve; });
    const lost = deleteStorageObject(bucket, lostPath, 100).catch(error => error);
    await fenced; assert.equal(objects.get(lostPath)!.payload.length, 0);
    assert.equal((await lost).code, 'storage_cleanup_timeout');
    await deleteStorageObject(bucket, lostPath, 3000);
    assert.equal(objects.get(lostPath)!.payload.length, 0);

    // Force the SDK's internal checksum-mismatch delete, holding it until a fence exists.
    const checksumPath = path.replace('attempt-1', 'attempt-4');
    mismatch = true;
    const cleanup = new Promise<void>(resolve => { deleteArrived = resolve; });
    const failedUpload = storage.uploadBytes(checksumPath, Buffer.from('mismatch-private'), new AbortController().signal).catch(error => error);
    await cleanup;
    await storage.remove(checksumPath);
    releaseDelete!();
    assert.equal((await failedUpload).code, 'FILE_NO_UPLOAD_DELETE');
    assert.equal(objects.get(checksumPath)!.payload.length, 0);
    assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.condition), ['0']);
    assert.ok(requests.filter(request => request.fence).every(request => request.condition === null));
    assert.ok(requests.filter(request => !request.fence && request.method !== 'DELETE').every(request => request.condition === '0'));
  } finally {
    await disposeStorageDeletions(); await deleteApp(app);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
