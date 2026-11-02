import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrandRequest, resolveGenerationBrand, type GenerationBrandContext } from '../../src/brand/generation.js';
import { createGenerationService, type GenerationBatch, type GenerationStore } from '../../src/generation/service.js';
import { generationRequestFingerprint } from '../../src/generation/firestore.js';

test('writing overrides are normalized, bounded and distinguish clearing from inheritance', () => {
  const request = parseBrandRequest({ mode: 'saved', overrides: { voice: ' ', audience: ' Teachers ', avoidPhrases: [] } });
  assert.deepEqual(request, { mode: 'saved', overrides: { audience: 'Teachers', voice: '', avoidPhrases: [] } });
  for (const value of [null, {}, { mode: 'none', overrides: {} }, { mode: 'saved', overrides: { colours: ['#ffffff'] } }, { mode: 'saved', overrides: { voice: 'a'.repeat(1001) } }, { mode: 'saved', overrides: { uid: 'other' } }]) {
    assert.throws(() => parseBrandRequest(value), { code: 'invalid_request' });
  }
});

test('saved defaults combine with one-time choices and failures never force setup', async () => {
  const saved = { name: 'Example', audience: 'Creators', voice: 'Warm', colours: ['#ffffff'] };
  const read = async (uid: string) => { assert.equal(uid, 'alice'); return saved; };
  assert.deepEqual(await resolveGenerationBrand(parseBrandRequest({ mode: 'saved', overrides: { voice: '', audience: 'Teachers' } }), true, read, 'alice'), { status: 'applied', profile: { name: 'Example', audience: 'Teachers' } });
  assert.equal(saved.voice, 'Warm');
  assert.deepEqual(await resolveGenerationBrand({ mode: 'none' }, true, async () => assert.fail('Must bypass lookup'), 'alice'), { status: 'none' });
  assert.deepEqual(await resolveGenerationBrand({ mode: 'saved' }, false, async () => assert.fail('Videos do not use writing style'), 'alice'), { status: 'not_applicable' });
  assert.deepEqual(await resolveGenerationBrand({ mode: 'saved' }, true, async () => null, 'alice'), { status: 'none' });
  assert.deepEqual(await resolveGenerationBrand({ mode: 'saved' }, true, async () => { throw Error('private'); }, 'alice'), { status: 'unavailable' });
});

test('fingerprints preserve legacy requests and include normalized explicit preferences', () => {
  const selection = { x_posts: 1, linkedin_posts: 0 };
  assert.equal(generationRequestFingerprint(selection), generationRequestFingerprint(selection, { mode: 'saved' }));
  assert.equal(generationRequestFingerprint(selection, parseBrandRequest({ mode: 'saved', overrides: { voice: 'Direct', audience: 'Teachers' } })), generationRequestFingerprint(selection, parseBrandRequest({ mode: 'saved', overrides: { audience: ' Teachers ', voice: 'Direct' } })));
  assert.notEqual(generationRequestFingerprint(selection), generationRequestFingerprint(selection, { mode: 'none' }));
});

test('accepted preferences are snapshotted and replay does not consult a changed saved profile', async () => {
  const base = { uid: 'alice', projectId: 'project', status: 'queued', selection: { x_posts: 1, linkedin_posts: 0 }, slots: [], createdAt: 1, updatedAt: 1, deadline: 999, period: 'period', transcriptionAttempts: 0, transcriptReady: true, errorCode: null } as GenerationBatch;
  let saved: GenerationBatch | null = null;
  let context: GenerationBrandContext | undefined;
  let reads = 0;
  const store = {
    lookup: async () => saved,
    start: async (_uid: string, _project: string, _key: string, _selection: unknown, _now: number, brand?: GenerationBrandContext) => { context = brand; saved = { ...base, brand: brand!.snapshot }; return saved; },
  } as unknown as GenerationStore;
  const profile = { voice: 'Warm', writingExample: 'private sample' };
  const service = createGenerationService({ store, readBrand: async uid => { assert.equal(uid, 'alice'); reads++; return profile; } });
  const first = await service.start('alice', 'project', { outputs: { x_posts: 1 } }, 'request-key');
  assert.deepEqual(first.brand, { status: 'applied' });
  assert.doesNotMatch(JSON.stringify(first), /private sample|Warm/);
  profile.voice = 'New voice';
  assert.equal(context!.snapshot.profile!.voice, 'Warm');
  await service.start('alice', 'project', { outputs: { x_posts: 1 } }, 'request-key');
  assert.equal(reads, 1);
});
