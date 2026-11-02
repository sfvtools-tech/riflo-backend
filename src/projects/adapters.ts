import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { boundedStorageBucket, deleteStorageObject, uploadStorageObject } from '../storage/delete.js';
import type { App } from 'firebase-admin/app';
import { legacySourceLimits, type SourceLimits } from '../access/source-limits.js';
import { SourceImportError, type SourceStorage, type SourceExtension, type PreparedSource } from './source.js';

export function createSourceStorage(app: App, bucketName: string): SourceStorage {
  const bucket = boundedStorageBucket(app, bucketName);
  return {
    async upload(localPath, storagePath, signal, mimeType, onProgress) {
      await uploadStorageObject(bucket, storagePath, createReadStream(localPath), {
        contentType: mimeType,
        contentDisposition: `inline; filename="${basename(storagePath)}"`,
        cacheControl: 'private, no-store',
      }, signal, onProgress);
    },
    async remove(path) { await deleteStorageObject(bucket, path); },
  };
}

const run = promisify(execFile);
type VideoMetadata = {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; disposition?: { attached_pic?: number } }>;
  format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } };
};

export type DecodedMediaLimits = { maxDimension: number; maxPixels: number; maxFps: number; maxStreams: number };
export const defaultDecodedMediaLimits: Readonly<DecodedMediaLimits> = Object.freeze({
  maxDimension: 8192, maxPixels: 4096 * 2160, maxFps: 120, maxStreams: 32,
});

// Operational decode policy, independent of purchased duration/byte allowances.
export function decodedMediaLimitsFromEnvironment(env: NodeJS.ProcessEnv = process.env): DecodedMediaLimits {
  return {
    maxDimension: Number(env.RIFLO_MEDIA_MAX_DIMENSION ?? defaultDecodedMediaLimits.maxDimension),
    maxPixels: Number(env.RIFLO_MEDIA_MAX_PIXELS ?? defaultDecodedMediaLimits.maxPixels),
    maxFps: Number(env.RIFLO_MEDIA_MAX_FPS ?? defaultDecodedMediaLimits.maxFps),
    maxStreams: Number(env.RIFLO_MEDIA_MAX_STREAMS ?? defaultDecodedMediaLimits.maxStreams),
  };
}

export function validateDecodedMedia(metadata: VideoMetadata, limits: DecodedMediaLimits = defaultDecodedMediaLimits) {
  const streams = metadata.streams;
  if (!Array.isArray(streams) || !streams.some(stream => stream?.codec_type === 'video' && stream.disposition?.attached_pic !== 1)) throw new SourceImportError('invalid_video', false);
  if (streams.length > limits.maxStreams) throw new SourceImportError('source_decode_limits_exceeded', false);
  for (const stream of streams) {
    if (stream?.codec_type !== 'video') continue;
    const { width, height } = stream;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) throw new SourceImportError('invalid_video', false);
    if (width! > limits.maxDimension || height! > limits.maxDimension || width! * height! > limits.maxPixels) throw new SourceImportError('source_decode_limits_exceeded', false);
    if (stream.disposition?.attached_pic === 1) continue;
    const rates = [stream.avg_frame_rate, stream.r_frame_rate].map(rate => {
      if (rate === undefined || rate === '0/0' || rate === 'N/A') return null;
      if (!/^\d+(?:\/\d+)?$/.test(rate)) throw new SourceImportError('invalid_video', false);
      const [numerator, denominator = '1'] = rate.split('/');
      const value = Number(numerator) / Number(denominator);
      if (!Number.isFinite(value) || value < 0) throw new SourceImportError('invalid_video', false);
      return value || null;
    });
    if (rates.every(rate => rate === null)) throw new SourceImportError('invalid_video', false);
    if (rates.some(rate => rate !== null && rate > limits.maxFps)) throw new SourceImportError('source_decode_limits_exceeded', false);
  }
}

async function matroskaExtension(path: string): Promise<'webm' | 'mkv'> {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4096), 0, 4096, 0);
    const header = buffer.subarray(0, bytesRead);
    const index = header.indexOf(Buffer.from([0x42, 0x82]));
    if (index < 0) throw new SourceImportError('unsupported_video', false);
    const first = header[index + 2];
    if (first === undefined || !first) throw new SourceImportError('unsupported_video', false);
    const sizeBytes = 8 - Math.floor(Math.log2(first));
    if (index + 2 + sizeBytes > header.length) throw new SourceImportError('unsupported_video', false);
    let size = first & (0xff >> sizeBytes);
    for (let byte = 1; byte < sizeBytes; byte++) size = size * 256 + header[index + 2 + byte]!;
    const type = header.subarray(index + 2 + sizeBytes, index + 2 + sizeBytes + size).toString('ascii');
    if (type === 'webm') return 'webm';
    if (type === 'matroska') return 'mkv';
    throw new SourceImportError('unsupported_video', false);
  } finally { await file.close(); }
}

async function containerExtension(path: string, metadata: VideoMetadata): Promise<SourceExtension> {
  const formats = metadata.format?.format_name?.split(',') ?? [];
  if (formats.includes('mov')) {
    const brand = metadata.format?.tags?.major_brand?.trim();
    if (!brand || brand === 'qt') return 'mov';
    if (brand?.startsWith('3gp')) return '3gp';
    if (brand?.startsWith('3g2')) return '3g2';
    return 'mp4';
  }
  if (formats.includes('matroska') || formats.includes('webm')) return matroskaExtension(path);
  const extensions: Record<string, SourceExtension> = { avi: 'avi', mpegts: 'ts', mpeg: 'mpeg', ogg: 'ogv', flv: 'flv', asf: 'asf' };
  const extension = formats.map(format => extensions[format]).find(Boolean);
  if (!extension) throw new SourceImportError('unsupported_video', false);
  return extension;
}

// Stream packet timestamps: container/provider duration alone cannot authorize a longer timeline.
async function packetDuration(probePath: string, path: string, signal: AbortSignal, limits: SourceLimits): Promise<number> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(probePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpeg,ogg,flv,asf', '-show_packets', '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'csv=p=0', path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, killSignal: 'SIGKILL' });
    let first = Infinity, last = -Infinity, outputBytes = 0;
    let failure: SourceImportError | undefined;
    const stop = (error: SourceImportError) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new SourceImportError('import_interrupted', true));
    const timeout = setTimeout(() => stop(new SourceImportError('source_processing_timeout', true)), 60_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 64 * 1024 * 1024) stop(new SourceImportError('invalid_video', false)); });
    child.stderr.on('data', () => undefined);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (line.length > 4096) { stop(new SourceImportError('invalid_video', false)); return; }
      const [pts, dts, duration] = line.split(',');
      const timestamp = Number(pts === 'N/A' || pts === '' ? dts : pts);
      if (!Number.isFinite(timestamp)) return;
      const length = Number(duration);
      first = Math.min(first, timestamp);
      last = Math.max(last, timestamp + (Number.isFinite(length) && length > 0 ? length : 0));
      // One packet may straddle the container's endpoint by a codec frame.
      if (last - first > limits.maxSourceSeconds + 0.1) stop(new SourceImportError('source_too_long', false));
    });
    child.on('error', () => { failure ??= new SourceImportError('probe_unavailable', true); });
    child.on('close', code => {
      clearTimeout(timeout); signal.removeEventListener('abort', abort); lines.close();
      if (failure) reject(failure);
      else if (code !== 0 || !Number.isFinite(last - first) || last <= first) reject(new SourceImportError('invalid_video', false));
      else resolve(Math.min(limits.maxSourceSeconds, last - first));
    });
  });
}

export function createSourcePreparer(probePath: string, ffmpegPath?: string, decodedLimits: DecodedMediaLimits = decodedMediaLimitsFromEnvironment()) {
  if (Object.values(decodedLimits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid decoded media limits.');
  async function probe(path: string, signal: AbortSignal, limits: SourceLimits) {
    try {
      const { stdout } = await run(probePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpeg,ogg,flv,asf', '-show_entries', 'format=duration,format_name:format_tags=major_brand:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic', '-of', 'json', path], { signal, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' });
      const metadata = JSON.parse(stdout) as VideoMetadata;
      validateDecodedMedia(metadata, decodedLimits);
      const seconds = Number(metadata.format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('No duration.');
      if (seconds > limits.maxSourceSeconds) throw new SourceImportError('source_too_long', false);
      return { metadata, seconds };
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(String((error as { code?: unknown })?.code))) throw new SourceImportError('probe_unavailable', true);
      if (error instanceof SourceImportError) throw error;
      if ((error as { killed?: boolean })?.killed && !signal.aborted) throw new SourceImportError('source_processing_timeout', true);
      throw new SourceImportError(signal.aborted ? 'import_interrupted' : 'invalid_video', signal.aborted);
    }
  }
  return async (path: string, signal: AbortSignal, limits: SourceLimits = legacySourceLimits): Promise<PreparedSource> => {
    const { metadata, seconds: containerSeconds } = await probe(path, signal, limits);
    const extension = await containerExtension(path, metadata);
    const scannedSeconds = await packetDuration(probePath, path, signal, limits);
    const seconds = Math.max(containerSeconds, scannedSeconds);
    if (extension !== 'ts') return { path, durationSeconds: seconds, extension };
    // Stream copying changes the container without changing the recorded footage.
    const streams = metadata.streams ?? [];
    if (!ffmpegPath || streams.find(stream => stream.codec_type === 'video')?.codec_name !== 'h264' || streams.some(stream => stream.codec_type === 'audio' && stream.codec_name !== 'aac')) {
      return { path, durationSeconds: seconds, extension };
    }
    const output = join(dirname(path), 'prepared.mp4');
    try {
      await run(ffmpegPath, ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-f', 'mpegts', '-i', path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-fs', String(limits.maxSourceBytes), output], { signal, timeout: 120_000, maxBuffer: 64 * 1024, windowsHide: true, killSignal: 'SIGKILL' });
      if ((await stat(output)).size > limits.maxSourceBytes) throw new SourceImportError('source_too_large', false);
      const prepared = await probe(output, signal, limits);
      if (await containerExtension(output, prepared.metadata) !== 'mp4' || Math.abs(prepared.seconds - seconds) > 1) throw new SourceImportError('invalid_video', false);
      return { path: output, durationSeconds: prepared.seconds, extension: 'mp4' };
    } catch (error) {
      if (error instanceof SourceImportError) throw error;
      if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(String((error as { code?: unknown })?.code))) throw new SourceImportError('media_tools_unavailable', true);
      if ((error as { killed?: boolean })?.killed && !signal.aborted) throw new SourceImportError('source_processing_timeout', true);
      throw new SourceImportError(signal.aborted ? 'import_interrupted' : 'invalid_video', signal.aborted);
    }
  };
}

export async function verifyVideoProbe(executable: string) {
  try {
    const { stdout } = await run(executable, ['-version'], { timeout: 10_000, maxBuffer: 64 * 1024 });
    if (!stdout.startsWith('ffprobe version ')) throw new Error('Unexpected executable.');
  } catch {
    throw new Error('FFPROBE_PATH must point to a working ffprobe executable.');
  }
}
