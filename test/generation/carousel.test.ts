import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createCarouselRenderer } from '../../src/generation/carousel.js';
import { assetPath } from '../../src/generation/asset-paths.js';
import { validateCarousel } from '../../src/generation/validation.js';
import { parseSelection, type CarouselContent, type GenerationClaim } from '../../src/generation/service.js';

const plan = (): CarouselContent => ({ status: 'ok', slides: Array.from({ length: 5 }, (_, index) => ({ title: `Idea ${index + 1}: Café & "quotes"`, body: 'Use plain source-based text with care & check each result.' })) });
const claim = (attempt = 1) => ({ project: { uid: 'alice', id: 'project-id' }, slot: { id: 'carousels-1' }, attempt } as GenerationClaim);

function createRenderFixture(failure?: 'third-upload' | 'existing') {
  const images = new Map<string, Buffer>();
  const removed: string[] = [];
  let uploads = 0;
  const existing = assetPath('alice', 'project-id', 'carousels-1', 1, 1);
  if (failure === 'existing') images.set(existing, Buffer.from('existing-object'));
  const render = createCarouselRenderer({ storage: {
    uploadBytes: async (path, bytes) => {
      uploads++;
      if (images.has(path)) throw Object.assign(Error('Already exists.'), { code: 412 });
      if (failure === 'third-upload' && uploads === 3) throw Error('Upload interrupted.');
      images.set(path, bytes);
    },
    remove: async (path) => { removed.push(path); images.delete(path); },
  } });
  return { render, images, removed, uploads: () => uploads, existing };
}

test('carousel plans require exactly five bounded plain-text slides and one output per request', () => {
  assert.equal(validateCarousel(plan()).content.slides.length, 5);
  assert.throws(() => validateCarousel({ status: 'insufficient_source', slides: [] }), { code: 'insufficient_source', retryable: false });
  for (const value of [null, { ...plan(), slides: plan().slides.slice(1) }, { ...plan(), extra: 'field' }, { ...plan(), slides: [...plan().slides, plan().slides[0]] }]) {
    assert.throws(() => validateCarousel(value));
  }
  for (const title of ['x'.repeat(81), 'word '.repeat(13), '<img src=x>', 'https://evil.example', '**bold**', 'title\nline']) {
    const invalid = plan();
    invalid.slides[0]!.title = title;
    assert.throws(() => validateCarousel(invalid));
  }
  for (const body of ['x'.repeat(241), 'word '.repeat(46), '[link](/path)', '![asset](image.png)', 'body\u0000text']) {
    const invalid = plan();
    invalid.slides[0]!.body = body;
    assert.throws(() => validateCarousel(invalid));
  }
  assert.deepEqual(parseSelection({ carousels: 1 }), { x_posts: 0, linkedin_posts: 0, carousels: 1 });
  assert.throws(() => parseSelection({ carousels: 2 }));
});

test('the real renderer produces five valid private 1080 square PNGs with escaped text', async () => {
  const fixture = createRenderFixture();
  const assets = await fixture.render(plan(), claim(), new AbortController().signal);
  assert.equal(assets.length, 5);
  assert.equal(fixture.images.size, 5);
  for (const asset of assets) {
    const bytes = fixture.images.get(asset.storagePath)!;
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1080);
    assert.equal(asset.contentType, 'image/png');
    assert.equal(asset.bytes, bytes.length);
    assert.ok(asset.storagePath.startsWith('accounts/alice/projects/project-id/outputs/'));
  }
  const retried = await fixture.render(plan(), claim(2), new AbortController().signal);
  assert.ok(retried.every((asset) => !assets.some((previous) => previous.storagePath === asset.storagePath)));
});

test('partial uploads are removed while an existing object remains untouched', async () => {
  const failed = createRenderFixture('third-upload');
  await assert.rejects(failed.render(plan(), claim(), new AbortController().signal), { code: 'carousel_render_failed' });
  assert.equal(failed.images.size, 0);
  assert.equal(failed.removed.length, 3);
  const existing = createRenderFixture('existing');
  await assert.rejects(existing.render(plan(), claim(), new AbortController().signal), { code: 'carousel_render_failed' });
  assert.equal(existing.images.get(existing.existing)!.toString(), 'existing-object');
  assert.deepEqual(existing.removed, []);
});

test('an aborted carousel does not upload any images', async () => {
  const fixture = createRenderFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.render(plan(), claim(), controller.signal));
  assert.equal(fixture.uploads(), 0);
});
