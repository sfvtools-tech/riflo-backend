import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { createVideoRenderer } from '../../src/generation/video.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';
import { captionLimits } from '../../src/generation/captions.js';
import type { GenerationClaim, ShortVideoContent, Transcript } from '../../src/generation/service.js';

const execute = promisify(execFile);
const native = { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH, timeout: 120_000 };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function frame(path: string, index: number) {
  const { stdout } = await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', path, '-vf', `select=eq(n\\,${index})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  return Buffer.from(stdout);
}
async function maskAgreement(image: Buffer, caption: Buffer) {
  const actual = await sharp(image).extract({ left: 36, top: 960, width: 648, height: 160 }).removeAlpha().raw().toBuffer();
  const expected = await sharp(caption).flatten({ background: '#000000' }).removeAlpha().raw().toBuffer();
  let intersection = 0, union = 0;
  for (let i = 0; i < actual.length; i += 3) {
    const a = actual[i]! > 190 && actual[i + 1]! > 190 && actual[i + 2]! > 190;
    const b = expected[i]! > 190 && expected[i + 1]! > 190 && expected[i + 2]! > 190;
    if (a || b) union++;
    if (a && b) intersection++;
  }
  return union ? intersection / union : 1;
}

async function sourceFixture(directory: string, seconds: number) {
  const source = join(directory, 'fixture.mp4');
  await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=320x180:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { timeout: 30_000 });
  return source;
}

test('native Clean captions follow fractional joins, show the final word, preserve audio and leave Off untouched', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-caption-native-'));
  try {
    const sourcePath = await sourceFixture(directory, 14);
    const plan: ShortVideoContent = { status: 'ok', segments: [{ startSeconds: 0, endSeconds: 1.017 }, { startSeconds: 3, endSeconds: 12.017 }] };
    const transcript: Transcript = { text: 'FIRST. EXCLUDED. SECOND हिंदी العربية 中文. FINAL.', words: [{ text: 'FIRST.', start: 0, end: 1.017 }, { text: 'EXCLUDED.', start: 2, end: 2.5 }, { text: 'SECOND हिंदी العربية 中文.', start: 3, end: 4 }, { text: 'FINAL.', start: 11.5, end: 12.017 }] };
    const paths: Record<string, string> = {};
    const captionImages: Buffer[] = [];
    const localPaths: string[] = [];
    let mode: 'clean' | 'off' = 'off';
    const renderer = createVideoRenderer({ ffmpegPath: process.env.FFMPEG_PATH!, ffprobePath: process.env.FFPROBE_PATH!, readSource: () => createReadStream(sourcePath), storage: {
      uploadFile: async (_path, localPath) => {
        localPaths.push(localPath);
        paths[mode] = join(directory, `${mode}.mp4`);
        await writeFile(paths[mode]!, await readFile(localPath));
        const names = await readdir(dirname(localPath));
        if (mode === 'off') assert.equal(names.filter(name => name.startsWith('caption')).length, 0);
        else for (const name of names.filter(name => /^caption-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) captionImages.push(await readFile(join(dirname(localPath), name)));
      }, remove: async () => assert.fail('No failed upload'),
    } });
    for (mode of ['off', 'clean'] as const) {
      const controls = resolveGenerationControls({ formats: { short_videos: { captions: mode } } }, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, { status: 'resolved', defaults: {} });
      const claim = { project: { uid: 'fixture', id: 'video', storagePath: 'fixture', source: { durationSeconds: 14 } }, batch: { controls }, slot: { id: mode }, attempt: 1 } as GenerationClaim;
      const result = await renderer(plan, claim, transcript, new AbortController().signal);
      assert.ok(Math.abs(result[0]!.durationSeconds! - 10.034) <= 0.1);
    }
    for (const path of localPaths) await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
    const beforeJoin = await frame(paths.clean!, 30);
    const afterJoin = await frame(paths.clean!, 31);
    const final = await frame(paths.clean!, 299);
    assert.ok(await maskAgreement(beforeJoin, captionImages[0]!) > 0.9);
    assert.ok(await maskAgreement(afterJoin, captionImages[1]!) > 0.9);
    assert.ok(await maskAgreement(final, captionImages.at(-1)!) > 0.9);
    const gap = await sharp(await frame(paths.clean!, 150)).extract({ left: 36, top: 960, width: 648, height: 160 }).removeAlpha().raw().toBuffer();
    assert.ok(gap.every(value => value < 20), 'A caption gap must be transparent.');
    const off = await sharp(await frame(paths.off!, 31)).extract({ left: 36, top: 960, width: 648, height: 160 }).removeAlpha().raw().toBuffer();
    assert.ok(off.every(value => value < 20), 'Off must not add burned captions.');
    const audio = [];
    for (const mode of ['off', 'clean']) {
      const { stdout } = await execute(process.env.FFMPEG_PATH!, ['-v', 'error', '-i', paths[mode]!, '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
      audio.push(Buffer.from(stdout));
    }
    assert.deepEqual(audio[0], audio[1]);
    if (process.env.RIFLO_CAPTION_PROOF_DIR) {
      const proof = process.env.RIFLO_CAPTION_PROOF_DIR;
      await mkdir(proof, { recursive: true });
      await Promise.all([writeFile(join(proof, 'clean-fractional-joins.mp4'), await readFile(paths.clean!)), writeFile(join(proof, 'off-fractional-joins.mp4'), await readFile(paths.off!)), writeFile(join(proof, 'before-join-frame30.png'), beforeJoin), writeFile(join(proof, 'after-join-frame31.png'), afterJoin), writeFile(join(proof, 'final-word-frame299.png'), final)]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native sixty-second three-cut Clean rendering stays bounded and removes all caption scratch files', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-caption-maximum-'));
  try {
    const sourcePath = await sourceFixture(directory, 71);
    const plan: ShortVideoContent = { status: 'ok', segments: [{ startSeconds: 0, endSeconds: 20 }, { startSeconds: 25, endSeconds: 45 }, { startSeconds: 50, endSeconds: 70 }] };
    const words = plan.segments.flatMap(segment => Array.from({ length: 80 }, (_, index) => ({ text: index % 12 === 11 ? 'source.' : ['Keep', 'the', 'original', 'meaning', 'and', 'context'][index % 6]!, start: segment.startSeconds + index * 0.25, end: segment.startSeconds + (index + 1) * 0.25 })));
    const transcript = { text: words.map(word => word.text).join(' '), words };
    const metricsPath = join(directory, 'ffmpeg-time.txt');
    let ffmpegPath = process.env.FFMPEG_PATH!;
    if (process.platform === 'darwin') {
      ffmpegPath = join(directory, 'timed-ffmpeg');
      await writeFile(ffmpegPath, `#!/bin/sh\n/usr/bin/time -l ${quote(process.env.FFMPEG_PATH!)} "$@" 2>${quote(metricsPath)}\nresult=$?\ncat ${quote(metricsPath)} >&2\nexit "$result"\n`, { mode: 0o700 });
    }
    let scratch: string | undefined;
    let facts: Record<string, unknown> = {};
    let pngCount = 0;
    let pngBytes = 0;
    const started = Date.now();
    let peakNodeRss = process.memoryUsage().rss;
    const sample = setInterval(() => { peakNodeRss = Math.max(peakNodeRss, process.memoryUsage().rss); }, 100);
    try {
      const renderer = createVideoRenderer({ ffmpegPath, ffprobePath: process.env.FFPROBE_PATH!, readSource: () => createReadStream(sourcePath), storage: { uploadFile: async (_path, localPath) => {
        scratch = dirname(localPath);
        const names = await readdir(scratch);
        const pngs = names.filter(name => /^caption-(?:\d+|blank)\.png$/.test(name));
        pngCount = pngs.length;
        for (const name of pngs) pngBytes += (await stat(join(scratch, name))).size;
        const manifestBytes = (await stat(join(scratch, 'captions.ffconcat'))).size;
        assert.ok(pngCount <= captionLimits.phrases + 1 && pngBytes <= captionLimits.totalBytes && manifestBytes <= captionLimits.manifestBytes);
        facts = { selectedSeconds: 60, cuts: 3, words: words.length, pngCount, pngBytes, manifestBytes, videoBytes: (await stat(localPath)).size, elapsedMilliseconds: Date.now() - started, peakNodeRss, ...(process.platform === 'darwin' ? { ffmpegResourceUsage: await readFile(metricsPath, 'utf8') } : {}) };
        if (process.env.RIFLO_CAPTION_PROOF_DIR) {
          const proof = process.env.RIFLO_CAPTION_PROOF_DIR;
          await mkdir(proof, { recursive: true });
          await writeFile(join(proof, 'clean-sixty-seconds-three-cuts.mp4'), await readFile(localPath));
          await writeFile(join(proof, 'maximum-render-metrics.json'), JSON.stringify(facts, null, 2));
          await writeFile(join(proof, 'maximum-render-frame.png'), await frame(localPath, 899));
        }
      }, remove: async () => assert.fail('No failed upload') } });
      const controls = resolveGenerationControls({ formats: { short_videos: { captions: 'clean' } } }, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, { status: 'resolved', defaults: {} });
      const assets = await renderer(plan, { project: { uid: 'fixture', id: 'maximum', storagePath: 'source', source: { durationSeconds: 71 } }, batch: { controls }, slot: { id: 'clip' }, attempt: 1 } as GenerationClaim, transcript, new AbortController().signal);
      assert.ok(Math.abs(assets[0]!.durationSeconds! - 60) <= 0.1);
    } catch (error) { console.error(await readFile(metricsPath, 'utf8').catch(() => 'No encoder metrics')); throw error; } finally { clearInterval(sample); }
    assert.ok(scratch);
    await assert.rejects(access(scratch!), { code: 'ENOENT' });
    assert.ok(pngCount > 10 && pngBytes > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancelling the native caption encoder kills its owned subprocess and removes caption scratch', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-caption-abort-'));
  const controller = new AbortController();
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    const sourcePath = await sourceFixture(directory, 60);
    const marker = join(directory, 'encoder-started');
    const encoder = join(directory, 'owned-encoder');
    await writeFile(encoder, `#!/bin/sh\nfor last do :; done\nprintf '%s' "$last" > ${quote(marker)}\nexec ${quote(process.env.FFMPEG_PATH!)} "$@"\n`, { mode: 0o700 });
    let scratch: string | undefined;
    poll = setInterval(() => { void readFile(marker, 'utf8').then(path => { scratch = dirname(path); controller.abort(); }).catch(() => undefined); }, 10);
    const controls = resolveGenerationControls({ formats: { short_videos: { captions: 'clean' } } }, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, { status: 'resolved', defaults: {} });
    const renderer = createVideoRenderer({ ffmpegPath: encoder, ffprobePath: process.env.FFPROBE_PATH!, readSource: () => createReadStream(sourcePath), storage: { uploadFile: async () => assert.fail('Cancelled encode cannot upload'), remove: async () => assert.fail('No upload was started') } });
    await assert.rejects(renderer({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 60 }] }, { project: { uid: 'fixture', id: 'abort', storagePath: 'source', source: { durationSeconds: 60 } }, batch: { controls }, slot: { id: 'clip' }, attempt: 1 } as GenerationClaim, { text: 'Original speech.', words: [{ text: 'Original speech.', start: 0, end: 60 }] }, controller.signal), { code: 'video_render_failed' });
    assert.ok(controller.signal.aborted && scratch);
    await assert.rejects(access(scratch!), { code: 'ENOENT' });
  } finally {
    if (poll) clearInterval(poll);
    await rm(directory, { recursive: true, force: true });
  }
});
