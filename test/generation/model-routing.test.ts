import assert from 'node:assert/strict';
import test from 'node:test';
import { readGenerationConfig } from '../../src/generation/config.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { estimateCost } from '../../src/generation/firestore.js';
import type { ProviderRequest } from '../../src/generation/service.js';

const env = { ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' };
const source = { text: 'A source lesson.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'lesson.', start: 9, end: 10 }] };
const response = (model: string, output: unknown) => Response.json({ id: 'fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

test('video model and prices are independent, with explicit overrides scoped to matching models', () => {
  const config = readGenerationConfig(env)!;
  assert.equal(config.textModel, 'claude-sonnet-5-5');
  assert.equal(config.videoModel, 'claude-opus-5-5');
  assert.deepEqual([config.videoRates.inputMicrosPerMillion, config.videoRates.outputMicrosPerMillion, config.videoRates.cacheReadMicrosPerMillion, config.videoRates.cacheWriteMicrosPerMillion], [4_000_000, 20_000_000, 200_000, null]);
  const custom = readGenerationConfig({ ...env, ANTHROPIC_TEXT_MODEL: 'custom-writing', ANTHROPIC_INPUT_MICROS_PER_MILLION: '123', ANTHROPIC_VIDEO_MODEL: 'custom-video' })!;
  assert.equal(custom.rates.inputMicrosPerMillion, 123);
  assert.equal(custom.videoRates.inputMicrosPerMillion, null);
  assert.equal(custom.videoRates.outputMicrosPerMillion, null);
  const matching = readGenerationConfig({ ...env, ANTHROPIC_TEXT_MODEL: 'custom', ANTHROPIC_VIDEO_MODEL: 'custom', ANTHROPIC_INPUT_MICROS_PER_MILLION: '123', ANTHROPIC_VIDEO_OUTPUT_MICROS_PER_MILLION: '456' })!;
  assert.equal(matching.videoRates.inputMicrosPerMillion, 123);
  assert.equal(matching.videoRates.outputMicrosPerMillion, 456);
  for (const settings of [{ ANTHROPIC_VIDEO_MODEL: '' }, { ANTHROPIC_VIDEO_MODEL: '../model' }, { ANTHROPIC_VIDEO_INPUT_MICROS_PER_MILLION: '-1' }]) assert.throws(() => readGenerationConfig({ ...env, ...settings }));
});

test('production SDK routes video to adaptive Opus and writing corrections to Sonnet with matching costs', async () => {
  const config = readGenerationConfig(env)!;
  const marks: ProviderRequest[] = [];
  const sent: any[] = [];
  let writingCalls = 0;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
    const body = JSON.parse(String(options!.body)); sent.push(body);
    if (body.model === config.videoModel) {
      assert.equal(body.thinking, undefined);
      return response(body.model, { status: 'ok', segments: [{ startSeconds: 0, endSeconds: 10 }] });
    }
    assert.equal(body.model, config.textModel);
    assert.deepEqual(body.thinking, { type: 'between_tools' });
    return response(body.model, { status: 'ok', text: ++writingCalls === 1 ? 'a'.repeat(281) : 'A supported source lesson.' });
  } });
  const slot = { id: 'fixture', ordinal: 1, status: 'pending' as const, attempts: 1, errorCode: null };
  const mark = async (value: ProviderRequest) => { marks.push(value); };
  const video = await providers.generate(source, { ...slot, feature: 'short_videos' }, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, new AbortController().signal, mark, { actualDurationSeconds: 10 });
  assert.equal(video.model, config.videoModel);
  assert.equal(video.rates!.model, config.videoModel);
  assert.equal(video.usage.textCalls![0]!.model, config.videoModel);
  assert.equal(estimateCost(video.usage, video.rates, 'generate').amountMicros, 800);
  const writing = await providers.generate(source, { ...slot, feature: 'x_posts' }, { x_posts: 1, linkedin_posts: 0 }, new AbortController().signal, mark);
  assert.equal(sent.length, 3);
  assert.equal(writing.usage.textCalls!.length, 2);
  assert.ok(writing.usage.textCalls!.every(call => call.model === config.textModel));
  assert.equal(estimateCost(writing.usage, writing.rates, 'generate').amountMicros, 800);
  assert.deepEqual(marks.map(value => [value.model, value.rates!.inputMicrosPerMillion]), [[config.videoModel, 4_000_000], [config.textModel, 2_000_000], [config.textModel, 2_000_000]]);
  assert.ok(marks[2]!.lengthCorrection);
  assert.equal(estimateCost({ ...video.usage, cacheWriteTokens: 1 }, video.rates, 'generate').status, 'unknown');
  assert.equal(estimateCost(video.usage, writing.rates, 'generate').status, 'unknown');
});

test('explicit video override and failed responses retain selected model usage and rates', async () => {
  const config = readGenerationConfig({ ...env, ANTHROPIC_VIDEO_MODEL: 'custom-video', ANTHROPIC_VIDEO_INPUT_MICROS_PER_MILLION: '123' })!;
  let mark: ProviderRequest | undefined;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    assert.equal(body.model, 'custom-video');
    return response(body.model, { status: 'insufficient_source', segments: [] });
  } });
  await assert.rejects(providers.generate(source, { id: 'video', feature: 'short_videos', ordinal: 1, status: 'pending', attempts: 1, errorCode: null }, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, new AbortController().signal, async value => { mark = value; }, { actualDurationSeconds: 10 }), (error: any) => error.code === 'insufficient_source' && error.model === 'custom-video' && error.usage.textCalls[0].model === 'custom-video');
  assert.equal(mark!.model, 'custom-video');
  assert.equal(mark!.rates!.model, 'custom-video');
  assert.equal(mark!.rates!.inputMicrosPerMillion, 123);
  assert.equal(mark!.rates!.outputMicrosPerMillion, null);
});

test('newsletter configuration is independent from blogs and video overrides', () => {
  const defaults = readGenerationConfig(env)!;
  assert.equal(defaults.newsletterModel, 'claude-opus-5-5');
  assert.deepEqual(defaults.newsletterRates, defaults.videoRates);
  const custom = readGenerationConfig({ ...env, ANTHROPIC_NEWSLETTER_MODEL: 'custom-newsletter', ANTHROPIC_INPUT_MICROS_PER_MILLION: '123', ANTHROPIC_VIDEO_OUTPUT_MICROS_PER_MILLION: '456' })!;
  assert.equal(custom.newsletterRates.inputMicrosPerMillion, null);
  assert.equal(custom.newsletterRates.outputMicrosPerMillion, null);
  const matching = readGenerationConfig({ ...env, ANTHROPIC_TEXT_MODEL: 'custom', ANTHROPIC_NEWSLETTER_MODEL: 'custom', ANTHROPIC_INPUT_MICROS_PER_MILLION: '123', ANTHROPIC_NEWSLETTER_OUTPUT_MICROS_PER_MILLION: '789' })!;
  assert.equal(matching.newsletterRates.inputMicrosPerMillion, 123);
  assert.equal(matching.newsletterRates.outputMicrosPerMillion, 789);
  assert.equal(matching.videoRates.outputMicrosPerMillion, 20_000_000);
  for (const settings of [{ ANTHROPIC_NEWSLETTER_MODEL: '' }, { ANTHROPIC_NEWSLETTER_MODEL: '../model' }, { ANTHROPIC_NEWSLETTER_INPUT_MICROS_PER_MILLION: '-1' }]) assert.throws(() => readGenerationConfig({ ...env, ...settings }));
});

test('newsletter creation and correction use their selected model while blogs retain the text model', async () => {
  for (const override of [undefined, 'custom-newsletter']) {
    const config = readGenerationConfig({ ...env, ...(override ? { ANTHROPIC_NEWSLETTER_MODEL: override, ANTHROPIC_NEWSLETTER_INPUT_MICROS_PER_MILLION: '1' } : {}) })!;
    const marks: ProviderRequest[] = [];
    let newsletterCalls = 0;
    const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      const isNewsletter = body.output_config.format.schema.required.includes('subject');
      assert.equal(body.model, isNewsletter ? config.newsletterModel : config.textModel);
      if (!override && isNewsletter) assert.equal(body.thinking, undefined);
      if (!isNewsletter) assert.deepEqual(body.thinking, { type: 'between_tools' });
      return response(body.model, isNewsletter ? { status: 'ok', subject: 'A source lesson', previewText: 'A useful perspective.', bodyMarkdown: ++newsletterCalls === 1 ? 'word '.repeat(1501).trim() : 'A short supported lesson.' } : { status: 'ok', title: 'A source lesson', bodyMarkdown: 'A short supported lesson.' });
    } });
    const slot = { id: 'fixture', ordinal: 1, status: 'pending' as const, attempts: 1, errorCode: null };
    const mark = async (value: ProviderRequest) => { marks.push(value); };
    const newsletter = await providers.generate(source, { ...slot, feature: 'newsletters' }, { x_posts: 0, linkedin_posts: 0, newsletters: 1 }, new AbortController().signal, mark);
    assert.equal(newsletterCalls, 2);
    assert.equal(newsletter.model, config.newsletterModel);
    assert.equal(newsletter.rates!.model, config.newsletterModel);
    assert.ok(newsletter.usage.textCalls!.every(call => call.model === config.newsletterModel));
    assert.deepEqual(marks.map(value => value.model), [config.newsletterModel, config.newsletterModel]);
    assert.ok(marks[1]!.lengthCorrection);
    assert.equal(estimateCost(newsletter.usage, newsletter.rates, 'generate').amountMicros, override ? null : 1600);
    const blog = await providers.generate(source, { ...slot, feature: 'blogs' }, { x_posts: 0, linkedin_posts: 0, blogs: 1 }, new AbortController().signal, mark);
    assert.equal(blog.model, config.textModel);
    assert.equal(blog.rates!.model, config.textModel);
    assert.equal(blog.rates!.inputMicrosPerMillion, 2_000_000);
    assert.equal(marks[2]!.model, config.textModel);
    assert.equal(estimateCost(blog.usage, blog.rates, 'generate').amountMicros, 400);
  }
});
