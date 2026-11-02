import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateXThread } from '../../src/generation/validation.js';
import { canonicalOutput, outputFingerprint } from '../../src/generation/history.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import { createGenerationService, type GeneratedOutput, type GenerationBatch, type GenerationStore } from '../../src/generation/service.js';

const settings = { mode: 'thread' as const, maxPosts: 10, numbering: 'include' as const };
const selection = { x_posts: 1, linkedin_posts: 0 };
const controls = resolveGenerationControls({ formats: { x_posts: settings } }, selection, { status: 'resolved', defaults: {} });
const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
const slot = { id: 'thread', feature: 'x_posts' as const, ordinal: 1, status: 'pending' as const, attempts: 1, errorCode: null };
const source = { text: 'A useful source lesson.', words: [{ text: 'Lesson.', start: 0, end: 10 }] };
const response = (value: unknown, stop = 'end_turn') => Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } });

test('thread validation uses actual M, allows a coherent one-post result and enforces weighted final limits', () => {
  const one = validateXThread({ status: 'ok', posts: [' A supported point. '] }, settings);
  assert.equal(one.text, '1/1 A supported point.');
  assert.deepEqual(one.content.posts, ['A supported point.']);
  const ten = validateXThread({ status: 'ok', posts: Array.from({ length: 10 }, (_, i) => `Point ${i + 1}.`) }, settings);
  assert.match(ten.text, /^1\/10 Point 1\./);
  assert.match(ten.text, /10\/10 Point 10\.$/);
  const without = { ...settings, numbering: 'exclude' as const };
  assert.equal(validateXThread({ status: 'ok', posts: ['a'.repeat(280)] }, without).text.length, 280);
  assert.throws(() => validateXThread({ status: 'ok', posts: ['a'.repeat(277)] }, settings), { code: 'invalid_generated_output' });
  assert.throws(() => validateXThread({ status: 'ok', posts: ['界'.repeat(139)] }, settings), { code: 'invalid_generated_output' });
  assert.ok(validateXThread({ status: 'ok', posts: ['https://example.com/' + 'long-url'.repeat(60)] }, settings).text.length > 280);
  assert.deepEqual(validateXThread(one.content, settings), one);
  assert.throws(() => validateXThread(one.content, without), { code: 'invalid_generated_output' });
});

test('empty, incomplete, oversized, pre-numbered and malformed threads fail as whole outputs', () => {
  for (const value of [null, { status: 'ok', posts: [] }, { status: 'ok', posts: [''] }, { status: 'ok', posts: ['Point', null] }, { status: 'ok', posts: Array(11).fill('Point') }, { status: 'ok', posts: ['Point'], extra: 'private' }, { status: 'insufficient_source', posts: ['Point'] }, { status: 'ok', posts: ['1/1 Point'] }]) {
    assert.throws(() => validateXThread(value, settings), { code: 'invalid_generated_output' });
  }
  assert.throws(() => validateXThread({ status: 'insufficient_source', posts: [] }, settings), { code: 'insufficient_source' });
  assert.throws(() => validateXThread({ status: 'ok', posts: ['A', 'B', 'C'] }, { ...settings, maxPosts: 2 }), { code: 'invalid_generated_output' });
});

test('thread fingerprints compare ordered normalized raw content, ignore numbering and preserve legacy hashes', () => {
  const included = validateXThread({ status: 'ok', posts: ['Cafe\u0301.', 'Another point.'] }, settings);
  const excluded = validateXThread({ status: 'ok', posts: ['Café.', 'Another point.'] }, { ...settings, numbering: 'exclude' });
  const a = { text: included.text, data: included.content };
  const b = { text: excluded.text, data: excluded.content };
  assert.equal(outputFingerprint('x_posts', a), outputFingerprint('x_posts', b));
  assert.notEqual(outputFingerprint('x_posts', a), outputFingerprint('x_posts', { text: b.text, data: { ...b.data, posts: [...b.data.posts].reverse() } }));
  assert.equal(canonicalOutput('x_posts', { text: ' Café. ' }), JSON.stringify('Café.'));
  assert.equal(outputFingerprint('x_posts', { text: ' Café. ' }), createHash('sha256').update(JSON.stringify('Café.')).digest('hex'));
  assert.notEqual(outputFingerprint('x_posts', { text: included.content.posts[0]! }), outputFingerprint('x_posts', { text: included.content.posts[0]!, data: { ...included.content, posts: [included.content.posts[0]!] } }));
});

test('provider generates one coherent thread with member reuse, separate history guidance and bounded token budget', async () => {
  let calls = 0;
  let sent: any;
  const previousOutputs: GeneratedOutput[] = [{ id: 'single', feature: 'x_posts', text: 'A historical member.', createdAt: 1, expiresAt: 1000, model: 'fixture', promptVersion: 'fixture' }];
  const providers = createGenerationProviders({ config, now: () => 10, audio: async () => assert.fail(), request: async (_url, options) => { calls++; sent = JSON.parse(String(options!.body)); return response({ status: 'ok', posts: ['A historical member.', 'A new supported point.'] }); } });
  const result = await providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls, previousOutputs });
  assert.equal(calls, 1);
  assert.deepEqual(result.value, { kind: 'thread', status: 'ok', posts: ['A historical member.', 'A new supported point.'], numbering: 'include' });
  assert.deepEqual(sent.output_config.format.schema.required, ['status', 'posts']);
  assert.equal(sent.output_config.format.schema.properties.posts.type, 'array');
  assert.equal(sent.output_config.format.schema.properties.posts.items.type, 'string');
  assert.equal(sent.output_config.format.schema.properties.posts.maxItems, undefined);
  assert.match(sent.output_config.format.schema.properties.posts.description, /max items: 10/);
  assert.equal(sent.output_config.format.schema.properties.posts.items.maxLength, undefined);
  assert.match(sent.output_config.format.schema.properties.posts.items.description, /274 X weighted characters/);
  assert.ok(sent.max_tokens > 1200 && sent.max_tokens <= 8192);
  assert.match(JSON.stringify(sent.system), /Individual historical posts and material may be reused/);
  assert.doesNotMatch(JSON.stringify(sent.system), /Use them only to avoid repeating their main lesson|text set to an empty string/);
  assert.match(JSON.stringify(sent.messages), /never an exact count|maximum, never an exact count/);
  assert.match(result.promptVersion!, /^x-thread-v3\+controls-v1\+history-v1$/);
});

test('thread source failures and truncated responses retain costs without exposing a surviving remainder', async () => {
  for (const scenario of [
    { value: { status: 'unsupported_focus', posts: [] }, stop: 'end_turn', code: 'unsupported_focus' },
    { value: { status: 'unsupported_focus', posts: ['Surviving post'] }, stop: 'end_turn', code: 'invalid_generated_output' },
    { value: { status: 'ok', posts: ['Surviving post'] }, stop: 'max_tokens', code: 'incomplete_generated_output' },
  ]) {
    let calls = 0;
    const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async () => { calls++; return response(scenario.value, scenario.stop); } });
    await assert.rejects(providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls: { ...controls, focus: 'Unsupported focus' } }), (error: any) => error.code === scenario.code && error.usage.inputTokens === 100 && !error.retryable);
    assert.equal(calls, 1);
  }
});

test('thread schema reserves numbering space without imposing raw length or bypassing weighted validation', async () => {
  for (const [maxPosts, numbering, budget] of [[2, 'include', 276], [10, 'include', 274], [10, 'exclude', 280]] as const) {
    const snapshot = resolveGenerationControls({ formats: { x_posts: { mode: 'thread', maxPosts, numbering } } }, selection, { status: 'resolved', defaults: {} });
    let posts = [`https://example.com/${'a'.repeat(300)}`];
    let calls = 0;
    const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
      calls++;
      const items = JSON.parse(String(options!.body)).output_config.format.schema.properties.posts.items;
      assert.equal(items.maxLength, undefined);
      assert.match(items.description, new RegExp(`${budget} X weighted characters`));
      return response({ status: 'ok', posts });
    } });
    const result = await providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls: snapshot });
    assert.deepEqual((result.value as { posts: string[] }).posts, posts);
    posts = ['界'.repeat(141)];
    await assert.rejects(providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls: snapshot }), (error: any) => error.code === 'invalid_generated_output' && error.validation.reason === 'character_limit' && error.validation.actual === 282 + (numbering === 'include' ? 4 : 0) && error.usage.outputTokens === 40 && !error.retryable);
    assert.equal(calls, 3);
  }
});

test('public thread metadata distinguishes maximum reservation, delivered credits and complete export', async () => {
  const result = validateXThread({ status: 'ok', posts: ['One.', 'Two.'] }, settings);
  const output = { id: 'thread', feature: 'x_posts', data: result.content, text: result.text, credits: 2, deliveredPosts: 2, requestedMaxPosts: 10, createdAt: 1, expiresAt: 1000, model: 'private', promptVersion: 'private' } as GeneratedOutput;
  let batch = { id: 'batch', status: 'queued', slots: [{ ...slot, maxCredits: 10, charge: { credits: 10, period: 'period' } }] } as unknown as GenerationBatch;
  const store = { batch: async () => batch, output: async () => output } as unknown as GenerationStore;
  const service = createGenerationService({ store });
  assert.equal((await service.get('uid', 'project')).slots[0]!.credits, 10);
  batch = { ...batch, status: 'completed', slots: [{ ...batch.slots[0]!, status: 'ready', deliveredCredits: 2, deliveredPosts: 2 }] };
  assert.deepEqual((await service.get('uid', 'project')).slots[0], { id: 'thread', feature: 'x_posts', status: 'ready', errorCode: null, maxCredits: 10, credits: 2, deliveredPosts: 2 });
  const saved = await service.output('uid', 'project', 'thread');
  assert.equal(saved.text, '1/2 One.\n\n2/2 Two.');
  assert.equal(saved.credits, 2);
  assert.equal(saved.deliveredPosts, 2);
  assert.equal(saved.requestedMaxPosts, 10);
  assert.doesNotMatch(JSON.stringify(saved), /private|promptVersion/);
  batch = { ...batch, status: 'failed', slots: [{ ...slot, status: 'failed', maxCredits: 10, charge: { credits: 10, period: 'period' } }] };
  assert.equal((await service.get('uid', 'project')).slots[0]!.credits, 0);
});

test('thread length failure cannot conceal a malformed or pre-numbered later member', async () => {
  for (const bad of ['', '1/2 Pre-numbered.', '```bad', '\ufffe']) {
    let calls = 0;
    const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async () => {
      calls++;
      return response({ status: 'ok', posts: ['x'.repeat(300), bad] });
    } });
    await assert.rejects(providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls }), (error: any) => error.code === 'invalid_generated_output' && error.validation.reason !== 'character_limit');
    assert.equal(calls, 1);
  }
});

test('thread correction preserves immutable source, window, focus, brand and history data', async () => {
  const accepted = resolveGenerationControls({ focus: 'A useful lesson', sourceWindow: { startSeconds: 0, endSeconds: 10 }, formats: { x_posts: settings } }, selection, { status: 'resolved', defaults: {} });
  const requests: any[] = [];
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
    requests.push(JSON.parse(String(options!.body)));
    return response({ status: 'ok', posts: [requests.length === 1 ? 'x'.repeat(300) : 'A useful supported lesson.'] });
  } });
  const previous: GeneratedOutput = { id: 'old', feature: 'x_posts', text: 'Previous source lesson.', createdAt: 1, expiresAt: Date.now() + 100_000, model: 'fixture', promptVersion: 'fixture' };
  const result = await providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls: accepted, actualDurationSeconds: 10, brand: { voice: 'Calm' }, previousOutputs: [previous] });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(0, 2), requests[0].messages.slice(0, 2));
  const context = JSON.stringify(requests[1].messages.slice(0, 2));
  for (const field of ['request_focus', 'source_window', 'correction_context', 'writing_preferences', 'previous_outputs']) assert.ok(context.includes(field));
  assert.deepEqual(requests[1].output_config, requests[0].output_config);
  assert.match(result.promptVersion!, /\+length-correction-v2$/);
  assert.equal(result.usage.textCalls?.length, 2);
});
