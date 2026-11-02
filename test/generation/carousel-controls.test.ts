import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { createCarouselRenderer, carouselThemes } from '../../src/generation/carousel.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';
import { validateCarousel } from '../../src/generation/validation.js';
import { outputFingerprint } from '../../src/generation/history.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import type { CarouselContent, GenerationClaim } from '../../src/generation/service.js';

const selection = { x_posts: 0, linkedin_posts: 0, carousels: 1 };
const controls = (density: 'standard' | 'light' | 'auto', theme: 'dark' | 'light' | 'auto' = 'dark') => resolveGenerationControls({ formats: { carousels: { density, theme } } }, selection, { status: 'resolved', defaults: {} });
const plan = (): CarouselContent => ({ status: 'ok', slides: Array.from({ length: 5 }, (_, index) => ({ title: `Source idea ${index + 1}`, body: 'A concise supported explanation.' })) });
const claim = (snapshot = controls('standard')) => ({ project: { uid: 'fixture', id: 'carousel' }, batch: { controls: snapshot }, slot: { id: 'slides' }, attempt: 1 } as GenerationClaim);

test('Light density enforces both character and word ceilings and Auto preserves Standard', () => {
  for (const [field, value, reason] of [
    ['title', 'a'.repeat(61), 'character_limit'], ['title', Array(10).fill('a').join(' '), 'word_limit'],
    ['body', 'a'.repeat(161), 'character_limit'], ['body', Array(29).fill('a').join(' '), 'word_limit'],
  ] as const) {
    const input = plan(); input.slides[0]![field] = value;
    assert.throws(() => validateCarousel(input, controls('light')), (error: any) => error.validation.reason === reason);
    assert.deepEqual(validateCarousel(input, controls('auto')), validateCarousel(input, controls('standard')));
  }
  const input = plan(); input.slides[0] = { title: 'a'.repeat(60), body: 'a'.repeat(160) };
  assert.equal(validateCarousel(input, controls('light')).content.slides.length, 5);
});

test('Light provider bounds reject oversized model copy after one correction while preserving both usages', async () => {
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
  const value = plan(); value.slides[0]!.body = 'a'.repeat(161);
  let calls = 0;
  let sent: any;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async (_url, options) => {
    calls++; sent = JSON.parse(String(options!.body));
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } });
  } });
  await assert.rejects(providers.generate({ text: 'Source explanation.', words: [] }, { id: 'slides', feature: 'carousels', ordinal: 1, status: 'pending', attempts: 1, errorCode: null }, selection, new AbortController().signal, async () => {}, { controls: controls('light') }), (error: any) => error.code === 'invalid_generated_output' && error.validation.limit === 160 && error.usage.inputTokens === 200);
  assert.equal(calls, 2);
  const slides = sent.output_config.format.schema.properties.slides;
  assert.equal(slides.maxItems, undefined);
  assert.match(slides.description, /max items: 5/);
  assert.equal(slides.items.properties.body.maxLength, undefined);
  assert.match(slides.items.properties.body.description, /max length: 160/);
  assert.match(slides.items.properties.title.description, /max length: 60/);
  const instructions = sent.messages.flatMap((message: any) => message.content).filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ');
  assert.match(instructions, /60 characters and 9 words/);
  assert.match(instructions, /160 characters and 28 words/);
});

test('malformed UTF-16 is rejected through validation and the SDK escaped-JSON path before rendering', async () => {
  for (const field of ['title', 'body'] as const) for (const surrogate of ['\ud800', '\udfff']) {
    const input = plan(); input.slides[0]![field] = `Source ${surrogate} text`;
    assert.throws(() => validateCarousel(input), (error: any) => error.code === 'invalid_generated_output' && error.validation.reason === 'invalid_characters');
  }
  const valid = plan(); valid.slides[0] = { title: 'Source idea ✨', body: 'A useful detail 😀 हिंदी العربية 中文.' };
  assert.equal(validateCarousel(valid).content.slides.length, 5);
  const malformed = plan(); malformed.slides[0]!.title = 'Source \ud800 text';
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fixture', DEEPGRAM_API_KEY: 'fixture', FFMPEG_PATH: '/unused' })!;
  let calls = 0;
  const providers = createGenerationProviders({ config, audio: async () => assert.fail(), request: async () => {
    calls++;
    const encoded = JSON.stringify(malformed);
    assert.ok(encoded.includes('\\ud800'));
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: encoded }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } });
  } });
  await assert.rejects(providers.generate({ text: 'Source explanation.', words: [] }, { id: 'slides', feature: 'carousels', ordinal: 1, status: 'pending', attempts: 1, errorCode: null }, selection, new AbortController().signal, async () => {}, { controls: controls('light') }), (error: any) => error.code === 'invalid_generated_output' && error.validation.reason === 'invalid_characters' && error.usage.inputTokens === 100);
  assert.equal(calls, 1);
  let uploads = 0;
  const renderer = createCarouselRenderer({ storage: { uploadBytes: async () => { uploads++; }, remove: async () => {} } });
  await assert.rejects(renderer(malformed, claim(), new AbortController().signal), (error: any) => error.validation.reason === 'invalid_characters');
  assert.equal(uploads, 0);
});

test('both deterministic palettes provide readable contrast for title, body and counter', () => {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map(part => parseInt(part, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  for (const theme of Object.values(carouselThemes)) for (const foreground of [theme.title, theme.body, theme.accent]) {
    const a = luminance(foreground), b = luminance(theme.background);
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5);
  }
});

test('native themes and densities fit long tokens and multilingual copy within fixed PNG bounds', async () => {
  const samples: CarouselContent = { status: 'ok', slides: [
    { title: 'A clear source-supported lesson', body: 'LongTokenWithoutSpaces'.repeat(6) },
    { title: 'स्रोत की बात स्पष्ट रखें', body: 'मूल बात और उसकी शर्तें सुरक्षित रखें। छोटे वाक्य उपयोगी हैं, लेकिन अर्थ और संदर्भ नहीं बदलना चाहिए।' },
    { title: 'حافظ على معنى المصدر', body: 'استخدم عبارات واضحة واحفظ السياق والشروط. لا تضف معلومات غير موجودة في المصدر.' },
    { title: '保留原文的含义与条件', body: '使用清晰的表达，保留必要的背景和限制。简短的内容也必须准确，不要添加来源没有支持的例子。' },
    { title: 'Café, “quotes” & useful detail ✨', body: 'Mixed scripts: Hindi हिंदी · Arabic العربية · 中文. Keep context, uncertainty and attribution.' },
  ] };
  const fingerprints = new Set<string>();
  for (const theme of ['dark', 'light'] as const) for (const density of ['standard', 'light'] as const) {
    const images: Buffer[] = [];
    const render = createCarouselRenderer({ storage: { uploadBytes: async (_path, bytes) => { images.push(bytes); }, remove: async () => assert.fail('No cleanup expected') } });
    const result = await render(samples, claim(controls(density, theme)), new AbortController().signal);
    assert.equal(result.length, 5);
    fingerprints.add(outputFingerprint('carousels', { text: '', data: samples })!);
    for (const [index, bytes] of images.entries()) {
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1080);
      assert.equal(metadata.format, 'png'); assert.ok(bytes.length <= 5_000_000);
      const pixel = await sharp(bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
      assert.equal('#' + pixel.subarray(0, 3).toString('hex'), carouselThemes[theme].background);
      if (process.env.RIFLO_CAROUSEL_PROOF_DIR) {
        const directory = process.env.RIFLO_CAROUSEL_PROOF_DIR;
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${theme}-${density}-${index + 1}.png`), bytes);
      }
    }
    if (process.env.RIFLO_CAROUSEL_PROOF_DIR) {
      const thumbs = await Promise.all(images.map(bytes => sharp(bytes).resize(360, 360).png().toBuffer()));
      await sharp({ create: { width: 1800, height: 360, channels: 4, background: '#777777' } }).composite(thumbs.map((input, index) => ({ input, left: index * 360, top: 0 }))).png().toFile(join(process.env.RIFLO_CAROUSEL_PROOF_DIR, `${theme}-${density}-mobile.png`));
    }
  }
  assert.equal(fingerprints.size, 1, 'Presentation does not change copy deduplication.');
  for (const density of ['standard', 'light'] as const) {
    const boundary = plan(); boundary.slides[0] = { title: 'W'.repeat(density === 'light' ? 60 : 80), body: 'W'.repeat(density === 'light' ? 160 : 240) };
    const render = createCarouselRenderer({ storage: { uploadBytes: async (path, bytes) => {
      if (process.env.RIFLO_CAROUSEL_PROOF_DIR && path.endsWith('/slide-1.png')) await sharp(bytes).resize(360, 360).png().toFile(join(process.env.RIFLO_CAROUSEL_PROOF_DIR, `${density}-maximum-copy-mobile.png`));
    }, remove: async () => {} } });
    assert.equal((await render(boundary, claim(controls(density)), new AbortController().signal)).length, 5);
  }
});

test('renderer enforces Light density before uploading any image', async () => {
  const input = plan(); input.slides[0]!.title = 'x'.repeat(61);
  let uploads = 0;
  const renderer = createCarouselRenderer({ storage: { uploadBytes: async () => { uploads++; }, remove: async () => {} } });
  await assert.rejects(renderer(input, claim(controls('light')), new AbortController().signal), (error: any) => error.code === 'invalid_generated_output' && error.validation.limit === 60);
  assert.equal(uploads, 0);
});
