import { parentPort, workerData } from 'node:worker_threads';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { safeWorkerCode } from '../worker-health.js';

export function serveStorageRead(bucket: ReturnType<ReturnType<typeof getStorage>['bucket']>) {
  const port = parentPort;
  if (!port) throw new Error('Storage reads require a worker.');
  port.once('message', async ({ path, sink, maxBytes }: { path: string; sink: WritableStream<Uint8Array>; maxBytes: number }) => {
    const writer = sink.getWriter();
    let bytes = 0;
    try {
      for await (const chunk of bucket.file(path).createReadStream()) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw Object.assign(new Error('storage_read_too_large'), { code: 'storage_read_too_large' });
        await writer.write(chunk);
      }
      await writer.close();
      port.postMessage({ ok: true });
    } catch (error) {
      const code = safeWorkerCode(error);
      // Never transfer SDK/provider error text through the stream or control channel.
      await writer.abort(Object.assign(new Error(code), { code })).catch(() => undefined);
      port.postMessage({ ok: false, code, numericCode: typeof (error as { code?: unknown })?.code === 'number' });
    } finally { writer.releaseLock(); }
  });
}

if (workerData?.rifloStorageRead === true && workerData.projectId && workerData.bucketName) {
  const app = initializeApp({ projectId: workerData.projectId, credential: applicationDefault() });
  const bucket = getStorage(app).bucket(workerData.bucketName);
  bucket.storage.retryOptions.autoRetry = false;
  serveStorageRead(bucket);
}
