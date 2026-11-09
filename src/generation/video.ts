import { decodedMediaLimitsFromEnvironment } from '../projects/adapters.js';
import { cleanupSourceScratch, reserveSourceScratch, SourceImportError } from '../projects/source.js';
import { prepareCaptions } from './captions.js';
import { isTransientStorageReadError } from '../storage/read.js';
import { videoPath } from './asset-paths.js';
import { createWriteStream } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptedSourceLimits } from '../access/source-limits.js';
import { shortVideoLimits } from './config.js';
import { shortVideoDuration, validateShortVideo } from './validation.js';
import { GenerationError, type GenerationClaim, type LegacyShortVideoContent, type OutputAsset, type ShortVideoContent, type Transcript } from './service.js';
import { traceWorkerAwait, workerTrace } from '../worker-trace.js';

const executeFile = promisify(execFile);
async function execute(file: string, args: string[], options: ExecFileOptions) {
  const execution = executeFile(file, args, { ...options, encoding: 'utf8' });
  const closed = new Promise<void>(resolve => execution.child.once('close', () => resolve()));
  try { return await execution; }
  catch (error) {
    // Abort can reject before exit, and execFile may send SIGTERM on this path.
    try { execution.child.kill('SIGKILL'); } catch { /* Preserve the original process failure. */ }
    throw error;
  } finally { await closed; }
}
export type VideoStorage = { uploadFile: (path: string, localPath: string, signal: AbortSignal) => Promise<void>; remove: (path: string) => Promise<void> };

export function createVideoRenderer({ storage, readSource, ffmpegPath, ffprobePath }: {
  storage: VideoStorage; readSource: (path: string) => Readable | Promise<Readable>; ffmpegPath: string; ffprobePath: string;
}) {
  const { maxPixels } = decodedMediaLimitsFromEnvironment();
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) throw new Error('Invalid decoded media limits.');
  return async (value: ShortVideoContent | LegacyShortVideoContent, claim: GenerationClaim, transcript: Transcript, signal: AbortSignal): Promise<OutputAsset[]> => {
    const limits = acceptedSourceLimits(claim.project);
    const plan = validateShortVideo(value, transcript, claim.project.source.durationSeconds!, claim.batch?.controls).content;
    const duration = shortVideoDuration(plan);
    if (!claim.project.storagePath) throw new GenerationError(409, 'source_not_ready', 'The original video is no longer available.');
    const directory = await mkdtemp(join(tmpdir(), 'riflo-source-')).catch(() => { throw new GenerationError(503, 'scratch_capacity_unavailable', 'Temporary media storage is unavailable.', true); });
    const source = join(directory, 'source.video');
    const output = join(directory, 'clip.mp4');
    const path = videoPath(claim.project.uid, claim.project.id, claim.slot!.id, claim.attempt);
    let uploadStarted = false;
    let releaseScratch: (() => void) | undefined;
    const trace = { projectId: claim.project.id, slotId: claim.slot!.id, attempt: claim.attempt };
    try {
      releaseScratch = await reserveSourceScratch(directory, limits.maxSourceBytes, undefined, shortVideoLimits.maxBytes);
      let bytes = 0;
      await traceWorkerAwait('video.source-read', async () => pipeline(await readSource(claim.project.storagePath!), new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(bytes > limits.maxSourceBytes ? new Error('Source exceeds its bound.') : null, chunk);
      } }), createWriteStream(source, { flags: 'wx' }), { signal }), trace, false, 190_000);
      workerTrace('video.source-bytes', { ...trace, bytes });
      // Seek each excerpt so a short clip does not require decoding the entire source.
      const inputs = plan.segments.flatMap((segment) => ['-protocol_whitelist', 'file,pipe', '-max_pixels', String(maxPixels), '-ss', String(segment.startSeconds), '-t', String(segment.endSeconds - segment.startSeconds), '-i', source]);
      // Keep low-frame-rate rounding from extending every join beyond the selected speech.
      const filters = plan.segments.flatMap((segment, index) => {
        const seconds = segment.endSeconds - segment.startSeconds;
        const frames = Math.max(1, Math.floor(seconds * shortVideoLimits.framesPerSecond));
        return [
          `[${index}:V:0]setpts=PTS-STARTPTS,fps=${shortVideoLimits.framesPerSecond},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${index}]`,
          `[${index}:a:0]atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`,
        ];
      });
      const captions = claim.batch?.controls?.formats.short_videos?.captions === 'clean'
        ? await traceWorkerAwait('video.captions', () => prepareCaptions(plan, transcript, directory, signal), trace, false, 35_000) : undefined;
      if (captions) inputs.push('-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', captions.path);
      const selected = plan.segments.map((_segment, index) => `[v${index}][a${index}]`).join('');
      filters.push(`${selected}concat=n=${plan.segments.length}:v=1:a=1[video][audio]`, `[video]scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[${captions ? 'scaled' : 'out'}]`);
      if (captions) filters.push(`[${plan.segments.length}:v]fps=30[cap]`, '[scaled][cap]overlay=x=36:y=960:eof_action=pass:repeatlast=0[out]');
      await traceWorkerAwait('video.encode', () => execute(ffmpegPath, [
        '-nostdin', '-v', 'error', ...inputs,
        '-filter_complex', filters.join(';'), '-map', '[out]', '-map', '[audio]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-maxrate', '8M', '-bufsize', '16M',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-map_metadata', '-1', '-map_chapters', '-1', '-fs', String(shortVideoLimits.maxBytes), output,
      ], { signal, timeout: 180_000, maxBuffer: 64 * 1024, windowsHide: true, killSignal: 'SIGKILL' }), trace, false, 190_000);
      const { stdout } = await execute(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height', '-of', 'json', output], { signal, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, killSignal: 'SIGKILL' });
      const metadata = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
      const durationSeconds = Number(metadata.format?.duration);
      const size = (await stat(output)).size;
      if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - duration) > 0.1 || durationSeconds > shortVideoLimits.maxSeconds + 0.1 || size <= 0 || size >= shortVideoLimits.maxBytes || !metadata.format?.format_name?.split(',').includes('mp4') || !metadata.streams?.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264' && stream.width === shortVideoLimits.width && stream.height === shortVideoLimits.height) || !metadata.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')) throw new Error('Rendered video did not meet its bounds.');
      signal.throwIfAborted();
      uploadStarted = true;
      try { await traceWorkerAwait('video.upload', () => storage.uploadFile(path, output, signal), trace, false, 190_000); }
      catch (error) {
        // A rejected creation belongs to an earlier attempt and must survive cleanup.
        if ((error as { code?: unknown })?.code === 412) uploadStarted = false;
        throw error;
      }
      workerTrace('video.output-measured', { ...trace, bytes: size, durationSeconds, cuts: plan.segments.length });
      return [{ id: 'clip', storagePath: path, contentType: 'video/mp4', bytes: size, width: shortVideoLimits.width, height: shortVideoLimits.height, durationSeconds }];
    } catch (error) {
      if (uploadStarted) await storage.remove(path).catch(() => undefined);
      if (error instanceof SourceImportError) throw new GenerationError(503, error.code, 'Temporary media storage is unavailable.', error.retryable);
      throw new GenerationError(502, 'video_render_failed', 'The original video clip could not be prepared.', signal.aborted || isTransientStorageReadError(error) || ['ENOSPC', 'EDQUOT'].includes(String((error as { code?: unknown })?.code)));
    } finally {
      await cleanupSourceScratch(directory);
      releaseScratch?.();
    }
  };
}
