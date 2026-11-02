import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { operationalLimits } from '../../src/access/policy.js';
import { createYouTubeSource, parseYouTubeLink, readYouTubeMetadata, testedYouTubeToolVersion, verifyYouTubeTools } from '../../src/sources/youtube.js';

const input = { source: 'youtube' as const, videoId: 'abcdefghijk' };
const metadata = () => ({ id: input.videoId, extractor_key: 'Youtube', title: 'Synthetic video', availability: 'public', live_status: 'not_live', age_limit: 0, duration: 60 });

async function withTool(script: (log: string) => string, run: (source: ReturnType<typeof createYouTubeSource>, log: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-youtube-adapter-test-'));
  const executable = join(directory, 'fake-downloader');
  const log = join(directory, 'arguments.jsonl');
  try {
    await writeFile(executable, `#!${process.execPath}\n${script(log)}\n`);
    await chmod(executable, 0o700);
    const source = createYouTubeSource({ executable, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg' });
    await run(source, log);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('YouTube links normalize supported single-video forms and reject redirects, playlists and injected options', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com/watch?v=abcdefghijk&t=10',
    'https://m.youtube.com/shorts/abcdefghijk', 'https://youtu.be/abcdefghijk?si=shared',
    'https://www.youtube.com/embed/abcdefghijk', 'https://www.youtube-nocookie.com/embed/abcdefghijk',
  ]) assert.deepEqual(parseYouTubeLink(url), input);
  for (const url of [
    'http://youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.example/watch?v=abcdefghijk',
    'https://youtube.com@evil.example/watch?v=abcdefghijk', 'https://user:pass@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:444/watch?v=abcdefghijk', 'https://youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv',
    'https://youtube.com/watch?v=abcdefghijk&list=playlist', 'https://youtube.com/playlist?list=playlist',
    'https://youtube.com/live/abcdefghijk', 'https://youtube.com/redirect?q=http://127.0.0.1',
    'https://youtube.com/watch?v=abcdefghijk&url=http://127.0.0.1', 'https://youtu.be/abcdefghijk?v=lmnopqrstuv',
    'https://youtube.com/watch?v=abcdefghijk#fragment', 'https://youtu.be/short',
  ]) assert.throws(() => parseYouTubeLink(url), { code: 'invalid_youtube_link' });
});

test('YouTube metadata stays provisional, ignores estimated size and enforces source and access bounds', () => {
  const normalized = readYouTubeMetadata({ ...metadata(), filesize_approx: 123 }, input);
  assert.equal(normalized.bytes, null);
  assert.equal(normalized.durationSeconds, 60);
  assert.equal(normalized.requiresProbe, true);
  assert.equal(readYouTubeMetadata({ ...metadata(), duration: null }, input).durationSeconds, null);
  assert.equal(readYouTubeMetadata({ ...metadata(), availability: 'unlisted', live_status: 'was_live', filesize: 456 }, input).bytes, 456);
  for (const change of [
    { id: 'another-id' }, { extractor_key: 'Generic' }, { _type: 'playlist' }, { title: '' },
    { duration: -1 }, { duration: Infinity }, { duration: '60' }, { filesize: 1.5 }, { filesize: '123' },
  ]) assert.throws(() => readYouTubeMetadata({ ...metadata(), ...change }, input), { code: 'youtube_invalid_response' });
  for (const change of [
    { availability: 'private' }, { availability: 'needs_auth' }, { availability: 'premium_only' },
    { live_status: 'is_live' }, { live_status: 'is_upcoming' }, { age_limit: 18 }, { age_limit: -1 }, { age_limit: NaN },
  ]) assert.throws(() => readYouTubeMetadata({ ...metadata(), ...change }, input), { code: 'youtube_video_restricted' });
  assert.throws(() => readYouTubeMetadata({ ...metadata(), duration: operationalLimits.maxSourceSeconds + 1 }, input), { code: 'source_too_long' });
  assert.throws(() => readYouTubeMetadata({ ...metadata(), filesize: operationalLimits.maxSourceBytes + 1 }, input), { code: 'source_too_large' });
});

test('offline tool verification rejects an untested downloader version', async () => {
  await withTool(() => 'process.stdout.write("2020.01.01");', async (_source, log) => {
    await assert.rejects(verifyYouTubeTools({ executable: join(dirname(log), 'fake-downloader'), nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg' }), { status: 503, code: 'youtube_not_configured' });
  });
});

test('offline tool verification rejects invalid options even when the downloader version matches', async () => {
  await withTool(() => `if(process.argv.includes('--version'))process.stdout.write(${JSON.stringify(testedYouTubeToolVersion)});else process.exitCode=2;`, async (_source, log) => {
    await assert.rejects(verifyYouTubeTools({ executable: join(dirname(log), 'fake-downloader'), nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg' }), { status: 503, code: 'youtube_not_configured' });
  });
});

test('offline tool verification requires every HTTP transport capability before enabling YouTube', async () => {
  const options = ['request_size', 'multiple_requests', 'short_seek_size'];
  await withTool(() => `process.stdout.write(process.argv.includes('--version')?${JSON.stringify(testedYouTubeToolVersion)}:'youtube\\n');`, async (_source, log) => {
    const ffmpegPath = join(dirname(log), 'fake-ffmpeg');
    const config = { executable: join(dirname(log), 'fake-downloader'), nodePath: process.execPath, ffmpegPath };
    for (const missing of [null, ...options]) {
      const help = options.filter(option => option !== missing).map(option => `  -${option} <int> HTTP option`).join('\n');
      await writeFile(ffmpegPath, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('-version')?'ffmpeg version fixture':${JSON.stringify(help)});\n`);
      await chmod(ffmpegPath, 0o700);
      if (missing === null) await verifyYouTubeTools(config);
      else await assert.rejects(verifyYouTubeTools(config), { status: 503, code: 'youtube_not_configured', message: /HTTP request_size/ });
    }
  });
});

test('the YouTube adapter uses fixed canonical arguments and rechecks metadata before streaming', async () => {
  await withTool((log) => `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');process.stdout.write(args.includes('--print')?${JSON.stringify(JSON.stringify(metadata()))}:'synthetic-video');`, async (source, log) => {
    assert.equal((await source.validate('alice', input)).durationSeconds, 60);
    const download = await source.download('alice', input, new AbortController().signal);
    try {
      assert.equal(await new Response(download.body).text(), 'synthetic-video');
      await download.finished;
    } finally { await download.cleanup(); }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((args) => args.includes('--print')).length, 2);
    const media = calls.find((args) => args.includes('--output'))!;
    assert.equal(media[media.indexOf('--format') + 1], 'bv[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][vcodec^=avc1][acodec^=mp4a]');
    assert.equal(media[media.indexOf('--downloader-args') + 1], 'ffmpeg:-nostats -loglevel error');
    assert.ok(media.some((argument, index) => argument === '--downloader-args' && media[index + 1] === 'ffmpeg_i:-request_size 10485760 -multiple_requests 1 -short_seek_size 10485760'));
    assert.equal(media[media.indexOf('--max-filesize') + 1], String(operationalLimits.maxSourceBytes));
    assert.equal(media[media.indexOf('--output') + 1], '-');
    for (const args of calls) {
      for (const flag of ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-remote-components', '--no-cookies', '--no-cookies-from-browser', '--no-playlist']) assert.ok(args.includes(flag));
      assert.ok(!args.includes('--netrc'));
      assert.equal(args[args.indexOf('--use-extractors') + 1], 'youtube');
      assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
      assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=abcdefghijk']);
      assert.equal(args[args.indexOf('--retries') + 1], '0');
    }
  });
});

test('YouTube provider failures return safe source reasons without raw stderr', async () => {
  for (const [message, code] of [
    ['Private video unavailable secret-cookie', 'youtube_video_unavailable'],
    ['Members only. Sign in required secret-cookie', 'youtube_video_restricted'],
    ['Confirm you are not a bot secret-cookie', 'youtube_verification_required'],
  ]) await withTool(() => `process.stderr.write(${JSON.stringify(message)});process.exitCode=1;`, async (source) => {
    await assert.rejects(source.validate('alice', input), (error: unknown) => {
      assert.equal((error as { code: string }).code, code);
      assert.equal((error as Error).message, 'YouTube could not check this video.');
      assert.ok(!String(error).includes('secret-cookie'));
      return true;
    });
    await assert.rejects(source.download('alice', input, new AbortController().signal), { code, retryable: false });
  });
});

test('a media process failure remains a failed download after metadata succeeded', async () => {
  await withTool(() => `if(process.argv.includes('--print'))process.stdout.write(${JSON.stringify(JSON.stringify(metadata()))});else{process.stdout.write('partial-video');process.stderr.write('bot verification private-response');process.exitCode=1;}`, async (source) => {
    const download = await source.download('alice', input, new AbortController().signal);
    try {
      const results = await Promise.allSettled([new Response(download.body).arrayBuffer(), download.finished]);
      assert.equal(results[1]!.status, 'rejected');
      if (results[1]!.status === 'rejected') {
        assert.equal(results[1]!.reason.code, 'youtube_verification_required');
        assert.equal(results[1]!.reason.retryable, false);
        assert.ok(!String(results[1]!.reason).includes('private-response'));
      }
    } finally { await download.cleanup(); }
  });
});

test('cancellation reaches the metadata subprocess before a video download starts', async () => {
  await withTool(() => 'setInterval(()=>{},1000);', async (source) => {
    const controller = new AbortController();
    const pending = source.download('alice', input, controller.signal);
    const abort = setTimeout(() => controller.abort(), 25);
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Metadata subprocess ignored cancellation.')), 1500); })]), (error: unknown) => {
        assert.ok((error as { code?: string }).code === 'import_interrupted' || (error as Error).name === 'AbortError');
        return true;
      });
    } finally {
      clearTimeout(abort); clearTimeout(timeout!);
      await pending.catch(() => undefined);
    }
  });
});
