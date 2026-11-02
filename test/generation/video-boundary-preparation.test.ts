import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transcript } from '../../src/generation/service.js';
import { prepareShortVideoSelection, shortVideoBoundaries, prepareProviderShortVideoSelection, validateShortVideo } from '../../src/generation/validation.js';

const transcript = (ranges: Array<[number, number]>): Transcript => ({
  text: 'Source words.',
  words: ranges.map(([start, end]) => ({ text: 'word.', start, end })),
});
const selection = (...ranges: Array<[number, number]>) => ({
  status: 'ok',
  segments: ranges.map(([startSeconds, endSeconds]) => ({ startSeconds, endSeconds })),
});
const invalid = { code: 'invalid_generated_output' };
const endpoints = (...args: Parameters<typeof shortVideoBoundaries>) => { const { startSeconds, endSeconds } = shortVideoBoundaries(...args); return { startSeconds, endSeconds }; };

test('preparation rejects the actual orphan opening and unfinished ending instead of adding speech', () => {
  // Exact neighboring ASR words from the finished-output source; the chosen speech
  // starts at "I" and ends at "insanely.", but both timestamps intersect other words.
  const source: Transcript = { text: 'taste. I think insanely. Apple also does', words: [
    { text: 'taste.', start: 206.39, end: 207.19 },
    { text: 'I', start: 207.02501, end: 207.265 },
    { text: 'think', start: 207.265, end: 207.585 },
    { text: 'insanely.', start: 259.34, end: 260.7 },
    { text: 'Apple', start: 260.095, end: 260.495 },
    { text: 'also', start: 260.495, end: 260.895 },
    { text: 'does', start: 260.895, end: 261.055 },
  ] };
  for (const [input, field] of [
    [selection([207.02501, 261.055]), 'startSeconds'],
    [selection([206.39, 260.7]), 'endSeconds'],
  ] as const) {
    const before = structuredClone(input);
    for (const validate of [prepareShortVideoSelection, validateShortVideo]) {
      assert.throws(() => validate(input, source, 300), (error: any) =>
        error.code === 'invalid_generated_output' && error.validation.reason === 'word_crosses_boundary' && error.validation.field === field);
    }
    assert.deepEqual(input, before);
  }
});

test('preparation rejects even small overlaps and overlap chains at either endpoint', () => {
  for (const [ranges, input] of [
    [[[9.25, 9.6], [9.5, 10.1], [10, 10.5], [19.5, 20]], selection([10, 20])],
    [[[0, 1], [9.5, 10], [9.999, 10.001]], selection([0, 10])],
  ] as Array<[Array<[number, number]>, ReturnType<typeof selection>]>) {
    assert.throws(() => prepareShortVideoSelection(input, transcript(ranges), 30), invalid);
  }
});

test('duplicate word timings and touching word boundaries need no expansion', () => {
  const duplicates = transcript([[0, 1], [0, 1], [9, 10], [9, 10]]);
  assert.deepEqual(prepareShortVideoSelection(selection([0, 10]), duplicates, 20).content, selection([0, 10]));
  const touching = transcript([[0, 1], [1, 2], [10, 11], [11, 12]]);
  assert.deepEqual(prepareShortVideoSelection(selection([1, 11]), touching, 20).content, selection([1, 11]));
});

test('preparation never snaps an invented endpoint to a nearby word timestamp', () => {
  const source = transcript([[0, 1], [10, 11]]);
  for (const input of [selection([0.001, 11]), selection([0, 10.999])]) {
    assert.throws(() => prepareShortVideoSelection(input, source, 20), invalid);
  }
});

test('hard duration limits apply to the exact selected speech, without padding', () => {
  const source = transcript([[0, 1], [9, 9.5], [10, 11], [59, 60], [60, 61]]);
  assert.deepEqual(prepareShortVideoSelection(selection([0, 60]), source, 70).content, selection([0, 60]));
  for (const input of [selection([0, 9.5]), selection([0, 61])]) {
    assert.throws(() => prepareShortVideoSelection(input, source, 70), (error: any) => error.validation.reason === 'duration_limit');
  }
});

test('separately selected segments cannot cut through overlapping words', () => {
  const source = transcript([[0, 1], [9, 10], [9.5, 10.5], [10.25, 11], [19, 20]]);
  assert.throws(() => prepareShortVideoSelection(selection([0, 10], [10.25, 20]), source, 30), invalid);
});

test('preparation retains segment count, chronology and source bounds checks', () => {
  const source = transcript([[0, 1], [3, 4], [10, 11], [13, 14], [20, 21], [23, 24], [30, 31], [33, 34]]);
  const three = selection([0, 4], [10, 14], [20, 24]);
  assert.deepEqual(prepareShortVideoSelection(three, source, 40).content, three);
  for (const input of [selection(), selection([0, 4], [10, 14], [20, 24], [30, 34]), selection([10, 14], [0, 4]), selection([-1, 14]), selection([0, 41])]) {
    assert.throws(() => prepareShortVideoSelection(input, source, 40), invalid);
  }
  const pastEnd = transcript([[0, 1], [19, 20], [19.5, 20.5]]);
  assert.throws(() => prepareShortVideoSelection(selection([0, 20]), pastEnd, 20), invalid);
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.throws(() => prepareShortVideoSelection(selection([0, 14]), source, duration));
  }
});

test('malformed source timings are rejected before preparing a selection', () => {
  const input = selection([0, 11]);
  const malformed = [
    { text: '', words: [{ text: 'word', start: 0, end: 11 }] },
    transcript([[0, 1], [10, NaN]]),
    transcript([[10, 11], [0, 1]]),
    transcript([[0, 1], [12, 11]]),
  ];
  for (const source of malformed) {
    assert.throws(() => prepareShortVideoSelection(input, source, 20), { code: 'invalid_transcript' });
  }
});

test('safe legacy single-range selections are normalized without changing endpoints', () => {
  const source = transcript([[0, 1], [10, 11]]);
  assert.deepEqual(prepareShortVideoSelection({ status: 'ok', startSeconds: 0, endSeconds: 11 }, source, 20).content, selection([0, 11]));
});

test('boundary checks are timing-based across languages, punctuation and unpunctuated ASR', () => {
  for (const [opening, closing] of [['你好', '完成。'], ['“Hello', 'done!”'], ['नमस्ते', 'समाप्त।'], ['hello', 'done']]) {
    const source: Transcript = { text: `${opening} ${closing}`, words: [
      { text: opening!, start: 1, end: 2 }, { text: closing!, start: 10, end: 11 },
    ] };
    const input = selection([1, 11]);
    assert.deepEqual(prepareShortVideoSelection(input, source, 20).content, input);
    const overlap = { ...source, words: [...source.words, { text: 'next', start: 10.9, end: 11.1 }] };
    assert.throws(() => prepareShortVideoSelection(input, overlap, 20), (error: any) => error.validation.reason === 'word_crosses_boundary');
  }
});


test('allowed timestamp enums exclude overlaps but retain exact touching and duplicate boundaries', () => {
  const source = transcript([[0, 2], [1, 1.5], [2, 3], [2, 3], [9.5, 10], [9.8, 10.5], [11, 12]]);
  assert.deepEqual(endpoints(source, 12), { startSeconds: [0, 2, 9.5, 11], endSeconds: [2, 3, 10.5, 12] });
  const controls = { sourceWindow: { startSeconds: 1, endSeconds: 11 } } as Parameters<typeof shortVideoBoundaries>[2];
  assert.deepEqual(endpoints(source, 12, controls), { startSeconds: [2, 9.5], endSeconds: [3, 10.5] });
  // A final ASR word can extend past the probed duration; it must not become an enum choice.
  assert.deepEqual(endpoints(transcript([[0, 1], [9, 10.5]]), 10), { startSeconds: [0], endSeconds: [1] });
});

test('boundary enumeration agrees with full interval checks on nested, chained and zero-length words', () => {
  const source = transcript([[0, 20], [1, 2], [2, 3], [3, 3], [19, 21], [21, 21], [21, 22], [30, 40]]);
  const safe = (time: number) => !source.words.some(word => word.start < time && word.end > time);
  assert.deepEqual(endpoints(source, 40), {
    startSeconds: [...new Set(source.words.map(word => word.start).filter(safe))],
    endSeconds: [...new Set(source.words.map(word => word.end).filter(safe))],
  });
});

test('provider sentence choices reject the observed interior cuts while retaining spanning context', () => {
  const source: Transcript = { text: 'Full context.', words: [
    { text: 'Setup', start: 196.79001, end: 204.47 },
    { text: 'taste.', start: 206.39, end: 207.19 },
    { text: 'I', start: 207.02501, end: 207.265 },
    { text: 'think', start: 207.265, end: 207.585 },
    { text: 'animation.', start: 246.295, end: 246.855 },
    { text: 'Delight', start: 246.855, end: 250 },
    { text: 'insanely.', start: 259.34, end: 260.7 },
    { text: 'Apple', start: 260.095, end: 260.495 },
    { text: 'also', start: 260.495, end: 260.895 },
    { text: 'does', start: 260.895, end: 261.055 },
    { text: 'this.', start: 262.01498, end: 262.415 },
  ] };
  const choices = shortVideoBoundaries(source, 300);
  assert.deepEqual(choices.startSeconds, [196.79001, 246.855]);
  assert.deepEqual(choices.endSeconds, [246.855, 262.415]);
  assert.equal(choices.sentences[1]![0], null); // Never shift "I" to "think".
  assert.equal(choices.sentences[2]![1], null); // Never shift "insanely" to "also".
  const full = selection([196.79001, 246.855]);
  assert.deepEqual(prepareProviderShortVideoSelection(full, source, 300, choices).content, full);
  const interior = selection([207.265, 260.895]);
  assert.deepEqual(validateShortVideo(interior, source, 300).content, interior); // Saved plans keep their existing contract.
  assert.throws(() => prepareProviderShortVideoSelection(interior, source, 300, choices), (error: any) => error.validation.reason === 'word_boundary');
});

test('sentence choices keep multilingual closing punctuation and decimal text without inventing window edges', () => {
  for (const terminal of ['done.”', 'done!)', '完成。', '完成！」', 'انتهى؟', 'समाप्त।', 'समाप्त॥']) {
    const source: Transcript = { text: `Value 3.14 ${terminal}`, words: [
      { text: 'Value', start: 0, end: 1 }, { text: '3.14', start: 1, end: 2 }, { text: terminal, start: 10, end: 11 },
    ] };
    const choices = shortVideoBoundaries(source, 20);
    assert.deepEqual(choices.startSeconds, [0]);
    assert.deepEqual(choices.endSeconds, [11]);
    const window = { sourceWindow: { startSeconds: 1, endSeconds: 15 } } as Parameters<typeof shortVideoBoundaries>[2];
    assert.throws(() => shortVideoBoundaries(source, 20, window), { code: 'source_window_conflict' });
  }
  const unpunctuated = { text: 'Hello world', words: [{ text: 'Hello', start: 0, end: 1 }, { text: 'world', start: 10, end: 11 }] };
  assert.throws(() => shortVideoBoundaries(unpunctuated, 20), { code: 'insufficient_source' });
  const trailing = { text: 'Done. unfinished', words: [{ text: 'Done.', start: 0, end: 11 }, { text: 'unfinished', start: 12, end: 14 }] };
  assert.deepEqual(shortVideoBoundaries(trailing, 20).sentences, [[0, 11, 'Done.'], [null, null, 'unfinished']]);
});
