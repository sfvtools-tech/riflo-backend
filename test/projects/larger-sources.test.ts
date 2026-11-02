import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourcePreparer } from '../../src/projects/adapters.js';
import { createAudioExtractor } from '../../src/generation/audio.js';
import { createVideoRenderer } from '../../src/generation/video.js';
import { sourcePlanLimits, sourceAudioBytes } from '../../src/access/source-limits.js';
import type { Project } from '../../src/projects/service.js';
import type { GenerationClaim } from '../../src/generation/service.js';

const execute = promisify(execFile);
const native = { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH, timeout: 90000 };
const signal = () => new AbortController().signal;
async function duration(path: string) {
  const { stdout } = await execute(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path], { timeout: 10000 });
  return Number(JSON.parse(stdout).format.duration);
}
async function recording(path: string, seconds: number) {
  await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=32x32:r=1:d=${seconds}`, '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '51', '-c:a', 'aac', '-b:a', '8k', '-shortest', path], { timeout: 30000, maxBuffer: 65536 });
}

test('a tiny one-hour source keeps its full timeline, extracts full bounded audio, and renders after minute thirty', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-long-native-'));
  try {
    const path = join(directory, 'hour.mp4');
    await recording(path, 3600);
    assert.ok((await stat(path)).size < 5000000, 'the duration fixture must stay small');
    const prepared = await createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(path, signal(), sourcePlanLimits.higher);
    assert.equal(prepared.durationSeconds, 3600);
    await assert.rejects(createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(path, signal(), sourcePlanLimits.lower), { code: 'source_too_long' });
    const project = { id: 'long-source', uid: 'fixture', storagePath: 'private-source', sourceLimits: { ...sourcePlanLimits.higher }, source: { durationSeconds: prepared.durationSeconds } } as Project;
    const audio = await createAudioExtractor({ ffmpegPath: process.env.FFMPEG_PATH!, readSource: () => createReadStream(path) })(project, signal());
    try {
      const bytes = (await stat(audio.path)).size;
      assert.ok(bytes > 115000000 && bytes <= sourceAudioBytes(sourcePlanLimits.higher));
      assert.equal(await duration(audio.path), 3600);
    } finally { await audio.cleanup(); }
    let uploaded = false;
    const renderer = createVideoRenderer({ ffmpegPath: process.env.FFMPEG_PATH!, ffprobePath: process.env.FFPROBE_PATH!, readSource: () => createReadStream(path), storage: {
      uploadFile: async (_storage, local) => { assert.ok(Math.abs(await duration(local) - 10) <= 0.1); uploaded = true; }, remove: async () => undefined,
    } });
    const transcript = { text: 'This is the late excerpt.', words: [{ text: 'This', start: 3500, end: 3501 }, { text: 'excerpt.', start: 3509, end: 3510 }] };
    const assets = await renderer({ status: 'ok', segments: [{ startSeconds: 3500, endSeconds: 3510 }] }, { project, slot: { id: 'late-clip' }, attempt: 1 } as GenerationClaim, transcript, signal());
    assert.equal(uploaded, true);
    assert.equal(assets.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual packet timestamps reject a source whose container durations falsely claim a short recording', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-forged-duration-'));
  try {
    const path = join(directory, 'forged.mp4');
    await recording(path, 3);
    const bytes = await readFile(path);
    // Keep real encoded samples/table timestamps, but forge all version-zero duration headers.
    for (const name of ['mvhd', 'mdhd']) {
      let index = -1;
      while ((index = bytes.indexOf(name, index + 1, 'ascii')) >= 0) {
        assert.equal(bytes[index + 4], 0);
        const scale = bytes.readUInt32BE(index + 16);
        bytes.writeUInt32BE(scale, index + 20);
      }
    }
    let index = -1;
    while ((index = bytes.indexOf('tkhd', index + 1, 'ascii')) >= 0) bytes.writeUInt32BE(1000, index + 24);
    await writeFile(path, bytes);
    assert.ok(await duration(path) <= 1.1, 'the forged container must report an in-cap duration');
    await assert.rejects(createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(path, signal(), { maxSourceSeconds: 2, maxSourceBytes: 1000000 }), { code: 'source_too_long', retryable: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('transport remux is stopped by the accepted output byte ceiling', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-remux-cap-'));
  try {
    const input = join(directory, 'input.mp4');
    const transport = join(directory, 'input.ts');
    await recording(input, 3);
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', input, '-c', 'copy', '-f', 'mpegts', transport], { timeout: 10000 });
    await assert.rejects(createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(transport, signal(), { maxSourceSeconds: 10, maxSourceBytes: 64 }), { code: 'source_too_large', retryable: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancelling the packet scan kills its owned probe process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-probe-abort-'));
  const executable = join(directory, 'ffprobe');
  const pidPath = join(directory, 'pid');
  try {
    await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.includes('-show_packets')) { fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdout.write('0,0,1\\n'); setInterval(() => {}, 1000); } else { console.log(JSON.stringify({streams:[{codec_type:'video',width:32,height:32,avg_frame_rate:'30/1',r_frame_rate:'30/1'}],format:{duration:'10',format_name:'mov',tags:{major_brand:'isom'}}})); }\n`, { mode: 0o755 });
    const controller = new AbortController();
    const pending = createSourcePreparer(executable)('fixture', controller.signal, sourcePlanLimits.higher);
    void pending.catch(() => undefined);
    let pid: number | undefined;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidPath, 'utf8')); if (pid) break; } catch { /* Wait for this owned subprocess. */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(pid, 'the owned packet probe must start');
    controller.abort();
    await assert.rejects(pending, { code: 'import_interrupted', retryable: true });
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
