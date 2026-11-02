import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { captionLimits, prepareCaptions } from '../../src/generation/captions.js';
import type { ShortVideoContent, Transcript } from '../../src/generation/service.js';
import { shortVideoSentences, transcriptWordSeparators } from '../../src/generation/short-video-source.js';

const plan: ShortVideoContent = { status: 'ok', segments: [{ startSeconds: 0, endSeconds: 1.017 }, { startSeconds: 3, endSeconds: 12.017 }] };
const source: Transcript = { text: 'First. Excluded. Second. Final.', words: [{ text: 'First.', start: 0, end: 1.017 }, { text: 'Excluded.', start: 2, end: 2.5 }, { text: 'Second.', start: 3, end: 4 }, { text: 'Final.', start: 11.5, end: 12.017 }] };
async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-captions-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('captions and sentence evidence preserve provider token spacing across scripts', async () => {
  for (const [text, tokens] of [
    ['你好世界。', ['你好', '世界', '。']],
    ['ภาษาไทยดี。', ['ภาษา', 'ไทย', 'ดี', '。']],
    ['今日は OpenAI です。', ['今日', 'は', 'OpenAI', 'です', '。']],
    ['한국어 문장입니다.', ['한국어', '문장입니다.']],
    ['Go, go again.', ['Go', ',', 'go', 'again', '.']],
    ['世界 世界。', ['世界', '世界', '。']],
  ] as const) {
    const transcript = { text, words: tokens.map((text, index) => ({ text, start: index * 0.1, end: (index + 1) * 0.1 })) };
    assert.equal(shortVideoSentences(transcript).map(sentence => sentence.text).join(''), text);
    await withDirectory(async directory => {
      const { cues } = await prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 2 }] }, transcript, directory, new AbortController().signal);
      assert.deepEqual(cues.map(cue => cue.lines), [[text]]);
    });
  }
  for (const text of ['Hello, world.', 'Hello missing world.', 'Hello world. extra']) {
    const words = [{ text: 'Hello', start: 0, end: 0.1 }, { text: 'world.', start: 0.1, end: 0.2 }];
    assert.deepEqual(transcriptWordSeparators({ text, words }), [' ', ' ']);
    assert.equal(shortVideoSentences({ text, words })[0]!.text, 'Hello world.');
  }
  assert.deepEqual(transcriptWordSeparators({ text: '  Hello\n world. ', words: [{ text: ' Hello ', start: 0, end: 1 }, { text: 'world.', start: 1, end: 2 }] }), ['', ' ']);
});

test('wrapped captions retain paragraph direction for Arabic, Hebrew and Latin continuations', async () => {
  // Compare the final line to an independently directed Pango render, ignoring transparent padding.
  async function whiteMask(bytes: Buffer, lastRows?: number) {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width, right = -1, top = info.height, bottom = -1;
    const white = (x: number, y: number) => { const offset = (y * info.width + x) * 4; return data[offset]! > 250 && data[offset + 3]! > 250; };
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (white(x, y)) bottom = y;
    for (let y = lastRows ? bottom - lastRows + 1 : 0; y <= bottom; y++) for (let x = 0; x < info.width; x++) if (white(x, y)) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); }
    assert.ok(right >= left && bottom >= top);
    const mask = [];
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) mask.push(Number(white(x, y)));
    return { width: right - left + 1, height: bottom - top + 1, mask };
  }
  for (const [text, direction] of [
    ['مرحبا بكم في هذا العالم OpenAI 123.', '\u200f'],
    ['مرحبا بكم في هذا العالم الجميل OpenAI 123.', '\u200f'],
    ['שלום חברים בעולם OpenAI 123.', '\u200f'],
    ['Hello good people around world OpenAI 123.', '\u200e'],
  ] as const) {
    await withDirectory(async directory => {
      const words = text.split(' ').map((text, index) => ({ text, start: index * 0.1, end: (index + 1) * 0.1 }));
      const { cues } = await prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 2 }] }, { text, words }, directory, new AbortController().signal);
      assert.equal(cues.length, 1);
      assert.equal(cues[0]!.lines.length, 2);
      const reference = await sharp({ text: { text: `<span foreground="#ffffff">${direction}${cues[0]!.lines[1]}</span>`, font: 'Noto Sans Bold 44', dpi: 72, rgba: true, wrap: 'none' } }).png().toBuffer();
      const expected = await whiteMask(reference);
      const actual = await whiteMask(await readFile(join(directory, 'caption-0.png')), expected.height);
      assert.equal(actual.width, expected.width);
      assert.equal(actual.height, expected.height);
      assert.ok(actual.mask.filter((value, index) => value !== expected.mask[index]).length / actual.mask.length < 0.01);
    });
  }
});

test('captions rebase exact segment offsets, never span joins and show the final word on an existing frame', async () => {
  await withDirectory(async directory => {
    const result = await prepareCaptions(plan, source, directory, new AbortController().signal);
    assert.deepEqual(result.cues.map(cue => cue.lines.join(' ')), ['First.', 'Second.', 'Final.']);
    assert.equal(result.cues[0]!.endFrame, 31);
    assert.equal(result.cues[1]!.startFrame, 31);
    assert.equal(result.cues.at(-1)!.endFrame, 300);
    assert.ok(result.cues.at(-1)!.startFrame < 299);
    const manifest = await readFile(result.path, 'utf8');
    assert.match(manifest, /^ffconcat version 1.0/);
    assert.match(manifest, /duration 1\.033333333/);
    assert.match(manifest, /file caption-blank.png\noption framerate 30\n$/);
    assert.doesNotMatch(manifest, /First|Second|Excluded|http|\/\//);
    for (const line of manifest.split('\n').filter(line => line.startsWith('file '))) assert.match(line, /^file caption-(?:blank|\d+)\.png$/);
    assert.ok(Buffer.byteLength(manifest) <= captionLimits.manifestBytes);
  });
});

test('overlapping ASR words share frames deterministically without dropping their text', async () => {
  const transcript = { text: 'One. Two. Three.', words: [{ text: 'One.', start: 0, end: 3 }, { text: 'Two.', start: 1, end: 4 }, { text: 'Three.', start: 2, end: 5 }] };
  await withDirectory(async directory => {
    const { cues } = await prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 5 }] }, transcript, directory, new AbortController().signal);
    assert.deepEqual(cues.map(cue => [cue.startFrame, cue.endFrame, cue.lines.join(' ')]), [[0, 50, 'One.'], [50, 100, 'Two.'], [100, 150, 'Three.']]);
  });
});

test('fixed-size captions normalize whitespace, escape markup and split long words at grapheme boundaries', async () => {
  const text = 'Family 👨‍👩‍👧‍👦 & <source> “quote” हिंदी العربية 中文';
  const token = 'W'.repeat(100);
  const transcript = { text, words: [{ text: text.replaceAll(' ', '\n '), start: 0, end: 5 }, { text: token, start: 5, end: 10 }] };
  await withDirectory(async directory => {
    const { cues } = await prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 10 }] }, transcript, directory, new AbortController().signal);
    assert.ok(cues.every(cue => cue.lines.length <= 2 && cue.endFrame > cue.startFrame));
    assert.equal(cues.flatMap(cue => cue.lines).join('').replaceAll(' ', ''), (text + token).replaceAll(' ', ''));
    assert.ok(cues.flatMap(cue => cue.lines).some(line => line.includes('👨‍👩‍👧‍👦')));
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.png'))) {
      const bytes = await readFile(join(directory, name));
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 648); assert.equal(metadata.height, 160);
      assert.ok(bytes.length <= captionLimits.pngBytes);
    }
  });
});

test('caption bounds and cancellation fail before output instead of silently dropping speech', async () => {
  for (const text of ['broken \ud800', '\u0000', ' ', 'a'.repeat(201)]) {
    await withDirectory(async directory => {
      await assert.rejects(prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 10 }] }, { text, words: [{ text, start: 0, end: 10 }] }, directory, new AbortController().signal), { code: 'caption_render_failed' });
      assert.deepEqual(await readdir(directory), []);
    });
  }
  await withDirectory(async directory => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareCaptions(plan, source, directory, controller.signal), { name: 'AbortError' });
    assert.deepEqual(await readdir(directory), []);
  });
});

test('caption preparation rejects excess words or phrases and observes cancellation during layout', async () => {
  for (const [count, text] of [[601, 'a'], [241, 'Done.']] as const) {
    await withDirectory(async directory => {
      const words = Array.from({ length: count }, (_, index) => ({ text, start: index * 60 / count, end: (index + 1) * 60 / count }));
      await assert.rejects(prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 60 }] }, { text: '', words }, directory, new AbortController().signal), { code: 'caption_render_failed' });
      assert.deepEqual(await readdir(directory), []);
    });
  }
  await withDirectory(async directory => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5);
    try {
      const words = Array.from({ length: 600 }, (_, index) => ({ text: 'readable', start: index / 10, end: (index + 1) / 10 }));
      await assert.rejects(prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 60 }] }, { text: '', words }, directory, controller.signal), { name: 'AbortError' });
    } finally { clearTimeout(timer); }
  });
});

test('an instantaneous word at adjacent cuts belongs once to the first cut and does not delay the next word', async () => {
  const words = [
    { text: 'Start.', start: 0, end: 1 },
    { text: 'End.', start: 9, end: 10 },
    { text: 'Zero.', start: 10, end: 10 },
    { text: 'Next.', start: 10, end: 11 },
    { text: 'Last.', start: 19, end: 20 },
  ];
  await withDirectory(async directory => {
    const { cues } = await prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 10 }, { startSeconds: 10, endSeconds: 20 }] }, { text: '', words }, directory, new AbortController().signal);
    assert.deepEqual(cues.map(cue => cue.lines.join(' ')), ['Start.', 'End.', 'Zero.', 'Next.', 'Last.']);
    assert.ok(cues.find(cue => cue.lines[0] === 'Zero.')!.endFrame <= 300);
    assert.equal(cues.find(cue => cue.lines[0] === 'Next.')!.startFrame, 300);
  });
});
