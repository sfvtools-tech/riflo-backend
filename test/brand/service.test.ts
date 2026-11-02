import assert from 'node:assert/strict';
import test from 'node:test';
import { BrandError, createBrandService, type BrandProfile } from '../../src/brand/service.js';

function fixture() {
  const saved = new Map<string, BrandProfile>();
  const service = createBrandService({
    read: async (uid) => saved.get(uid) ?? null,
    save: async (uid, profile) => { saved.set(uid, structuredClone(profile)); },
  });
  return { saved, service };
}

test('optional brand defaults normalize text and stay isolated between accounts', async () => {
  const { service } = fixture();
  assert.equal(await service.get('alice'), null);
  assert.deepEqual(await service.replace('alice', {
    name: '  Example  ', description: 'Teaching\nwith examples', audience: 'Creators',
    voice: 'Direct', language: 'English', spelling: 'British', writingExample: 'First line\nSecond line',
    avoidPhrases: [' hustle '], colours: ['#fF8200'], fonts: ['Inter'],
  }), {
    name: 'Example', description: 'Teaching\nwith examples', audience: 'Creators',
    voice: 'Direct', language: 'English', spelling: 'British', writingExample: 'First line\nSecond line',
    avoidPhrases: ['hustle'], colours: ['#fF8200'], fonts: ['Inter'],
  });
  assert.equal(await service.get('bob'), null);
  await service.replace('bob', { name: 'Bob' });
  assert.equal((await service.get('alice'))?.name, 'Example');
  assert.deepEqual(await service.get('bob'), { name: 'Bob' });
  assert.deepEqual(await service.replace('alice', { name: ' ', fonts: [], colours: [], avoidPhrases: [] }), { fonts: [], colours: [], avoidPhrases: [] });
  assert.deepEqual(await service.replace('alice', {}), {});
  assert.deepEqual(await service.get('alice'), {});
});

test('brand validation rejects malformed values before saving and accepts exact text/list bounds', async () => {
  const { service, saved } = fixture();
  const bounds = { name: 120, description: 2000, audience: 1000, voice: 1000, language: 80, spelling: 80, writingExample: 8000 };
  const invalid: unknown[] = [null, [], 'profile', 1, { uid: 'bob' }, { owner: 'bob' }, { unknown: true },
    { name: null }, { name: 3 }, { name: 'bad\u0000value' }, { writingExample: 'bad\u007fvalue' },
    { avoidPhrases: 'one' }, { avoidPhrases: [1] }, { avoidPhrases: [null] },
    { avoidPhrases: ['x'.repeat(121)] }, { avoidPhrases: Array(31).fill('x') },
    { colours: ['red'] }, { colours: ['#123'] }, { colours: ['#12345678'] }, { colours: ['#GGGGGG'] },
    { colours: Array(9).fill('#123456') }, { fonts: Array(6).fill('Font') }, { fonts: ['x'.repeat(101)] },
    { fonts: [false] }, { colours: null }, { fonts: {} },
    ...Object.entries(bounds).map(([field, max]) => ({ [field]: 'x'.repeat(max + 1) })),
  ];
  for (const input of invalid) {
    await assert.rejects(service.replace('alice', input), (error: unknown) => error instanceof BrandError && error.status === 400, JSON.stringify(input));
  }
  assert.equal(saved.size, 0);
  const atLimit = Object.fromEntries(Object.entries(bounds).map(([field, max]) => [field, 'x'.repeat(max)]));
  assert.deepEqual(await service.replace('alice', atLimit), atLimit);
  await service.replace('alice', { avoidPhrases: Array(30).fill('x'.repeat(120)), colours: Array(8).fill('#123456'), fonts: Array(5).fill('x'.repeat(100)) });
});

test('saved internal metadata is excluded from brand reads', async () => {
  const service = createBrandService({
    read: async () => ({ name: 'Example', privateToken: 'never-return', uid: 'other' }) as BrandProfile,
    save: async () => { throw Error('Read must not write.'); },
  });
  assert.deepEqual(await service.get('alice'), { name: 'Example' });
});
