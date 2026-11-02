import assert from 'node:assert/strict';
import test from 'node:test';
import { readYouTubeConfig } from '../../src/sources/config.js';

test('YouTube configuration stays optional and enabled tools require explicit absolute paths', () => {
  assert.equal(readYouTubeConfig({}), undefined);
  assert.equal(readYouTubeConfig({ FFMPEG_PATH: '/configured-for-drive-generation' }), undefined);
  assert.deepEqual(readYouTubeConfig({ YT_DLP_PATH: '/tools/yt-dlp', FFMPEG_PATH: '/tools/ffmpeg' }), { executable: '/tools/yt-dlp', nodePath: process.execPath, ffmpegPath: '/tools/ffmpeg' });
  for (const env of [{ YT_DLP_PATH: 'yt-dlp', FFMPEG_PATH: '/tools/ffmpeg' }, { YT_DLP_PATH: '/tools/yt-dlp' }, { YT_DLP_PATH: '/tools/yt-dlp', FFMPEG_PATH: 'ffmpeg' }]) assert.throws(() => readYouTubeConfig(env));
});
