import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSourcePreparer } from '../../src/projects/adapters.js';
import { sourceAttemptPaths, sourcePath } from '../../src/projects/source.js';

const execute = promisify(execFile);
const native = { skip: !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH, timeout: 30_000 };

async function source(directory: string) {
  const path = join(directory, 'input.mp4');
  await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path], { timeout: 10_000 });
  return path;
}

test('source inspection identifies MP4, MOV, WebM and Matroska from bytes rather than filename', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-format-test-'));
  try {
    const input = await source(directory);
    const prepare = createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!);
    for (const extension of ['mp4', 'mov', 'webm', 'mkv'] as const) {
      const path = join(directory, `${extension}.wrong-name`);
      const format = { mp4: 'mp4', mov: 'mov', webm: 'webm', mkv: 'matroska' }[extension];
      const codecs = extension === 'webm' ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'] : ['-c', 'copy'];
      await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', input, ...codecs, '-f', format, path], { timeout: 10_000 });
      const prepared = await prepare(path, new AbortController().signal);
      assert.equal(prepared.extension, extension);
      assert.equal(prepared.path, path);
      assert.ok(prepared.durationSeconds >= 1.9 && prepared.durationSeconds < 2.3);
      assert.ok(sourceAttemptPaths('alice', 'project', 2).includes(sourcePath('alice', 'project', 2, extension)));
    }
    assert.ok(sourceAttemptPaths('alice', 'project', 2).includes('accounts/alice/projects/project/source/attempt-2.video'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MPEG-TS is remuxed into fast-start MP4 without changing video frames or losing audio', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-remux-test-'));
  try {
    const input = await source(directory);
    const transport = join(directory, 'transport.video');
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', input, '-c', 'copy', '-f', 'mpegts', transport], { timeout: 10_000 });
    const original = await readFile(transport);
    assert.equal(original[0], 0x47);
    const prepared = await createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(transport, new AbortController().signal);
    assert.equal(prepared.extension, 'mp4');
    assert.notEqual(prepared.path, transport);
    const bytes = await readFile(prepared.path);
    assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
    assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'));
    assert.ok(prepared.durationSeconds >= 1.9 && prepared.durationSeconds < 2.3);
    const { stdout } = await execute(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', prepared.path]);
    const streams = JSON.parse(stdout).streams;
    assert.ok(streams.some((stream: { codec_name: string; codec_type: string }) => stream.codec_type === 'video' && stream.codec_name === 'h264'));
    assert.ok(streams.some((stream: { codec_name: string; codec_type: string }) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    const hashes = await Promise.all([transport, prepared.path].map(async path => {
      const result = await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'framemd5', '-']);
      return result.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)?.trim());
    }));
    assert.deepEqual(hashes[0], hashes[1]);
    assert.deepEqual(await readFile(transport), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('older QuickTime without an optional file-type box remains MOV', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-quicktime-test-'));
  try {
    const input = await source(directory);
    const path = join(directory, 'legacy.video');
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-i', input, '-c', 'copy', '-f', 'mov', path], { timeout: 10_000 });
    const bytes = await readFile(path);
    const typeBox = bytes.indexOf('ftyp');
    assert.ok(typeBox >= 4);
    bytes.write('free', typeBox, 'ascii');
    await writeFile(path, bytes);
    const prepared = await createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(path, new AbortController().signal);
    assert.equal(prepared.extension, 'mov');
    assert.equal(prepared.path, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('other transport codecs remain accurately labelled and missing tools report a safe error', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-unsupported-test-'));
  try {
    const transport = join(directory, 'transport.video');
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-c:v', 'mpeg2video', '-f', 'mpegts', transport], { timeout: 10_000 });
    const prepared = await createSourcePreparer(process.env.FFPROBE_PATH!, process.env.FFMPEG_PATH!)(transport, new AbortController().signal);
    assert.equal(prepared.path, transport);
    assert.equal(prepared.extension, 'ts');
    await assert.rejects(createSourcePreparer('/missing/ffprobe')(transport, new AbortController().signal), { code: 'probe_unavailable', retryable: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createSourcePreparer(process.env.FFPROBE_PATH!)(transport, controller.signal), { code: 'import_interrupted' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unrecognized containers are rejected even if probe output claims a valid video stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-format-rejection-test-'));
  try {
    const executable = join(directory, 'probe');
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({streams:[{codec_type:'video',width:32,height:32,avg_frame_rate:'30/1',r_frame_rate:'30/1'}],format:{duration:'10',format_name:'unknown'}}));\n`);
    await chmod(executable, 0o700);
    await assert.rejects(createSourcePreparer(executable)(join(directory, 'video.mp4'), new AbortController().signal), { code: 'unsupported_video', retryable: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
