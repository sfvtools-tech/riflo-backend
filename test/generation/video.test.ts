import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createSourcePreparer } from '../../src/projects/adapters.js';
import { createVideoRenderer } from '../../src/generation/video.js';
import { validateShortVideo } from '../../src/generation/validation.js';
import { parseSelection, type GenerationClaim } from '../../src/generation/service.js';
import { shortVideoLimits } from '../../src/generation/config.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';

const execute = promisify(execFile);
const transcript = { text: 'A useful source idea.', words: [{ text: 'A', start: 1, end: 2 }, { text: 'useful', start: 2, end: 3 }, { text: 'idea', start: 10, end: 11 }] };
const plan = { status: 'ok' as const, startSeconds: 1, endSeconds: 11 };

test('clip plans use real word boundaries and bounded finite ordered source times', () => {
  assert.deepEqual(validateShortVideo(plan, transcript, 12).content, { status: 'ok', segments: [{ startSeconds: 1, endSeconds: 11 }] });
  assert.throws(() => validateShortVideo({ status: 'insufficient_source', startSeconds: null, endSeconds: null }, transcript, 12), { code: 'insufficient_source', retryable: false });
  for (const invalid of [
    { ...plan, startSeconds: NaN }, { ...plan, endSeconds: Infinity }, { ...plan, startSeconds: '1' },
    { ...plan, startSeconds: -1 }, { ...plan, startSeconds: 2, endSeconds: 1 },
    { ...plan, endSeconds: 10.5 }, { ...plan, startSeconds: 1.5 }, { ...plan, endSeconds: 13 },
    { ...plan, endSeconds: 3 }, { ...plan, command: 'ffmpeg -i https://evil.example/video' },
    { status: 'insufficient_source', startSeconds: 1, endSeconds: 11 },
  ]) assert.throws(() => validateShortVideo(invalid, transcript, 12));
  const longTranscript = { text: 'A long source.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'source', start: 60, end: 61 }] };
  assert.throws(() => validateShortVideo({ status: 'ok', startSeconds: 0, endSeconds: 61 }, longTranscript, 70));
  assert.throws(() => validateShortVideo(plan, { ...transcript, words: [transcript.words[0]!, { text: 'reversed', start: 5, end: 6 }, { text: 'backward', start: 4, end: 11 }] }, 12));
  const minimum = shortVideoLimits.minSeconds;
  try {
    shortVideoLimits.minSeconds = 11;
    assert.throws(() => validateShortVideo(plan, transcript, 12));
  } finally { shortVideoLimits.minSeconds = minimum; }
  assert.deepEqual(parseSelection({ short_videos: 1 }), { x_posts: 0, linkedin_posts: 0, short_videos: 1 });
  assert.throws(() => parseSelection({ short_videos: 2 }));
});

test('the real renderer makes a private portrait H264/AAC clip with fit padding and removes temporary files', {
  skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH,
  timeout: 120_000,
}, async () => {
  const originalFlag = process.env.RIFLO_WORKER_TRACE;
  const originalInfo = console.info;
  const messages: string[] = [];
  process.env.RIFLO_WORKER_TRACE = '1';
  console.info = (...values: unknown[]) => { messages.push(values.join(' ')); };
  const directory = await mkdtemp(join(tmpdir(), 'riflo-video-test-'));
  const source = join(directory, 'source.mp4');
  const uploaded = new Map<string, Buffer>();
  const temporaryPaths: string[] = [];
  let failUpload = false;
  const controls = resolveGenerationControls({ formats: { short_videos: { editing: 'continuous', duration: 15 } }, sourceWindow: { startSeconds: 1, endSeconds: 11 } }, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, { status: 'resolved', defaults: {} });
  const claim = { batch: { controls }, project: { uid: 'alice', id: 'project-id', storagePath: 'private-source.mp4', source: { durationSeconds: 12 } }, slot: { id: 'short_videos-1' }, attempt: 1 } as GenerationClaim;
  const render = createVideoRenderer({
    ffmpegPath: process.env.FFMPEG_PATH!, ffprobePath: process.env.FFPROBE_PATH!,
    readSource: async (path) => { assert.equal(path, 'private-source.mp4'); return createReadStream(source); },
    storage: {
      uploadFile: async (path, localPath) => {
        temporaryPaths.push(localPath);
        if (uploaded.has(path)) throw Object.assign(Error('Already exists.'), { code: 412 });
        uploaded.set(path, await readFile(localPath));
        if (failUpload) throw Error('Upload interrupted.');
      },
      remove: async (path) => { uploaded.delete(path); },
    },
  });
  try {
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=10:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { timeout: 60_000 });
    // A cover image has meaningless 90000fps metadata; it must not replace the red footage.
    const cover = join(directory, 'cover.jpg');
    const covered = join(directory, 'covered.mp4');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).jpeg().toFile(cover);
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', source, '-i', cover, '-map', '1:v', '-map', '0:v', '-map', '0:a', '-c', 'copy', '-disposition:v:0', 'attached_pic', covered], { timeout: 10000 });
    await writeFile(source, await readFile(covered));
    await createSourcePreparer(process.env.FFPROBE_PATH!)(source, new AbortController().signal);
    const assets = await render(plan, claim, transcript, new AbortController().signal);
    assert.equal(assets.length, 1);
    assert.equal(assets[0]!.contentType, 'video/mp4');
    const metrics = messages.map(message => JSON.parse(message.slice(message.indexOf('{'))) as Record<string, unknown>);
    const sourceBytes = (await readFile(source)).length;
    assert.ok(metrics.some(value => value.event === 'video.source-bytes' && value.bytes === sourceBytes));
    assert.ok(metrics.some(value => value.event === 'video.output-measured' && value.bytes === assets[0]!.bytes && value.cuts === 1));
    assert.ok(metrics.some(value => value.event === 'video.encode:end' && typeof value.elapsedMilliseconds === 'number'));
    assert.ok(!messages.join('\n').includes('private-source.mp4'));
    const clip = join(directory, 'rendered.mp4');
    await writeFile(clip, uploaded.get(assets[0]!.storagePath)!);
    const { stdout } = await execute(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', clip]);
    const metadata = JSON.parse(stdout);
    assert.ok(Math.abs(Number(metadata.format.duration) - 10) < 0.2);
    const video = metadata.streams.find((stream: any) => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 720);
    assert.equal(video.height, 1280);
    assert.equal(metadata.streams.find((stream: any) => stream.codec_type === 'audio').codec_name, 'aac');
    const frame = join(directory, 'frame.png');
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-ss', '1', '-i', clip, '-frames:v', '1', frame]);
    const top = await sharp(frame).extract({ left: 360, top: 50, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    const center = await sharp(frame).extract({ left: 360, top: 640, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(top.every((channel) => channel < 20));
    assert.ok(center[0]! > 200 && center[1]! < 30 && center[2]! < 30);
    await assert.rejects(access(dirname(temporaryPaths[0]!)));
    const original = uploaded.get(assets[0]!.storagePath)!;
    await assert.rejects(render(plan, claim, transcript, new AbortController().signal), { code: 'video_render_failed' });
    assert.deepEqual(uploaded.get(assets[0]!.storagePath), original);
    failUpload = true;
    await assert.rejects(render(plan, { ...claim, attempt: 2 }, transcript, new AbortController().signal));
    assert.equal(uploaded.size, 1);
    for (const path of temporaryPaths) await assert.rejects(access(dirname(path)));
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(render(plan, { ...claim, attempt: 3 }, transcript, aborted.signal));
    assert.equal(uploaded.size, 1);
    const previousPixels = process.env.RIFLO_MEDIA_MAX_PIXELS;
    try {
      process.env.RIFLO_MEDIA_MAX_PIXELS = '100';
      const boundedRender = createVideoRenderer({
        ffmpegPath: process.env.FFMPEG_PATH!, ffprobePath: process.env.FFPROBE_PATH!, readSource: () => createReadStream(source),
        storage: { uploadFile: async () => assert.fail('Over-limit decoder must not upload.'), remove: async () => {} },
      });
      await assert.rejects(boundedRender(plan, claim, transcript, new AbortController().signal), { code: 'video_render_failed' });
    } finally {
      if (previousPixels === undefined) delete process.env.RIFLO_MEDIA_MAX_PIXELS;
      else process.env.RIFLO_MEDIA_MAX_PIXELS = previousPixels;
    }
  } finally {
    console.info = originalInfo;
    if (originalFlag === undefined) delete process.env.RIFLO_WORKER_TRACE;
    else process.env.RIFLO_WORKER_TRACE = originalFlag;
    await rm(directory, { recursive: true, force: true });
  }
});

test('stitched clips preserve selected picture and audio order while excluding the gaps', {
  skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH,
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-stitch-test-'));
  const source = join(directory, 'source.mp4');
  const output = join(directory, 'stitched.mp4');
  const selected = {
    status: 'ok' as const,
    segments: [{ startSeconds: 0.125, endSeconds: 3.835 }, { startSeconds: 6.125, endSeconds: 9.835 }, { startSeconds: 12.125, endSeconds: 15.835 }],
  };
  const words = selected.segments.flatMap((segment) => [
    { text: 'Start', start: segment.startSeconds, end: segment.startSeconds + 1 },
    { text: 'end.', start: segment.endSeconds - 1, end: segment.endSeconds },
  ]);
  const claim = { project: { uid: 'alice', id: 'stitched', storagePath: 'source', source: { durationSeconds: 16 } }, slot: { id: 'clip' }, attempt: 1 } as GenerationClaim;
  const render = createVideoRenderer({
    ffmpegPath: process.env.FFMPEG_PATH!, ffprobePath: process.env.FFPROBE_PATH!,
    readSource: () => createReadStream(source),
    storage: { uploadFile: async (_path, localPath) => { await writeFile(output, await readFile(localPath)); }, remove: async () => {} },
  });
  try {
    // Yellow/110 Hz gaps must disappear between the red/440, green/660 and blue/880 excerpts.
    await execute(process.env.FFMPEG_PATH!, [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
      "color=c=yellow:s=320x240:r=10:d=16,drawbox=color=red:t=fill:enable='lt(t,4)',drawbox=color=green:t=fill:enable='gte(t,6)*lt(t,10)',drawbox=color=blue:t=fill:enable='gte(t,12)'",
      '-f', 'lavfi', '-i', "aevalsrc=sin(2*PI*if(lt(t\\,4)\\,440\\,if(between(t\\,6\\,10)\\,660\\,if(gte(t\\,12)\\,880\\,110)))*t):s=48000:d=16",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
    ], { timeout: 60_000 });
    const assets = await render(selected, claim, { text: 'Three complete source thoughts.', words }, new AbortController().signal);
    assert.ok(Math.abs(assets[0]!.durationSeconds! - 11.13) <= 0.1);
    for (const [time, channel, frequency] of [[1, 0, 440], [5, 1, 660], [9, 2, 880]] as const) {
      const frame = join(directory, `frame-${time}.png`);
      await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', frame]);
      const pixel = await sharp(frame).extract({ left: 360, top: 640, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      assert.ok(pixel[channel]! > 100 && pixel.every((value, index) => index === channel || value < 30), `Wrong excerpt picture at ${time}s: ${pixel}`);
      const audio = await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-ss', String(time), '-i', output, '-t', '0.5', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 });
      let crossings = 0;
      let amplitude = 0;
      for (let offset = 2; offset < audio.stdout.length; offset += 2) {
        const current = audio.stdout.readInt16LE(offset);
        const previous = audio.stdout.readInt16LE(offset - 2);
        if (previous <= 0 && current > 0) crossings++;
        amplitude += Math.abs(current);
      }
      assert.ok(Math.abs(crossings * 2 - frequency) < 10, `Wrong excerpt audio at ${time}s: ${crossings * 2}Hz`);
      assert.ok(amplitude / (audio.stdout.length / 2) > 500, 'Excerpt audio must not be silent.');
    }
    const probe = await execute(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', output]);
    const streams = JSON.parse(probe.stdout).streams;
    assert.ok(streams.every((stream: { duration: string }) => Math.abs(Number(stream.duration) - 11.13) <= 0.1));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
