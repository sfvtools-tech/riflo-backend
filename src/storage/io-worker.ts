import { parentPort, workerData } from 'node:worker_threads';
import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { safeWorkerCode } from '../worker-health.js';

type Operation = { id: number; op?: string; path: string; body?: unknown; localPath?: string; metadata?: Record<string, unknown> };
export function serveStorageIO(run: (operation: Operation) => Promise<void>) {
  if (!parentPort) throw new Error('Storage I/O requires a worker.');
  const port = parentPort;
  let busy = false;
  port.on('message', async (message: unknown) => {
    const value = message as Operation | null;
    if (!value || !Number.isSafeInteger(value.id) || typeof value.path !== 'string') return;
    if (busy) { port.postMessage({ id: value.id, ok: false, code: 'storage_cleanup_busy' }); return; }
    busy = true;
    try { await run(value); port.postMessage({ id: value.id, ok: true }); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      port.postMessage({ id: value.id, ok: false, code: safeWorkerCode(error), numericCode: typeof code === 'number' && Number.isSafeInteger(code) });
    }
    finally { busy = false; }
  });
}
export function serveStorageDeletion(remove: (path: string) => Promise<void>) {
  serveStorageIO(async operation => remove(operation.path));
}

export function storageOperation(bucket: ReturnType<ReturnType<typeof getStorage>['bucket']>) {
  return async (operation: Operation) => {
    // Keep a live, empty barrier: delayed create-only uploads must never find an absent path.
    if (operation.op === 'fence') {
      await bucket.file(operation.path).save(Buffer.alloc(0), {
        resumable: false, validation: false,
        metadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store', metadata: { rifloPayloadDeleted: 'true' } },
      });
      return;
    }
    if (operation.op !== 'upload') throw Object.assign(new Error('invalid_storage_operation'), { code: 'invalid_storage_operation' });
    const source = operation.localPath ? createReadStream(operation.localPath)
      : operation.body instanceof Uint8Array ? Readable.from([operation.body])
        : Readable.fromWeb(operation.body as import('node:stream/web').ReadableStream);
    let transferredBytes = 0, lastProgress = 0;
    const report = () => { parentPort?.postMessage({ id: operation.id, transferredBytes }); lastProgress = Date.now(); };
    // Counts bytes handed to the SDK, not bytes acknowledged by Cloud Storage.
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      transferredBytes += chunk.length;
      if (Date.now() - lastProgress >= 250) report();
      callback(null, chunk);
    }, flush(callback) { report(); callback(); } });
    await pipeline(source, meter, bucket.file(operation.path, { preconditionOpts: { ifGenerationMatch: 0 } }).createWriteStream({
      resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 }, metadata: operation.metadata,
    }));
  };
}

if (workerData?.rifloStorageIO === true && workerData.projectId && workerData.bucketName) {
  const app = initializeApp({ projectId: workerData.projectId, credential: applicationDefault() });
  const bucket = getStorage(app).bucket(workerData.bucketName);
  bucket.storage.retryOptions.autoRetry = false;
  serveStorageIO(storageOperation(bucket));
}
