import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptedSourceLimits, type SourceLimits } from '../access/source-limits.js';
import { SourceError, type SourceDownload, type SourceAccess } from '../sources/source.js';
import { ProjectError, type JobClaim, type ImportResult, type ImportProgress } from './service.js';
import { traceWorkerAwait, workerTrace } from '../worker-trace.js';

export class SourceImportError extends Error {
  constructor(public code: string, public retryable: boolean, public bytes = 0) { super(code); }
}
export type SourceStorage = {
  upload: (localPath: string, storagePath: string, signal: AbortSignal, mimeType: string, onProgress?: (bytes: number) => void) => Promise<void>;
  remove: (path: string) => Promise<void>;
};
export const sourceFormats = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', ts: 'video/mp2t', mpeg: 'video/mpeg', ogv: 'video/ogg',
  flv: 'video/x-flv', asf: 'video/x-ms-asf', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
} as const;
export type SourceExtension = keyof typeof sourceFormats;
export type PreparedSource = { path: string; durationSeconds: number; extension: SourceExtension };
export const sourcePath = (uid: string, id: string, attempt: number, extension: SourceExtension | 'video' = 'video') => `accounts/${uid}/projects/${id}/source/attempt-${attempt}.${extension}`;
export const sourceAttemptPaths = (uid: string, id: string, attempt: number) => [sourcePath(uid, id, attempt), ...Object.keys(sourceFormats).map(extension => sourcePath(uid, id, attempt, extension as SourceExtension))];

// Conservative in-process reservation; other processes still require filesystem headroom.
let reservedScratchBytes = 0n;
export async function reserveSourceScratch(directory: string, maxBytes: number, inspect = statfs, outputBytes = maxBytes) {
  const required = BigInt(maxBytes) + BigInt(outputBytes) + 256n * 1024n ** 2n;
  const available = await inspect(directory, { bigint: true }).catch(() => { throw new SourceImportError('scratch_capacity_unavailable', true); });
  if (available.bavail * available.bsize < reservedScratchBytes + required) throw new SourceImportError('scratch_capacity_unavailable', true);
  reservedScratchBytes += required;
  let released = false;
  return () => { if (!released) { released = true; reservedScratchBytes -= required; } };
}

export async function cleanupSourceScratch(directory: string, remove = rm) {
  try { await remove(directory, { recursive: true, force: true }); }
  catch {
    // Cleanup must never replace a committed upload result or the original failure.
    try { console.warn('[worker] source_scratch_cleanup_failed'); } catch { /* Diagnostics are best effort. */ }
  }
}

async function awaitSourceCompletion(download: SourceDownload, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      download.finished.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort!);
  }
}

export function createSourceImporter({ files, storage, prepare, transcribe, checkpoint }: {
  files: Pick<SourceAccess, 'download'>;
  storage: SourceStorage;
  prepare: (path: string, signal: AbortSignal, limits?: SourceLimits) => Promise<PreparedSource>;
  transcribe?: (claim: JobClaim, result: ImportResult, signal: AbortSignal, localSource?: string) => Promise<void>;
  checkpoint?: (claim: JobClaim, result: ImportResult) => Promise<void>;
}) {
  return async (claim: JobClaim, signal: AbortSignal, onProgress?: (progress: ImportProgress) => void): Promise<ImportResult> => {
    if (claim.project.importUpload && claim.project.importUpload.operationId === claim.project.importOperationId) {
      onProgress?.({ attempt: claim.attempt, stage: 'transcribe', transferredBytes: 0, totalBytes: null });
      await transcribe?.(claim, claim.project.importUpload, signal);
      return claim.project.importUpload;
    }
    const limits = acceptedSourceLimits(claim.project);
    const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(900_000)]);
    const directory = await mkdtemp(join(tmpdir(), 'riflo-source-')).catch(() => { throw new SourceImportError('scratch_capacity_unavailable', true); });
    const localPath = join(directory, 'source.video');
    let releaseScratch: (() => void) | undefined;
    let destination: string | undefined;
    let bytes = 0;
    // Identify downloaded content before any container normalization.
    const sourceHash = createHash('sha256');
    let uploadStarted = false;
    let uploadSucceeded = false;
    let download: SourceDownload | undefined;
    const trace = { projectId: claim.project.id, attempt: claim.attempt };
    try {
      releaseScratch = await reserveSourceScratch(directory, limits.maxSourceBytes);
      const report = (stage: ImportProgress['stage'], transferredBytes: number, totalBytes: number | null) => onProgress?.({ attempt: claim.attempt, stage, transferredBytes, totalBytes });
      report('download', 0, null);
      const downloadStarted = Date.now();
      download = await traceWorkerAwait('source.open', () => files.download(claim.project.uid, claim.project.input, stageSignal, limits), trace, false, 40_000);
      // Observe early process failures while the body is still being copied.
      void download.finished.catch(() => undefined);
      let downloadTotal = download.totalBytes ?? null;
      if (downloadTotal !== null && (!Number.isSafeInteger(downloadTotal) || downloadTotal <= 0)) downloadTotal = null;
      report('download', 0, downloadTotal);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limits.maxSourceBytes) return callback(new SourceImportError('source_too_large', false, bytes));
          if (downloadTotal !== null && bytes > downloadTotal) downloadTotal = null;
          report('download', bytes, downloadTotal);
          sourceHash.update(chunk);
          callback(null, chunk);
        },
      });
      const progress = process.env.RIFLO_WORKER_TRACE === '1' ? setInterval(() => {
        workerTrace('source.download-progress', { ...trace, bytes, elapsedMilliseconds: Date.now() - downloadStarted });
      }, 15_000) : undefined;
      progress?.unref();
      try {
        await traceWorkerAwait('source.copy', () => pipeline(Readable.fromWeb(download!.body as never), meter, createWriteStream(localPath, { flags: 'wx' }), { signal: stageSignal }), trace, false, 600_000);
      } finally { clearInterval(progress); }
      await traceWorkerAwait('source.process-completion', () => awaitSourceCompletion(download!, stageSignal), trace, false, 600_000);
      const sourceSha256 = sourceHash.digest('hex');
      if (claim.project.importIntent === 'source_restore' && claim.project.sourceSha256 && claim.project.sourceSha256 !== sourceSha256) throw new SourceImportError('source_changed', false, bytes);
      signal.throwIfAborted();
      if (!bytes) throw new SourceImportError('invalid_video', false);
      workerTrace('source.download-measured', { ...trace, bytes, elapsedMilliseconds: Date.now() - downloadStarted });
      report('prepare', 0, null);
      const prepared = await traceWorkerAwait('source.prepare', () => prepare(localPath, stageSignal, limits), trace, false, 190_000);
      const { durationSeconds, extension } = prepared;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new SourceImportError('invalid_video', false, bytes);
      if (durationSeconds > limits.maxSourceSeconds) throw new SourceImportError('source_too_long', false, bytes);
      if (!(extension in sourceFormats)) throw new SourceImportError('unsupported_video', false, bytes);
      bytes = (await stat(prepared.path)).size;
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new SourceImportError('invalid_video', false, bytes);
      if (bytes > limits.maxSourceBytes) throw new SourceImportError('source_too_large', false, bytes);
      signal.throwIfAborted();
      destination = sourcePath(claim.project.uid, claim.project.id, claim.attempt, extension);
      uploadStarted = true;
      report('upload', 0, bytes);
      const result = { bytes, durationSeconds, storagePath: destination, mimeType: sourceFormats[extension], sourceSha256 };
      let transcriptionPending = Boolean(transcribe);
      const transcription = Promise.resolve().then(() => transcribe?.(claim, result, stageSignal, prepared.path)).finally(() => { transcriptionPending = false; });
      const upload = (async () => {
        await traceWorkerAwait('source.upload', () => storage.upload(prepared.path, destination!, AbortSignal.any([stageSignal, AbortSignal.timeout(180_000)]), sourceFormats[extension], transferred => report('upload', transferred, transferred <= bytes ? bytes : null)), trace, false, 190_000);
        uploadSucceeded = true;
        await checkpoint?.(claim, result);
        if (transcriptionPending) report('transcribe', 0, null);
      })();
      // Both readers own the prepared file until they settle, even if one fails.
      const [uploaded, transcribed] = await Promise.allSettled([upload, transcription]);
      if (uploaded.status === 'rejected') throw uploaded.reason;
      if (transcribed.status === 'rejected') throw transcribed.reason;
      workerTrace('source.stored-measured', { ...trace, bytes, durationSeconds, extension });
      return result;
    } catch (error) {
      const alreadyExists = (error as { code?: unknown })?.code === 412 || (error instanceof SourceImportError && error.code === 'source_exists');
      if (uploadStarted && !uploadSucceeded && destination && !alreadyExists) await storage.remove(destination).catch(() => undefined);
      if (alreadyExists) throw new SourceImportError('source_exists', false, bytes);
      if (error instanceof SourceImportError) { error.bytes = bytes; throw error; }
      if (error instanceof ProjectError) throw new SourceImportError(error.code, false, bytes);
      if (error instanceof SourceError) throw new SourceImportError(error.code, false, bytes);
      throw new SourceImportError(signal.aborted ? 'import_interrupted' : 'source_import_failed', true, bytes);
    } finally {
      await download?.cleanup().catch(() => undefined);
      await cleanupSourceScratch(directory);
      releaseScratch?.();
    }
  };
}

export async function cleanupAbandonedSources(now = Date.now(), directory = tmpdir()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('riflo-source-')) continue;
    const path = join(directory, entry.name);
    try {
      const details = await stat(path);
      if (details.mtimeMs <= now - 86_400_000) await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
  }
}
