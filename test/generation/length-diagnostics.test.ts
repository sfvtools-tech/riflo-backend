import assert from 'node:assert/strict';
import test from 'node:test';
import twitterText from 'twitter-text';
import { validateXThread, validateCarousel, validateLongForm } from '../../src/generation/validation.js';
import { GenerationError } from '../../src/generation/service.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';

function violations(run: () => unknown) {
  try { run(); assert.fail('Expected a length failure'); }
  catch (error) { assert.ok(error instanceof GenerationError); assert.ok(error.lengthViolations); return error.lengthViolations; }
}
const settings = { mode: 'thread' as const, maxPosts: 10, numbering: 'include' as const };
// Reproduces the measured serialized counts of the actual failed writing batch.
const weights = [249, 261, 271, 267, 285, 290, 234, 245, 279, 282];
const counterexample = { status: 'ok', posts: weights.map((weight, i) => 'x'.repeat(weight - `${i + 1}/10 `.length)) };

test('all actual-counterexample failures identify final member count and raw numbering budgets', () => {
  const issues = violations(() => validateXThread(counterexample, settings));
  assert.deepEqual(issues.map(({ path, index, actual, limit, rawActual, rawLimit, numberingCharacters }) => ({ path, index, actual, limit, rawActual, rawLimit, numberingCharacters })), [
    { path: 'posts[4]', index: 4, actual: 285, limit: 280, rawActual: 280, rawLimit: 275, numberingCharacters: 5 },
    { path: 'posts[5]', index: 5, actual: 290, limit: 280, rawActual: 285, rawLimit: 275, numberingCharacters: 5 },
    { path: 'posts[9]', index: 9, actual: 282, limit: 280, rawActual: 276, rawLimit: 274, numberingCharacters: 6 },
  ]);
  const reduced = { status: 'ok', posts: ['x'.repeat(277)] };
  assert.equal(violations(() => validateXThread(reduced, settings))[0]!.rawLimit, 276);
  assert.equal(validateXThread(reduced, { ...settings, numbering: 'exclude' }).content.posts.length, 1);
});

test('thread diagnostics use weighted Unicode and URL counts rather than raw string length', () => {
  const post = '界'.repeat(126) + ` https://example.com/${'a'.repeat(400)}`;
  assert.equal(twitterText.parseTweet(post).weightedLength, 276);
  const candidate = { status: 'ok', posts: Array(10).fill(post) };
  const issues = violations(() => validateXThread(candidate, settings));
  assert.equal(issues.length, 10);
  assert.equal(issues[0]!.actual, 281);
  assert.equal(issues[9]!.actual, 282);
  assert.equal(issues[9]!.rawActual, 276);
  assert.equal(issues[9]!.rawLimit, 274);
  assert.equal(validateXThread(candidate, { ...settings, numbering: 'exclude' }).content.posts.length, 10);
});

test('carousel diagnostics include every invalid field and both word and character bounds', () => {
  const slides = Array.from({ length: 5 }, () => ({ title: 'Title', body: 'Body' }));
  slides[0]!.title = 'longword '.repeat(13).trim();
  slides[3]!.body = 'longword '.repeat(46).trim();
  const issues = violations(() => validateCarousel({ status: 'ok', slides }));
  assert.deepEqual(issues.map(v => [v.path, v.reason, v.actual, v.limit]), [
    ['slides[0].title', 'character_limit', 116, 80], ['slides[0].title', 'word_limit', 13, 12],
    ['slides[3].body', 'character_limit', 413, 240], ['slides[3].body', 'word_limit', 46, 45],
  ]);
  slides[4]!.body = '<script>invalid</script>';
  assert.throws(() => validateCarousel({ status: 'ok', slides }), (e: any) => e.validation.reason === 'unsupported_markup' && !e.lengthViolations);
});

test('long-form diagnostics include body character and word violations plus every heading', () => {
  const bodyMarkdown = 'longwordlongword '.repeat(1501).trim();
  const issues = violations(() => validateLongForm({ status: 'ok', subject: 'x'.repeat(101), previewText: 'x'.repeat(161), bodyMarkdown }, 'newsletters'));
  assert.deepEqual(issues.map(v => [v.path, v.reason, v.actual, v.limit]), [
    ['bodyMarkdown', 'character_limit', bodyMarkdown.length, 21000], ['bodyMarkdown', 'word_limit', 1501, 1500],
    ['subject', 'character_limit', 101, 100], ['previewText', 'character_limit', 161, 160],
  ]);
  const blog = violations(() => validateLongForm({ status: 'ok', title: 'x'.repeat(141), bodyMarkdown }, 'blogs'));
  assert.deepEqual(blog.map(v => v.path), ['bodyMarkdown', 'bodyMarkdown', 'title']);
});

test('the one correction request receives the complete indexed list as untrusted tool data', async () => {
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
  const selection = { x_posts: 1, linkedin_posts: 0 };
  const controls = resolveGenerationControls({ formats: { x_posts: settings } }, selection, { status: 'resolved', defaults: {} });
  const requests: any[] = [];
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
    requests.push(JSON.parse(String(options!.body)));
    const candidate = requests.length === 1 ? counterexample : { status: 'ok', posts: ['A supported shorter point.'] };
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: config.textModel, content: [{ type: 'text', text: JSON.stringify(candidate) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  } });
  await providers.generate({ text: 'A supported point.', words: [] }, { id: 'thread', feature: 'x_posts', ordinal: 1, attempts: 1, status: 'pending', errorCode: null }, selection, new AbortController().signal, async () => {}, { controls });
  assert.equal(requests.length, 2);
  const parts = requests[1].messages.flatMap((message: any) => message.content);
  const candidate = parts.find((part: any) => part.type === 'tool_result' && part.tool_use_id === 'length-candidate');
  const payload = JSON.parse(candidate.content);
  assert.deepEqual(payload.lengthViolations, violations(() => validateXThread(counterexample, settings)));
  assert.match(JSON.stringify(requests[1].system), /zero-based/);
});
