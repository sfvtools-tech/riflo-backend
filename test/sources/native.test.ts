import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startSourceProcess } from '../../src/sources/process.js';
import { createYouTubeSource, verifyYouTubeTools } from '../../src/sources/youtube.js';

const execute = promisify(execFile);

test('native yt-dlp accepts the production options during offline startup verification', {
  skip: !process.env.YT_DLP_PATH || !process.env.FFMPEG_PATH,
  timeout: 40_000,
}, async () => {
  await verifyYouTubeTools({ executable: process.env.YT_DLP_PATH!, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH! });
});

test('native metadata projection keeps large format payloads below the adapter output limit', {
  skip: !process.env.YT_DLP_PATH || !process.env.FFMPEG_PATH,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-youtube-projection-test-'));
  try {
    const info = join(directory, 'info.json');
    const output = join(directory, 'metadata.json');
    const executable = join(directory, 'offline-downloader');
    await writeFile(info, JSON.stringify({
      id: 'abcdefghijk', _type: 'video', extractor_key: 'Youtube', title: 'Synthetic video',
      availability: 'public', age_limit: 0, live_status: 'not_live', duration: 60,
      formats: [{ format_id: 'fixture', url: 'https://example.invalid/video', ext: 'mp4', manifest: 'x'.repeat(2 * 1024 * 1024) }],
    }));
    // Replace only the URL with a local extractor result; run the adapter's actual flags and template.
    await writeFile(executable, `#!${process.execPath}\nconst {execFileSync}=require('node:child_process');const {writeFileSync}=require('node:fs');const args=process.argv.slice(2,-2);const value=execFileSync(${JSON.stringify(process.env.YT_DLP_PATH)},[...args,'--load-info-json',${JSON.stringify(info)}],{timeout:10000,maxBuffer:4*1024*1024});writeFileSync(${JSON.stringify(output)},value);process.stdout.write(value);\n`);
    await chmod(executable, 0o700);
    const source = createYouTubeSource({ executable, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH! });
    const details = await source.validate('alice', { source: 'youtube', videoId: 'abcdefghijk' });
    assert.equal(details.name, 'Synthetic video');
    assert.equal(details.durationSeconds, 60);
    assert.equal(details.bytes, null);
    const projected = await readFile(output, 'utf8');
    assert.ok(Buffer.byteLength(projected) < 1024);
    assert.equal(JSON.parse(projected).formats, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native yt-dlp uses bounded persistent HTTP requests while preserving separate video and audio', {
  skip: !process.env.YT_DLP_PATH || !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH,
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-youtube-native-test-'));
  const requests: { path: string; range: string | undefined; connection: string | undefined; port: number | undefined }[] = [];
  const files = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, range: request.headers.range, connection: request.headers.connection, port: request.socket.remotePort });
    const file = files.get(request.url!);
    if (!file) { response.writeHead(404); response.end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : file.length - 1, file.length - 1);
    if (start >= file.length) { response.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); response.end(); return; }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}),
    });
    response.end(file.subarray(start, end + 1));
  });
  let download: Awaited<ReturnType<typeof startSourceProcess>> | undefined;
  try {
    await verifyYouTubeTools({ executable: process.env.YT_DLP_PATH!, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH! });
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(directory, 'video.mp4')], { timeout: 15_000 });
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', join(directory, 'audio.m4a')], { timeout: 15_000 });
    for (const name of await readdir(directory)) files.set(`/${name}`, await readFile(join(directory, name)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const info = join(directory, 'info.json');
    // This synthetic extractor result proves native muxing without downloading a real video.
    await writeFile(info, JSON.stringify({ id: 'fixture', title: 'Synthetic', extractor: 'generic', extractor_key: 'Generic', webpage_url: `${origin}/fixture`, formats: [
      { format_id: 'video', url: `${origin}/video.mp4`, ext: 'mp4', vcodec: 'avc1', acodec: 'none', width: 160, height: 90 },
      { format_id: 'audio', url: `${origin}/audio.m4a`, ext: 'm4a', vcodec: 'none', acodec: 'mp4a' },
    ] }));
    download = await startSourceProcess({
      executable: process.env.YT_DLP_PATH!, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH!,
      timeoutMilliseconds: 30_000, maxOutputBytes: 10_000_000,
      // Small chunks exercise multiple requests without inflating the media fixture.
      args: ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist', '--no-progress', '--no-cache-dir', '--no-warnings', '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location', process.env.FFMPEG_PATH!, '--format', 'bv+ba', '--output', '-', '--merge-output-format', 'mp4', '--downloader-args', 'ffmpeg:-nostats -loglevel error', '--downloader-args', 'ffmpeg_i:-request_size 1024 -multiple_requests 1 -short_seek_size 1024', '--load-info-json', info],
    });
    const bytes = Buffer.from(await new Response(download.body).arrayBuffer());
    await download.finished;
    assert.ok(bytes.length > 0);
    const output = join(directory, 'combined.video');
    await writeFile(output, bytes);
    const { stdout } = await execute(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output], { timeout: 10_000 });
    const metadata = JSON.parse(stdout);
    assert.ok(metadata.streams.some((stream: { codec_type: string }) => stream.codec_type === 'video'));
    assert.ok(metadata.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'));
    assert.ok(Number(metadata.format.duration) >= 1.9);
    for (const path of ['/video.mp4', '/audio.m4a']) {
      const mediaRequests = requests.filter(request => request.path === path);
      assert.ok(mediaRequests.length > 1);
      for (const request of mediaRequests) {
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? '');
        assert.ok(range, 'HTTP reads have a bounded Range');
        assert.ok(Number(range[2]) - Number(range[1]) + 1 <= 1024);
        assert.equal(request.connection?.toLowerCase(), 'keep-alive');
      }
      assert.ok(new Set(mediaRequests.map(request => request.port)).size < mediaRequests.length, 'HTTP connections are reused');
    }
  } finally {
    await download?.cleanup();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
