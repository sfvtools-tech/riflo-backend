import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Worker } from 'node:worker_threads';
import type { getStorage } from 'firebase-admin/storage';
import { storageReadContext } from './delete.js';
import { createStorageThread } from './thread.js';

export const maxConcurrentStorageReads = 8;
const readers = new Set<() => Promise<void>>();
const failure = (code: string | number) => Object.assign(new Error(String(code)), { code });
export type StorageReadOptions = { maxBytes?: number; milliseconds?: number; signal?: AbortSignal };

/** A read owns its SDK/auth worker, so cancellation cannot leave pre-header I/O alive. */
export class StorageReadWorker {
  constructor(private config: Record<string, unknown>, private entry = new URL(`./read-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)) {}
  protected createWorker(): Worker { return createStorageThread({ rifloStorageRead: true, ...this.config }, this.entry); }

  read(path: string, { maxBytes = 6_000_000_000, milliseconds = 180_000, signal }: StorageReadOptions = {}): Readable {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 6_000_000_000 || !Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) throw failure('invalid_storage_read_limits');
    if (signal?.aborted) throw Object.assign(failure('ABORT_ERR'), { name: 'AbortError' });
    if (readers.size >= maxConcurrentStorageReads) throw failure('storage_read_busy');
    const channel = new TransformStream<Uint8Array, Uint8Array>();
    const output = Readable.fromWeb(channel.readable as never, { highWaterMark: 65_536 });
    const worker = this.createWorker();
    let ended = false;
    let termination: Promise<void> | undefined;
    const terminate = () => termination ??= worker.terminate().then(() => undefined).catch(() => undefined);
    const dispose = async () => { output.destroy(); await finished(output).catch(() => undefined); };
    readers.add(dispose);
    const destroy = output._destroy.bind(output);
    output._destroy = (error, done) => {
      // Transferable-stream errors preserve Error.message, but not custom code fields.
      if (error && !('code' in error) && /^[a-zA-Z0-9_/-]{1,60}$/.test(error.message)) error = failure(/^\d+$/.test(error.message) ? Number(error.message) : error.message);
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // A completed close is proof that even pre-header SDK/auth sockets are gone.
      void terminate().then(() => { readers.delete(dispose); destroy(error, done); });
    };
    const abort = () => output.destroy(Object.assign(failure('ABORT_ERR'), { name: 'AbortError' }));
    const timer = setTimeout(() => output.destroy(failure('storage_read_timeout')), milliseconds);
    worker.on('error', () => output.destroy(failure('storage_read_worker_failed')));
    worker.on('exit', () => { if (!ended && !output.destroyed) output.destroy(failure('storage_read_worker_exited')); });
    worker.on('message', (value: { ok?: unknown; code?: unknown; numericCode?: unknown }) => {
      if (value?.ok === true) ended = true;
      else if (value?.ok === false) output.destroy(failure(typeof value.code === 'string' && /^[a-zA-Z0-9_/-]{1,60}$/.test(value.code) ? value.numericCode === true && /^\d+$/.test(value.code) ? Number(value.code) : value.code : 'storage_read_failed'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { worker.postMessage({ path, sink: channel.writable, maxBytes }, [channel.writable]); }
    catch { output.destroy(failure('invalid_storage_operation')); }
    return output;
  }
}

export function readStorageFile(bucket: ReturnType<ReturnType<typeof getStorage>['bucket']>, path: string, options?: StorageReadOptions): Readable {
  return new StorageReadWorker(storageReadContext(bucket)).read(path, options);
}

export async function disposeStorageReads() { await Promise.all([...readers].map(dispose => dispose())); }


/** Retry known temporary transport/service failures; invalid content and access failures stay terminal. */
export function isTransientStorageReadError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' || typeof code === 'string' && /^\d{3}$/.test(code)) {
    const status = Number(code);
    return status === 429 || Number.isInteger(status) && status >= 500 && status <= 599;
  }
  return typeof code === 'string' && ['storage_read_busy', 'storage_read_timeout', 'ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code);
}
