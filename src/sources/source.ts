import { createCapacity } from "../capacity.js";
import type { SourceLimits } from '../access/source-limits.js';
import { parseDriveFileInput, type DriveFileInput } from './drive/files.js';

export type SourceKind = 'drive' | 'youtube';
export type YouTubeInput = { source: 'youtube'; videoId: string };
export type SourceInput = DriveFileInput | YouTubeInput;
export type SourceDetails = {
  name: string; mimeType: string; bytes: number | null;
  durationSeconds: number | null; requiresProbe: boolean;
} & ({ source?: 'drive'; fileId: string } | { source: 'youtube'; videoId: string });
export type SourceDownload = {
  totalBytes?: number | null;
  body: ReadableStream<Uint8Array>;
  finished: Promise<void>;
  cleanup: () => Promise<void>;
};
export type SourceAdapter<Input> = {
  validate: (uid: string, input: Input, limits?: SourceLimits, signal?: AbortSignal) => Promise<SourceDetails>;
  download: (uid: string, input: Input, signal: AbortSignal, limits?: SourceLimits) => Promise<SourceDownload>;
};
export class SourceError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSeconds?: number) { super(message); }
}

const shareParameters = new Set(['v', 'si', 't', 'start', 'feature', 'ab_channel']);

export function parseYouTubeLink(value: string): YouTubeInput {
  let url: URL;
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    url = new URL(value);
  } catch { throw new SourceError(400, 'invalid_youtube_link', 'Paste a YouTube video link.'); }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw new SourceError(400, 'invalid_youtube_link', 'Use an HTTPS YouTube video link.');
  }
  for (const [key, content] of url.searchParams) {
    if (!shareParameters.has(key) || url.searchParams.getAll(key).length !== 1 || content.length > 256 || /[\x00-\x1f\x7f]/.test(content)) {
      throw new SourceError(400, 'invalid_youtube_link', 'Choose one video without a playlist or redirect link.');
    }
  }
  let videoId: string | undefined;
  if (url.hostname === 'youtu.be') videoId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (url.hostname === 'www.youtube-nocookie.com') videoId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (url.pathname === '/watch') videoId = url.searchParams.get('v') ?? undefined;
  else videoId = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || (url.pathname !== '/watch' && url.searchParams.has('v'))) {
    throw new SourceError(400, 'invalid_youtube_link', 'Choose a single YouTube video, Short or embed link.');
  }
  return { source: 'youtube', videoId };
}

export function parseSourceInput(value: unknown): SourceInput {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'source' in value) {
    const input = value as Record<string, unknown>;
    if (input.source === 'drive') {
      const { source: _, ...file } = input;
      // Keep the original Drive request so retries can still find their project.
      return parseDriveFileInput(file);
    }
    if (input.source === 'youtube' && 'url' in input) {
      if (Object.keys(input).some(key => !['source', 'url'].includes(key)) || typeof input.url !== 'string') {
        throw new SourceError(400, 'invalid_source', 'Provide one YouTube video link or video ID.');
      }
      return parseYouTubeLink(input.url);
    }
    if (input.source !== 'youtube' || Object.keys(input).some(key => !['source', 'videoId'].includes(key)) || typeof input.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) {
      throw new SourceError(400, 'invalid_source', 'Choose a supported video source with a valid video ID.');
    }
    return { source: 'youtube', videoId: input.videoId };
  }
  return parseDriveFileInput(value);
}

export function originalSourceUrl(value: unknown): string | null {
  try {
    const input = parseSourceInput(value);
    if ('source' in input) return `https://www.youtube.com/watch?v=${input.videoId}`;
    const url = new URL(`https://drive.google.com/file/d/${input.fileId}/view`);
    if (input.resourceKey) url.searchParams.set('resourcekey', input.resourceKey);
    return url.href;
  } catch {
    return null;
  }
}

export function createSourceAccess(adapters: { drive?: SourceAdapter<DriveFileInput>; youtube?: SourceAdapter<YouTubeInput> }, capacity = { total: Number(process.env.SOURCE_VALIDATION_MAX_ACTIVE ?? 4), perAccount: Number(process.env.SOURCE_VALIDATION_MAX_PER_ACCOUNT ?? 1) }) {
  const acquire = createCapacity(capacity.total, capacity.perAccount);
  function selected(input: SourceInput) {
    const source = 'source' in input ? input.source : 'drive';
    if (!adapters[source]) throw new SourceError(503, 'source_not_configured', 'This video source is awaiting setup.');
    return source;
  }
  return {
    availability: { drive: { configured: Boolean(adapters.drive) }, youtube: { configured: Boolean(adapters.youtube) } },
    async validate(uid: string, input: SourceInput, limits?: SourceLimits, signal?: AbortSignal) {
      selected(input);
      signal?.throwIfAborted();
      if (!('source' in input)) return adapters.drive!.validate(uid, input, limits, signal);
      const release = acquire(uid);
      if (typeof release === 'number') throw new SourceError(release, 'source_validation_busy', 'Video validation is busy. Try again shortly.', 5);
      try { return await adapters.youtube!.validate(uid, input, limits, signal); }
      finally { release(); }
    },
    async download(uid: string, input: SourceInput, signal: AbortSignal, limits?: SourceLimits) {
      selected(input);
      return 'source' in input ? adapters.youtube!.download(uid, input, signal, limits) : adapters.drive!.download(uid, input, signal, limits);
    },
  };
}
export type SourceAccess = ReturnType<typeof createSourceAccess>;
