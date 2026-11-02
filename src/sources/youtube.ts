import { isAbsolute } from 'node:path';
import { legacySourceLimits, type SourceLimits } from '../access/source-limits.js';
import { SourceImportError } from '../projects/source.js';
import { SourceError, type SourceAdapter, type SourceDetails, type YouTubeInput } from './source.js';
import { SourceProcessError, startSourceProcess } from './process.js';

export type YouTubeConfig = { executable: string; nodePath: string; ffmpegPath: string };
class YouTubeCheckError extends SourceError {
  constructor(status: number, code: string, message: string, public retryable: boolean) { super(status, code, message); }
}
const identifier = /^[A-Za-z0-9_-]{11}$/;
export { parseYouTubeLink } from './source.js';

export function readYouTubeMetadata(value: unknown, input: YouTubeInput, limits: SourceLimits = legacySourceLimits): SourceDetails {
  const video = value as Record<string, unknown> | null;
  if (!video || typeof video !== 'object' || Array.isArray(video) || video.id !== input.videoId || (video._type !== undefined && video._type !== 'video') || video.extractor_key !== 'Youtube' || typeof video.title !== 'string' || !video.title.trim() || video.title.length > 4096) {
    throw new SourceError(502, 'youtube_invalid_response', 'YouTube returned unexpected video details.');
  }
  if (!['public', 'unlisted'].includes(String(video.availability)) || (video.age_limit !== undefined && video.age_limit !== 0) || !['not_live', 'was_live'].includes(String(video.live_status))) {
    throw new SourceError(422, 'youtube_video_restricted', 'Choose an accessible video without sign-in, age restrictions or an active livestream.');
  }
  const duration = video.duration ?? null;
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)) {
    throw new SourceError(502, 'youtube_invalid_response', 'YouTube returned an invalid video duration.');
  }
  if (typeof duration === 'number' && duration > limits.maxSourceSeconds) throw new SourceError(422, 'source_too_long', 'The video exceeds the source duration limit.');
  const bytes = video.filesize ?? null;
  if (bytes !== null && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0)) throw new SourceError(502, 'youtube_invalid_response', 'YouTube returned an invalid video size.');
  if (typeof bytes === 'number' && bytes > limits.maxSourceBytes) throw new SourceError(422, 'source_too_large', 'The video exceeds the source size limit.');
  return { source: 'youtube', videoId: input.videoId, name: video.title, mimeType: 'video/mp4', bytes: bytes as number | null, durationSeconds: duration as number | null, requiresProbe: true };
}

const command = (config: YouTubeConfig) => [
  '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-remote-components',
  '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-playlist',
  '--no-geo-bypass', '--use-extractors', 'youtube', '--no-js-runtimes', '--js-runtimes', `node:${config.nodePath}`,
  '--ffmpeg-location', config.ffmpegPath, '--socket-timeout', '15', '--retries', '0', '--fragment-retries', '0',
  '--extractor-retries', '0', '--file-access-retries', '0', '--no-progress',
];
function canonical(input: YouTubeInput) {
  if (input.source !== 'youtube' || !identifier.test(input.videoId)) throw new SourceError(400, 'invalid_source', 'A valid YouTube video ID is required.');
  return `https://www.youtube.com/watch?v=${input.videoId}`;
}
function processFailure(error: unknown) {
  if (!(error instanceof SourceProcessError)) return { code: 'youtube_download_failed', retryable: true };
  if (error.reason === 'challenge') return { code: 'youtube_verification_required', retryable: false };
  if (error.reason === 'restricted') return { code: 'youtube_video_restricted', retryable: false };
  if (error.reason === 'unavailable') return { code: 'youtube_video_unavailable', retryable: false };
  if (['source_process_configuration', 'source_process_unavailable'].includes(error.code)) return { code: 'youtube_not_configured', retryable: false };
  return { code: error.code === 'source_process_interrupted' ? 'import_interrupted' : error.code === 'source_process_unavailable' ? 'youtube_not_configured' : 'youtube_download_failed', retryable: true };
}

export function createYouTubeSource(config: YouTubeConfig): SourceAdapter<YouTubeInput> {
  if (![config.executable, config.nodePath, config.ffmpegPath].every(isAbsolute)) throw new SourceError(503, 'youtube_not_configured', 'YouTube tools require absolute executable paths.');
  async function validate(_uid: string, input: YouTubeInput, limits: SourceLimits = legacySourceLimits, signal?: AbortSignal) {
    // Formats and manifests can be megabytes; print only the fields we validate.
    const download = await startSourceProcess({ ...config, signal, args: [...command(config), '--print', '%(.{id,_type,extractor_key,title,availability,age_limit,live_status,duration,filesize})j', '--skip-download', '--', canonical(input)], timeoutMilliseconds: 30_000, maxOutputBytes: 1024 * 1024 });
    try {
      const text = await new Response(download.body).text();
      await download.finished;
      return readYouTubeMetadata(JSON.parse(text), input, limits);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      const failure = processFailure(error);
      throw new YouTubeCheckError(failure.code === 'youtube_not_configured' ? 503 : failure.retryable ? 502 : 422, failure.code, 'YouTube could not check this video.', failure.retryable);
    } finally { await download.cleanup(); }
  }
  return {
    validate,
    async download(uid, input, signal, limits = legacySourceLimits) {
      // Re-check restrictions immediately before downloading; metadata can change after selection.
      try { await validate(uid, input, limits, signal); }
      catch (error) {
        if (error instanceof SourceError) throw new SourceImportError(error.code, error instanceof YouTubeCheckError && error.retryable);
        throw error;
      }
      signal.throwIfAborted();
      const result = await startSourceProcess({ ...config, signal, args: [
        // Stdout uses MPEG-TS; select codecs the media probe can recognize in that stream.
        ...command(config), '--format', 'bv[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][vcodec^=avc1][acodec^=mp4a]', '--merge-output-format', 'mp4',
        // FFmpeg progress bypasses --no-progress and can exhaust the diagnostic limit.
        '--downloader-args', 'ffmpeg:-nostats -loglevel error',
        // Stdout merging bypasses yt-dlp's native 10 MiB YouTube HTTP chunks.
        '--downloader-args', 'ffmpeg_i:-request_size 10485760 -multiple_requests 1 -short_seek_size 10485760',
        '--max-filesize', String(limits.maxSourceBytes), '--output', '-', '--', canonical(input),
      ], timeoutMilliseconds: 600_000 });
      const finished = result.finished.catch(error => {
        const failure = processFailure(error); throw new SourceImportError(failure.code, failure.retryable);
      });
      void finished.catch(() => undefined);
      return { ...result, finished };
    },
  };
}

export const testedYouTubeToolVersion = '2026.10.26';

export async function verifyYouTubeTools(config: YouTubeConfig) {
  const checks = [
    { executable: config.executable, args: [...command(config), '--version'], accepts: (value: string) => value.trim() === testedYouTubeToolVersion },
    // --version exits before option validation; listing extractors parses our flags offline.
    { executable: config.executable, args: [...command(config), '--list-extractors'], accepts: (value: string) => /^youtube$/m.test(value) },
    { executable: config.nodePath, args: ['--version'], accepts: (value: string) => /^v(?:2[2-9]|[3-9]\d)\./.test(value.trim()) },
    { executable: config.ffmpegPath, args: ['-nostdin', '-version'], accepts: (value: string) => value.startsWith('ffmpeg version ') },
    { executable: config.ffmpegPath, args: ['-nostdin', '-hide_banner', '-h', 'protocol=http'], accepts: (value: string) => ['request_size', 'multiple_requests', 'short_seek_size'].every(option => new RegExp(`^\\s+-${option}\\s`, 'm').test(value)) },
  ];
  for (const check of checks) {
    let process;
    try {
      process = await startSourceProcess({ ...config, ...check, timeoutMilliseconds: 10_000, maxOutputBytes: 64 * 1024 });
      const value = await new Response(process.body).text();
      await process.finished;
      if (!check.accepts(value)) throw new Error();
    } catch { throw new SourceError(503, 'youtube_not_configured', 'Install the documented YouTube tool version, Node 22 or newer, and FFmpeg with HTTP request_size, multiple_requests and short_seek_size support.'); }
    finally { await process?.cleanup(); }
  }
}
