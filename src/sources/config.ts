import { isAbsolute } from 'node:path';
import type { YouTubeConfig } from './youtube.js';

export function readYouTubeConfig(env: NodeJS.ProcessEnv): YouTubeConfig | undefined {
  if (!env.YT_DLP_PATH?.trim()) return undefined;
  if (!isAbsolute(env.YT_DLP_PATH) || !env.FFMPEG_PATH || !isAbsolute(env.FFMPEG_PATH)) {
    throw new Error('YouTube requires absolute YT_DLP_PATH and FFMPEG_PATH settings.');
  }
  return { executable: env.YT_DLP_PATH, nodePath: process.execPath, ffmpegPath: env.FFMPEG_PATH };
}
