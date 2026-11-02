import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Worker, Transferable } from 'node:worker_threads';
import { createStorageThread } from './thread.js';
import { disposeStorageReads } from './read.js';
import { applicationDefault, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { storageCleanupLimits } from './cleanup.js';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
const uploadLanes = new WeakMap<Bucket['storage'], Map<string, StorageIOWorker>>();
const deletionLanes = new WeakMap<Bucket['storage'], Map<string, StorageIOWorker>>();
const lanes = new Set<StorageIOWorker>();
const readContexts = new WeakMap<Bucket['storage'], Map<string, { projectId: string; bucketName: string }>>();
const failure = (code: string | number) => Object.assign(new Error(String(code)), { code });
const aborted = () => Object.assign(new Error('Storage upload aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });
type Operation = { op: 'fence' | 'upload'; path: string; body?: unknown; localPath?: string; metadata?: Record<string, unknown> };

/** One SDK/auth environment per lane; termination cancels authentication and transfer I/O. */
export class StorageIOWorker {
  private worker?: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private cancel?: () => Promise<void>;
  private requestId = 0;
  constructor(private config: Record<string, unknown>, private entry = new URL(`./io-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)) {}

  remove(path: string, milliseconds = storageCleanupLimits.requestMilliseconds as number): Promise<void> {
    return this.schedule({ op: 'fence', path }, milliseconds);
  }

  upload(operation: Omit<Operation, 'op'>, signal: AbortSignal, transfers: Transferable[] = [], onProgress?: (bytes: number) => void) {
    return this.schedule({ ...operation, op: 'upload' }, undefined, signal, transfers, onProgress);
  }

  private schedule(operation: Operation, milliseconds?: number, signal?: AbortSignal, transfers: Transferable[] = [], onProgress?: (bytes: number) => void): Promise<void> {
    const limit = operation.op === 'upload' ? 1 : storageCleanupLimits.pageSize;
    if (this.closed || this.pending >= limit) return Promise.reject(failure('storage_cleanup_busy'));
    if (signal?.aborted) return Promise.reject(aborted());
    this.pending++;
    const result = this.tail.then(() => this.run(operation, milliseconds, signal, transfers, onProgress));
    this.tail = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }

  protected createWorker() {
    return createStorageThread({ rifloStorageIO: true, ...this.config }, this.entry);
  }

  private run(operation: Operation, milliseconds?: number, signal?: AbortSignal, transfers: Transferable[] = [], onProgress?: (bytes: number) => void): Promise<void> {
    if (this.closed) return Promise.reject(failure('storage_cleanup_closed'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (milliseconds !== undefined && (!Number.isFinite(milliseconds) || milliseconds <= 0)) return Promise.reject(failure('invalid_storage_timeout'));
    if (!this.worker) {
      this.worker = this.createWorker();
      const created = this.worker;
      created.on('error', () => { if (this.worker === created) this.worker = undefined; });
      created.on('exit', () => { if (this.worker === created) this.worker = undefined; });
    }
    const worker = this.worker;
    worker.ref();
    const id = ++this.requestId;
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = async (error?: Error, terminate = false) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.off('message', message); worker.off('error', errored); worker.off('exit', exited);
        this.cancel = undefined;
        if (terminate) {
          this.worker = undefined;
          await worker.terminate().catch(() => {});
        } else worker.unref();
        if (error) reject(error); else resolve();
      };
      const message = (value: unknown) => {
        const result = value as { id?: unknown; ok?: unknown; code?: unknown; numericCode?: unknown; transferredBytes?: unknown } | null;
        if (result?.id !== id) return;
        if (typeof result.transferredBytes === 'number' && Number.isSafeInteger(result.transferredBytes) && result.transferredBytes >= 0) { onProgress?.(result.transferredBytes); return; }
        if (result.ok === true) void finish();
        else if (result.ok === false && typeof result.code === 'string' && /^[a-zA-Z0-9_/-]{1,60}$/.test(result.code)) void finish(failure(result.numericCode === true && /^\d+$/.test(result.code) ? Number(result.code) : result.code));
      };
      const errored = () => { void finish(failure('storage_cleanup_worker_failed'), true); };
      const exited = () => { void finish(failure('storage_cleanup_worker_exited'), true); };
      const timer = milliseconds === undefined ? undefined : setTimeout(() => { void finish(failure('storage_cleanup_timeout'), true); }, milliseconds);
      const onAbort = () => { void finish(aborted(), true); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.cancel = () => finish(failure('storage_cleanup_closed'), true);
      worker.on('message', message); worker.once('error', errored); worker.once('exit', exited);
      try { worker.postMessage({ id, ...operation }, transfers); }
      catch { void finish(failure('invalid_storage_operation'), true); }
    });
  }

  async dispose() {
    this.closed = true;
    await this.cancel?.();
    if (this.worker) { await this.worker.terminate(); this.worker = undefined; }
    await this.tail;
  }
}

export { StorageIOWorker as StorageDeletionWorker };

export function boundedStorageBucket(app: App, bucketName: string) {
  // Firebase composition uses ADC. Never replace a custom credential's identity.
  if (app.options.credential?.constructor !== applicationDefault().constructor || !app.options.projectId) throw failure('unsupported_cleanup_credentials');
  const bucket = getStorage(app).bucket(bucketName);
  const canonicalName = bucket.name;
  let reads = readContexts.get(bucket.storage);
  if (!reads) { reads = new Map(); readContexts.set(bucket.storage, reads); }
  reads.set(canonicalName, { projectId: app.options.projectId, bucketName: canonicalName });
  let buckets = deletionLanes.get(bucket.storage);
  if (!buckets) { buckets = new Map(); deletionLanes.set(bucket.storage, buckets); }
  if (!buckets.has(canonicalName)) {
    const lane = new StorageIOWorker({ projectId: app.options.projectId, bucketName: canonicalName });
    buckets.set(canonicalName, lane); lanes.add(lane);
    let uploads = uploadLanes.get(bucket.storage);
    if (!uploads) { uploads = new Map(); uploadLanes.set(bucket.storage, uploads); }
    const upload = new StorageIOWorker({ projectId: app.options.projectId, bucketName: canonicalName });
    uploads.set(canonicalName, upload); lanes.add(upload);
  }
  return bucket;
}

export function storageReadContext(bucket: Bucket) {
  const context = readContexts.get(bucket.storage)?.get(bucket.name);
  if (!context) throw failure('unsupported_cleanup_credentials');
  return context;
}

/** Remove private payload while retaining a live, empty barrier against late create-only uploads. */
export async function deleteStorageObject(bucket: Bucket, path: string, milliseconds: number = storageCleanupLimits.requestMilliseconds) {
  const lane = deletionLanes.get(bucket.storage)?.get(bucket.name);
  if (!lane) throw failure('unsupported_cleanup_credentials');
  await lane.remove(path, milliseconds);
}

/** Upload clocks come from the already accepted work signal, independently of cleanup. */
export async function uploadStorageObject(bucket: Bucket, path: string, source: Readable | Uint8Array | { localPath: string }, metadata: Record<string, unknown>, signal: AbortSignal, onProgress?: (bytes: number) => void) {
  const lane = uploadLanes.get(bucket.storage)?.get(bucket.name);
  if (!lane) throw failure('unsupported_cleanup_credentials');
  let operation: Omit<Operation, 'op'>;
  const transfers: Transferable[] = [];
  if (source instanceof Readable) {
    const stream = Readable.toWeb(source, { strategy: { highWaterMark: 65_536, size: chunk => chunk.byteLength } });
    operation = { path, body: stream, metadata }; transfers.push(stream);
  } else if (source instanceof Uint8Array) {
    const bytes = new Uint8Array(source);
    operation = { path, body: bytes, metadata }; transfers.push(bytes.buffer);
  } else operation = { path, localPath: source.localPath, metadata };
  const destroy = () => { if (source instanceof Readable) source.destroy(); };
  signal.addEventListener('abort', destroy, { once: true });
  try { await lane.upload(operation, signal, transfers, onProgress); }
  finally {
    signal.removeEventListener('abort', destroy);
    if (source instanceof Readable) { source.destroy(); await finished(source).catch(() => {}); }
  }
}

export async function disposeStorageDeletions() {
  await Promise.all([disposeStorageReads(), ...[...lanes].map(lane => lane.dispose())]);
  lanes.clear();
}
