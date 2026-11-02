import { cleanupSourceScratch, reserveSourceScratch, SourceImportError } from '../projects/source.js';
import { isTransientStorageReadError } from '../storage/read.js';
import { createWriteStream } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Project } from '../projects/service.js';
import { acceptedSourceLimits, sourceAudioBytes } from '../access/source-limits.js';
import { GenerationError } from './service.js';
import { traceWorkerAwait, workerTrace } from '../worker-trace.js';

const execute = promisify(execFile);
export async function verifyAudioExtractor(path: string) {
  try {
    const { stdout } = await execute(path, ['-version'], { timeout: 10_000, maxBuffer: 64 * 1024 });
    if (!stdout.startsWith('ffmpeg version ')) throw new Error('Unexpected executable.');
  } catch { throw new Error('FFMPEG_PATH must point to a working ffmpeg executable.'); }
}
export function createAudioExtractor({ readSource, ffmpegPath }: { readSource: (path: string) => Readable; ffmpegPath: string }) {
  return async (project: Project, signal: AbortSignal, localSource?: string) => {
    if (!localSource && !project.storagePath) throw new GenerationError(409, 'source_not_ready', 'The source is no longer available.');
    const limits = acceptedSourceLimits(project);
    const directory = await mkdtemp(join(tmpdir(), 'riflo-source-')).catch(() => { throw new GenerationError(503, 'scratch_capacity_unavailable', 'Temporary media storage is unavailable.', true); });
    const source = localSource ?? join(directory, 'source.video');
    const audio = join(directory, 'audio.wav');
    let releaseScratch: (() => void) | undefined;
    const cleanup = async () => { await cleanupSourceScratch(directory); releaseScratch?.(); };
    try {
      releaseScratch = await reserveSourceScratch(directory, localSource ? 0 : limits.maxSourceBytes, undefined, sourceAudioBytes(limits));
      let bytes = 0;
      if (localSource) {
        // Only the importer supplies this path, after its complete media validation.
        const details = await stat(localSource);
        bytes = details.size;
        if (!details.isFile() || bytes <= 0 || bytes > limits.maxSourceBytes || (project.source?.bytes != null && bytes !== project.source.bytes)) throw new Error('Local source changed after validation.');
        signal.throwIfAborted();
      } else {
        await traceWorkerAwait('audio.source-read', () => pipeline(readSource(project.storagePath!), new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          done(bytes > limits.maxSourceBytes ? new Error('Source exceeds its bound.') : null, chunk);
        } }), createWriteStream(source, { flags: 'wx' }), { signal }), { projectId: project.id }, false, 190_000);
      }
      await traceWorkerAwait('audio.extract', () => execute(ffmpegPath, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', source, '-t', String(limits.maxSourceSeconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-fs', String(sourceAudioBytes(limits)), audio], { signal, timeout: 120_000, maxBuffer: 64 * 1024, windowsHide: true, killSignal: 'SIGKILL' }), { projectId: project.id }, false, 130_000);
      const audioBytes = (await stat(audio)).size;
      if (audioBytes <= 0 || audioBytes > sourceAudioBytes(limits)) throw new Error('Audio exceeds its bound.');
      workerTrace('audio.measured', { projectId: project.id, sourceBytes: bytes, audioBytes });
      return { path: audio, cleanup };
    } catch (error) {
      await cleanup();
      if (error instanceof SourceImportError) throw new GenerationError(503, error.code, 'Temporary media storage is unavailable.', error.retryable);
      throw new GenerationError(502, signal.aborted ? 'generation_interrupted' : 'audio_extraction_failed', 'The source audio could not be prepared.', signal.aborted || Boolean((error as { killed?: boolean })?.killed) || isTransientStorageReadError(error) || ['ENOSPC', 'EDQUOT'].includes(String((error as { code?: unknown })?.code)));
    }
  };
}
