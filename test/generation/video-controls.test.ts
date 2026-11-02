import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGenerationControls } from '../../src/generation/controls.js';
import { buildShortVideoPrompt } from '../../src/generation/prompts/short-video.js';
import { prepareShortVideoSelection, validateShortVideo } from '../../src/generation/validation.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { createVideoRenderer } from '../../src/generation/video.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import type { GenerationClaim } from '../../src/generation/service.js';

const selection = { x_posts: 0, linkedin_posts: 0, short_videos: 1 };
const settings = { editing: 'continuous' as const, duration: 30 as const };
const controls = resolveGenerationControls({ formats: { short_videos: settings } }, selection, { status: 'resolved', defaults: {} });
const source = { text: 'A complete source explanation.', words: [{ text: 'Start', start: 0, end: 1 }, { text: 'first.', start: 9, end: 10 }, { text: 'second', start: 15, end: 16 }, { text: 'end.', start: 23, end: 24 }, { text: 'late.', start: 60, end: 61 }] };
const multi = { status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 10 }, { startSeconds: 15, endSeconds: 24 }] };
const single = { status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 24 }] };

test('continuous mode rejects raw and saved multi-cut plans while soft duration misses stay valid', () => {
  for (const validate of [prepareShortVideoSelection, validateShortVideo]) {
    assert.throws(() => validate(multi, source, 70, controls), (error: any) => error.code === 'invalid_generated_output' && error.validation.reason === 'item_count' && error.validation.limit === 1);
    assert.deepEqual(validate(single, source, 70, controls).content, single);
    assert.deepEqual(validate(multi, source, 70).content, multi);
    assert.throws(() => validate({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 61 }] }, source, 70, controls), (error: any) => error.validation.reason === 'duration_limit');
  }
});

test('continuous word-boundary preparation stays inside the window and keeps hard timing bounds', () => {
  const transcript = { text: 'An overlapping spoken explanation.', words: [{ text: 'overlap', start: 9.5, end: 10.5 }, { text: 'start', start: 10, end: 11 }, { text: 'end', start: 19, end: 20 }] };
  const raw = { status: 'ok', segments: [{ startSeconds: 10, endSeconds: 20 }] };
  assert.throws(() => prepareShortVideoSelection(raw, transcript, 30, { ...controls, sourceWindow: { startSeconds: 9, endSeconds: 21 } }), (error: any) => error.validation.reason === 'word_crosses_boundary');
  assert.throws(() => prepareShortVideoSelection(raw, transcript, 30, { ...controls, sourceWindow: { startSeconds: 10, endSeconds: 20 } }), { code: 'source_window_conflict' });
});

test('all video targets are soft and continuous instructions require one segment without forcing cuts', () => {
  for (const duration of [15, 30, 45, 60] as const) {
    const prompt = buildShortVideoPrompt({ transcript: source, actualDurationSeconds: 70, settings: { ...settings, duration } });
    assert.match(prompt.instructions, new RegExp(`about ${duration} seconds`));
    assert.match(prompt.instructions, /soft target, not an exact duration or a minimum/);
    assert.match(prompt.instructions, /at least 10 seconds and at most 60 seconds/);
    assert.match(prompt.instructions, /exactly one segment object/);
    assert.match(prompt.system, /exactly one continuous segment/);
    assert.match(prompt.system, /start < endpoint < end/);
    assert.match(prompt.system, /application will not extend or trim/);
    assert.match(prompt.system, /Punctuation alone does not establish a safe cut/);
    assert.match(prompt.instructions, /Never pad, force extra cuts, truncate a thought/);
  }
  const auto = buildShortVideoPrompt({ transcript: source, actualDurationSeconds: 70, settings: { duration: 'auto', editing: 'auto' } });
  assert.match(auto.instructions, /one to three excerpts/);
  assert.doesNotMatch(auto.instructions, /Prefer about/);
});

test('the provider enforces continuous mode after a single call and accepts complete shorter output', async () => {
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
  let calls = 0;
  let output = multi;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async () => {
    calls++;
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } });
  } });
  const slot = { id: 'clip', feature: 'short_videos' as const, ordinal: 1, status: 'pending' as const, attempts: 1, errorCode: null };
  await assert.rejects(providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls, actualDurationSeconds: 70 }), (error: any) => error.code === 'invalid_generated_output' && error.validation.limit === 1 && error.usage.inputTokens === 100 && !error.retryable);
  assert.equal(calls, 1);
  output = single;
  assert.deepEqual((await providers.generate(source, slot, selection, new AbortController().signal, async () => {}, { controls, actualDurationSeconds: 70 })).value, single);
  assert.equal(calls, 2);
});

test('renderer revalidates continuous mode before reading or rendering the original video', async () => {
  let reads = 0;
  const renderer = createVideoRenderer({ ffmpegPath: '/unused', ffprobePath: '/unused', readSource: async () => { reads++; return assert.fail('No source read'); }, storage: { uploadFile: async () => assert.fail(), remove: async () => assert.fail() } });
  const claim = { project: { source: { durationSeconds: 70 }, storagePath: 'unused' }, batch: { controls } } as GenerationClaim;
  await assert.rejects(renderer(multi, claim, source, new AbortController().signal), (error: any) => error.code === 'invalid_generated_output' && error.validation.limit === 1);
  assert.equal(reads, 0);
});

test('the transported video schema constrains exact non-crossing endpoints from the full source', async () => {
  const transcript = { text: 'Earlier. A useful explanation ends. Next.', words: [
    { text: 'Earlier.', start: 0, end: 2 }, { text: 'A.', start: 1, end: 2.5 },
    { text: 'useful', start: 2.5, end: 3 }, { text: 'explanation.', start: 9, end: 10 },
    { text: 'ends.', start: 12, end: 13 }, { text: 'Next.', start: 12.5, end: 14 },
  ] };
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
  const windowed = { ...controls, sourceWindow: { startSeconds: 1, endSeconds: 13 } };
  let calls = 0;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options!.body));
    const endpoints = body.output_config.format.schema.properties.segments.items.properties;
    assert.deepEqual(endpoints.startSeconds.enum, [2.5, 12]);
    assert.deepEqual(endpoints.endSeconds.enum, [2.5, 10]);
    assert.ok(!endpoints.startSeconds.enum.includes(1));
    assert.ok(!endpoints.endSeconds.enum.includes(13));
    assert.match(JSON.stringify(body.messages), /Earlier/);
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: JSON.stringify({ status: 'insufficient_source', segments: [] }) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } });
  } });
  const slot = { id: 'clip', feature: 'short_videos' as const, ordinal: 1, status: 'pending' as const, attempts: 1, errorCode: null };
  await assert.rejects(providers.generate(transcript, slot, selection, new AbortController().signal, async () => {}, { controls: windowed, actualDurationSeconds: 20 }), (error: any) => error.code === 'insufficient_source' && error.usage.inputTokens === 100);
  assert.equal(calls, 1);
});

test('no usable endpoints inside a hard window fails before marking or calling the provider', async () => {
  const transcript = { text: 'Overlapping source.', words: [
    { text: 'outside', start: 0, end: 20 }, { text: 'inside', start: 2, end: 12 },
  ] };
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async () => assert.fail('No provider cost') });
  const slot = { id: 'clip', feature: 'short_videos' as const, ordinal: 1, status: 'pending' as const, attempts: 1, errorCode: null };
  await assert.rejects(providers.generate(transcript, slot, selection, new AbortController().signal, async () => assert.fail('No request marked'), { controls: { ...controls, sourceWindow: { startSeconds: 1, endSeconds: 13 } }, actualDurationSeconds: 20 }), { code: 'source_window_conflict', retryable: false });
});
