import { generationBatchLimits } from '../../src/access/policy.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSelection } from '../../src/generation/service.js';
import { validatePost, validateShortPost, validateTranscript, validateLongForm, validateCarousel, validateShortVideo } from '../../src/generation/validation.js';
import { safeValidationIssue } from '../../src/generation/diagnostics.js';
import { readGenerationConfig } from '../../src/generation/config.js';

test('X posts follow weighted limits for Unicode, emoji and shortened links', () => {
  assert.equal(validatePost({ text: 'a'.repeat(280) }, 'x_posts').length, 280);
  assert.equal(validatePost({ text: '界'.repeat(140) }, 'x_posts'), '界'.repeat(140));
  assert.equal(validatePost({ text: '👨‍👩‍👧‍👦'.repeat(140) }, 'x_posts'), '👨‍👩‍👧‍👦'.repeat(140));
  assert.equal(validatePost({ text: `${'a'.repeat(256)} https://example.com/${'b'.repeat(500)}` }, 'x_posts').startsWith('a'), true);
  for (const text of ['a'.repeat(281), '界'.repeat(141), '👨‍👩‍👧‍👦'.repeat(141)]) {
    assert.throws(() => validatePost({ text }, 'x_posts'), { code: 'invalid_generated_output' });
  }
  assert.equal(validatePost({ text: ' cafe\u0301 ' }, 'x_posts'), 'café');
});

test('posts require one plain text field and reject empty, malformed or oversized output', () => {
  assert.equal(validatePost({ text: 'a'.repeat(3000) }, 'linkedin_posts').length, 3000);
  for (const value of [null, [], 'text', {}, { text: 1 }, { text: 'hello', extra: 'field' }, { text: ' ' }, { text: '```json\n{}\n```' }, { text: 'hello\u0000world' }, { text: 'a'.repeat(3001) }]) {
    assert.throws(() => validatePost(value, 'linkedin_posts'), { code: 'invalid_generated_output' });
  }
});

test('transcripts retain private word timestamps and reject invalid or oversized timing data', () => {
  const transcript = { text: ' Hello world ', words: [{ text: 'Hello', start: 0, end: 1 }, { text: 'world', start: 1, end: 2 }] };
  assert.deepEqual(validateTranscript({ ...transcript, privateProviderField: 'not stored' }, 60), { ...transcript, text: 'Hello world' });
  for (const value of [
    null, { text: '', words: [] }, { ...transcript, text: 'x'.repeat(100001) },
    { ...transcript, words: [{ text: 'x', start: -1, end: 1 }] },
    { ...transcript, words: [{ text: 'x', start: 2, end: 1 }] },
    { ...transcript, words: [{ text: 'x', start: 0, end: 62 }] },
    { ...transcript, words: [{ text: 'x', start: 2, end: 3 }, { text: 'y', start: 1, end: 2 }] },
    { ...transcript, words: [{ text: 'x', start: NaN, end: 1 }] },
    { ...transcript, words: Array.from({ length: 12001 }, () => ({ text: 'x', start: 0, end: 1 })) },
  ]) {
    assert.throws(() => validateTranscript(value, 60), { code: 'invalid_transcript' });
  }
});

test('output selection accepts only available formats and bounded nonzero counts', () => {
  assert.deepEqual(parseSelection(undefined), { x_posts: 2, linkedin_posts: 1 });
  assert.deepEqual(parseSelection({ linkedin_posts: 1 }), { x_posts: 0, linkedin_posts: 1 });
  for (const value of [null, [], {}, { unknown_format: 1 }, { x_posts: 3 }, { x_posts: 0.5 }, { x_posts: -1 }, { linkedin_posts: 2 }, { x_posts: '1' }]) {
    assert.throws(() => parseSelection(value));
  }
});

test('generation stays unconfigured without keys and never assumes missing rates mean zero cost', () => {
  assert.equal(readGenerationConfig({}), undefined);
  assert.throws(() => readGenerationConfig({ ANTHROPIC_API_KEY: 'test-key' }));
  const env = { ANTHROPIC_API_KEY: 'test-key', DEEPGRAM_API_KEY: 'test-key', FFMPEG_PATH: '/test/ffmpeg' };
  const config = readGenerationConfig(env)!;
  assert.equal(config.rates.inputMicrosPerMillion, 2_000_000);
  assert.equal(config.rates.cacheWriteMicrosPerMillion, null);
  assert.ok(Object.values(readGenerationConfig({ ...env, ANTHROPIC_TEXT_MODEL: 'custom-model' })!.rates).every((rate) => rate === null));
  for (const additions of [{ ANTHROPIC_TEXT_MODEL: '../../model' }, { GENERATION_STAGE_TIMEOUT_MS: '0' }, { GENERATION_MAX_OUTPUT_TOKENS: '9000' }, { ANTHROPIC_INPUT_MICROS_PER_MILLION: '-1' }]) {
    assert.throws(() => readGenerationConfig({ ...env, ...additions }));
  }
});

test('generation selection enforces the batch limits advertised by capabilities', () => {
  for (const [feature, maximum] of Object.entries(generationBatchLimits)) {
    assert.doesNotThrow(() => parseSelection({ [feature]: maximum }));
    assert.throws(() => parseSelection({ [feature]: maximum + 1 }));
  }
});


test('short-post provider responses distinguish insufficient source from malformed content', () => {
  for (const feature of ['x_posts', 'linkedin_posts'] as const) {
    assert.equal(validateShortPost({ status: 'ok', text: ' A source-based post. ' }, feature), 'A source-based post.');
    assert.throws(() => validateShortPost({ status: 'insufficient_source', text: '' }, feature), { status: 422, code: 'insufficient_source', retryable: false });
    for (const response of [{ text: 'Missing status' }, { status: 'ok', text: '' }, { status: 'unknown', text: 'A post' }, { status: 'insufficient_source', text: 'A post' }, { status: 'insufficient_source', text: ' ' }, { status: 'ok', text: 'A post', extra: true }, { status: 'ok' }]) {
      assert.throws(() => validateShortPost(response, feature), { code: 'invalid_generated_output' });
    }
  }
});

test('validation failures identify the rule without retaining private content', () => {
  const privateText = 'private-marker';
  const check = (run: () => unknown, expected: Record<string, unknown>, code = 'invalid_generated_output') => {
    assert.throws(run, (error: any) => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.validation, expected);
      assert.doesNotMatch(JSON.stringify(error.validation), /private-marker/);
      return true;
    });
  };
  check(() => validateShortPost({ status: 'ok', text: '界'.repeat(141) }, 'x_posts'), { reason: 'character_limit', field: 'text', actual: 282, limit: 280 });
  check(() => validatePost({ text: 'x'.repeat(3001) }, 'linkedin_posts'), { reason: 'character_limit', field: 'text', actual: 3001, limit: 3000 });
  check(() => validatePost({ text: ' ' }, 'x_posts'), { reason: 'empty_text', field: 'text' });
  check(() => validatePost({ text: `${privateText}\u0000` }, 'x_posts'), { reason: 'invalid_characters', field: 'text' });
  check(() => validatePost({ text: `\`\`\`${privateText}` }, 'x_posts'), { reason: 'unsupported_markup', field: 'text' });
  check(() => validateShortPost({ status: 'insufficient_source', text: privateText }, 'x_posts'), { reason: 'insufficient_source_has_content', field: 'text' });
  check(() => validateShortPost({ text: privateText }, 'x_posts'), { reason: 'invalid_shape', field: 'post' });
  check(() => validateLongForm({ status: 'ok', title: 'Title', bodyMarkdown: `${'word '.repeat(1200)}extra` }, 'blogs'), { reason: 'word_limit', field: 'bodyMarkdown', actual: 1201, limit: 1200 });
  check(() => validateLongForm({ status: 'ok', subject: 's'.repeat(101), previewText: 'Preview', bodyMarkdown: 'Body' }, 'newsletters'), { reason: 'character_limit', field: 'subject', actual: 101, limit: 100 });
  check(() => validateLongForm({ status: 'ok', title: 'Title', bodyMarkdown: `<b>${privateText}</b>` }, 'blogs'), { reason: 'unsupported_markup', field: 'bodyMarkdown' });
  check(() => validateCarousel({ status: 'ok', slides: [] }), { reason: 'item_count', field: 'slides', actual: 0, limit: 5 });
  const slides = Array.from({ length: 5 }, () => ({ title: 'Title', body: 'Body' }));
  check(() => validateCarousel({ status: 'ok', slides: [{ title: 'Title', body: 'x'.repeat(241) }, ...slides.slice(1)] }), { reason: 'character_limit', field: 'slideBody', index: 0, actual: 241, limit: 240 });
  check(() => validateTranscript({ text: privateText, words: [{ text: privateText, start: 2, end: 1 }] }, 60), { reason: 'invalid_timestamps', field: 'wordTiming', index: 0 }, 'invalid_transcript');
  const transcript = { text: 'A point.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'point.', start: 10, end: 11 }] };
  check(() => validateShortVideo({ status: 'ok', segments: [{ startSeconds: 0.5, endSeconds: 11 }] }, transcript, 20), { reason: 'word_boundary', field: 'startSeconds', index: 0, actual: 0.5 });
  check(() => validateShortVideo({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 1 }] }, transcript, 20), { reason: 'duration_limit', field: 'segments', actual: 1, limit: 10 });
  check(() => validateShortVideo({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 11 }, { startSeconds: 0, endSeconds: 11 }] }, transcript, 20), { reason: 'out_of_order', field: 'segment', index: 1 });
});

test('diagnostic persistence accepts only known labels and finite measurements', () => {
  assert.deepEqual(safeValidationIssue({ reason: 'character_limit', field: 'text', actual: 282, limit: 280, rawText: 'private-marker', index: NaN }), { reason: 'character_limit', field: 'text', actual: 282, limit: 280 });
  assert.equal(safeValidationIssue({ reason: 'private-marker', field: 'text' }), undefined);
  assert.equal(safeValidationIssue({ reason: 'character_limit', field: 'private-marker' }), undefined);
  assert.equal(safeValidationIssue({ get reason() { throw Error('private-marker'); } }), undefined);
  let reads = 0;
  assert.deepEqual(safeValidationIssue({ get reason() { return reads++ === 0 ? 'empty_text' : 'private-marker'; }, field: 'text' }), { reason: 'empty_text', field: 'text' });
  assert.deepEqual(safeValidationIssue({ reason: 'character_limit', field: 'text', actual: Infinity, limit: 'private-marker' }), { reason: 'character_limit', field: 'text' });
});
