import assert from 'node:assert/strict';
import test from 'node:test';
import { shortVideoDuration, validateShortVideo, validateTranscript } from '../../src/generation/validation.js';
import type { Transcript } from '../../src/generation/service.js';

const transcript: Transcript = {
  text: 'A complete opening, explanation and takeaway.',
  words: Array.from({ length: 90 }, (_, index) => ({ text: `word${index}`, start: index, end: index + 1 })),
};
const segment = (startSeconds: number, endSeconds: number) => ({ startSeconds, endSeconds });
const select = (segments: unknown[]) => ({ status: 'ok', segments });

test('clip plans preserve ordered excerpts and measure delivered duration rather than the source envelope', () => {
  const plan = select([segment(1, 5), segment(20, 23), segment(40, 43)]);
  const checked = validateShortVideo(plan, transcript, 90);
  assert.deepEqual(checked.content, plan);
  assert.equal(shortVideoDuration(checked.content), 10);
  assert.equal(checked.text, 'Original video clip: 1–5, 20–23, 40–43 seconds');
  assert.equal(shortVideoDuration(validateShortVideo(select([segment(0, 30), segment(40, 70)]), transcript, 90).content), 60);
});

test('saved single-range plans normalize without requiring a data migration', () => {
  assert.deepEqual(validateShortVideo({ status: 'ok', startSeconds: 2, endSeconds: 12 }, transcript, 90).content,
    select([segment(2, 12)]));
  for (const value of [{ status: 'insufficient_source', segments: [] }, { status: 'insufficient_source', startSeconds: null, endSeconds: null }]) {
    assert.throws(() => validateShortVideo(value, transcript, 90), { code: 'insufficient_source', status: 422, retryable: false });
  }
});

test('invalid multi-cut plans cannot reorder, repeat, overlap or escape timing and response bounds', () => {
  const invalid = [
    select([]), select([segment(0, 3), segment(5, 8), segment(10, 13), segment(15, 18)]),
    select([segment(10, 16), segment(0, 5)]), select([segment(0, 6), segment(5, 10)]),
    select([segment(0, 10), segment(0, 10)]), select([segment(0, 5), segment(10, 14)]),
    select([segment(0, 31), segment(40, 70)]), select([segment(0, 0), segment(1, 12)]),
    select([segment(-1, 10)]), select([segment(80, 91)]), select([segment(NaN, 10)]),
    select([segment(0, Infinity)]), select([segment(0.25, 11)]), select([segment(0, 10.25)]),
    select([{ startSeconds: '0', endSeconds: 10 }]), select([{ ...segment(0, 10), command: 'publish' }]),
    { ...select([segment(0, 10)]), startSeconds: 0, endSeconds: 10 },
    { status: 'insufficient_source', segments: [segment(0, 10)] },
    { status: 'insufficient_source', startSeconds: null, endSeconds: 10 },
    { status: 'other', segments: [segment(0, 10)] }, { status: 'ok', segments: null },
  ];
  for (const value of invalid) {
    assert.throws(() => validateShortVideo(value, transcript, 90), { code: 'invalid_generated_output' }, JSON.stringify(value));
  }
  assert.throws(() => validateShortVideo(select([segment(0, 10)]), transcript, NaN), { code: 'invalid_generated_output' });
});

test('each excerpt must follow valid word timing, not merely match two endpoint numbers', () => {
  const broken = { text: 'The timing inside this thought is invalid.', words: [
    { text: 'first', start: 0, end: 1 }, { text: 'middle', start: 7, end: 8 },
    { text: 'backwards', start: 3, end: 4 }, { text: 'last', start: 9, end: 10 },
  ] };
  assert.throws(() => validateShortVideo(select([segment(0, 10)]), broken, 10), { code: 'invalid_generated_output' });
});


test('fractional word boundaries use the combined duration at both limits', () => {
  for (const total of [10, 60]) {
    const segments = [segment(0.125, 3.375), segment(20.25, 20.25 + total - 3.25)];
    const fractional = { text: 'A complete pair of excerpts.', words: segments.flatMap(({ startSeconds, endSeconds }) => [
      { text: 'A', start: startSeconds, end: startSeconds + 0.25 },
      { text: 'thought.', start: endSeconds - 0.25, end: endSeconds },
    ]) };
    assert.equal(shortVideoDuration(validateShortVideo(select(segments), fractional, 90).content), total);
  }
});


test('overlapping speech timings stay usable without cutting any selected word', () => {
  const overlapping = { text: 'A complete thought with overlapping word timings.', words: [
    { text: 'first', start: 0, end: 2 }, { text: 'overlap', start: 1, end: 1.5 },
    { text: 'last', start: 2, end: 10 },
  ] };
  assert.deepEqual(validateShortVideo(select([segment(0, 10)]), validateTranscript(overlapping, 10), 10).content, select([segment(0, 10)]));
  const clipped = { ...overlapping, words: [{ text: 'first', start: 0, end: 11 }, ...overlapping.words.slice(1)] };
  assert.throws(() => validateShortVideo(select([segment(0, 10)]), clipped, 11), (error: any) =>
    error.validation.reason === 'word_crosses_boundary' && error.validation.field === 'endSeconds');
});

test('adjacent excerpts do not reuse words with duplicate boundary timestamps', () => {
  const duplicate = { text: 'Two complete adjacent excerpts.', words: [
    { text: 'first', start: 0, end: 10 }, { text: 'boundary', start: 10, end: 10 },
    { text: 'second', start: 10, end: 20 },
  ] };
  const plan = select([segment(0, 10), segment(10, 20)]);
  assert.deepEqual(validateShortVideo(plan, duplicate, 20).content, plan);
});

test('nonexistent model endpoints remain rejected with safe endpoint-specific diagnostics', () => {
  const precise = { text: 'A thought whose boundaries must not be invented.', words: [
    { text: 'first', start: 0.30000000000000004, end: 1 }, { text: 'last', start: 10, end: 10.3 },
  ] };
  for (const [range, field] of [[segment(0.3, 10.3), 'startSeconds'], [segment(0.30000000000000004, 10.31), 'endSeconds']] as const) {
    assert.throws(() => validateShortVideo(select([range]), precise, 11), (error: any) =>
      error.code === 'invalid_generated_output' && error.validation.reason === 'word_boundary' && error.validation.field === field);
  }
  assert.deepEqual(validateShortVideo(select([segment(0.30000000000000004, 10.3)]), precise, 11).content,
    select([segment(0.30000000000000004, 10.3)]));
});


test('cut endpoints cannot split an overlapping source word omitted from the selected slice', () => {
  for (const [words, range, field] of [
    [[{ text: 'first', start: 0, end: 10 }, { text: 'overlap', start: 9, end: 11 }, { text: 'last', start: 11, end: 20 }], segment(0, 10), 'endSeconds'],
    [[{ text: 'first', start: 0, end: 2 }, { text: 'selected', start: 1, end: 2 }, { text: 'last', start: 10, end: 11 }], segment(1, 11), 'startSeconds'],
  ] as const) {
    const source = { text: 'Overlapping speech must not be cut midway.', words: [...words] };
    assert.throws(() => validateShortVideo(select([range]), source, 20), (error: any) =>
      error.validation.reason === 'word_crosses_boundary' && error.validation.field === field);
  }
});
