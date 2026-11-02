import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAudioExtractor } from '../../src/generation/audio.js';
import type { Project } from '../../src/projects/service.js';

test('audio preparation uses bounded local mono WAV conversion and deletes its temporary files', async () => {
  const originalFlag = process.env.RIFLO_WORKER_TRACE;
  const originalInfo = console.info;
  const messages: string[] = [];
  process.env.RIFLO_WORKER_TRACE = '1';
  console.info = (...values: unknown[]) => { messages.push(values.join(' ')); };
  const directory = await mkdtemp(join(tmpdir(), 'riflo-audio-test-'));
  const executable = join(directory, 'fake-ffmpeg');
  const captured = join(directory, 'arguments.json');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args));\nfs.writeFileSync(args.at(-1), 'fake-wav');\n`, { mode: 0o755 });
  const extractor = createAudioExtractor({ ffmpegPath: executable, readSource: (path) => {
    assert.equal(path, 'accounts/alice/projects/project/source/attempt-1.video');
    return Readable.from(Buffer.from('source-video'));
  } });
  try {
    const audio = await extractor({ id: 'project', storagePath: 'accounts/alice/projects/project/source/attempt-1.video' } as Project, new AbortController().signal);
    const args = JSON.parse(await readFile(captured, 'utf8')) as string[];
    assert.ok(args.includes('-nostdin'));
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-ac') + 1], '1');
    assert.equal(args[args.indexOf('-ar') + 1], '16000');
    assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
    assert.equal(args[args.indexOf('-f') + 1], 'wav');
    assert.equal(await readFile(audio.path, 'utf8'), 'fake-wav');
    assert.ok(messages.some(message => message.includes('"event":"audio.measured"') && message.includes('"sourceBytes":12') && message.includes('"audioBytes":8')));
    assert.ok(!messages.join('\n').includes('accounts/alice'));
    await audio.cleanup();
    await assert.rejects(access(dirname(audio.path)));
  } finally {
    console.info = originalInfo;
    if (originalFlag === undefined) delete process.env.RIFLO_WORKER_TRACE;
    else process.env.RIFLO_WORKER_TRACE = originalFlag;
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized extracted audio is rejected and removed before any provider call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-audio-bound-test-'));
  const executable = join(directory, 'fake-ffmpeg');
  const captured = join(directory, 'output-path');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = process.argv.at(-1);\nfs.writeFileSync(${JSON.stringify(captured)}, path);\nfs.writeFileSync(path, '');\nfs.truncateSync(path, 60000001);\n`, { mode: 0o755 });
  try {
    const extractor = createAudioExtractor({ ffmpegPath: executable, readSource: () => Readable.from(Buffer.from('video')) });
    await assert.rejects(extractor({ storagePath: 'private-source' } as Project, new AbortController().signal), { code: 'audio_extraction_failed' });
    await assert.rejects(access(dirname(await readFile(captured, 'utf8'))));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validated local source avoids storage reads and remains owned by the importer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-audio-local-test-'));
  const executable = join(directory, 'fake-ffmpeg');
  const source = join(directory, 'prepared.mp4');
  const captured = join(directory, 'arguments.json');
  await writeFile(source, 'validated-video');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args));\nfs.writeFileSync(args.at(-1), 'fake-wav');\n`, { mode: 0o755 });
  const extractor = createAudioExtractor({ ffmpegPath: executable, readSource: () => { throw new Error('Local audio must not download storage.'); } });
  const project = { id: 'project', storagePath: null, source: { bytes: 15 } } as Project;
  try {
    const audio = await extractor(project, new AbortController().signal, source);
    const args = JSON.parse(await readFile(captured, 'utf8')) as string[];
    assert.equal(args[args.indexOf('-i') + 1], source);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    await audio.cleanup();
    await assert.rejects(access(dirname(audio.path)));
    assert.equal(await readFile(source, 'utf8'), 'validated-video');
    await writeFile(source, 'changed');
    await assert.rejects(extractor(project, new AbortController().signal, source), { code: 'audio_extraction_failed' });
    assert.equal(await readFile(source, 'utf8'), 'changed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
