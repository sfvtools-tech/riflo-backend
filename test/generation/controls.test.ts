import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../../src/http/app.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createGenerationService, type GenerationBatch, type GenerationStore } from '../../src/generation/service.js';
import { generationRequestFingerprint } from '../../src/generation/firestore.js';
import { createGenerationDefaultsService, parseGenerationControls, parseGenerationDefaults, readGenerationDefaults, resolveGenerationControls, validateControlsWindow, type GenerationDefaults } from '../../src/generation/controls.js';

const selection = { x_posts: 1, linkedin_posts: 0 };
test('controls reject unknown shapes, unselected parameters and invalid windows before work', () => {
  for (const value of [null, [], { cta: 'Buy' }, { focus: 'a'.repeat(501) }, { focus: '\u0000' }, { sourceWindow: { startSeconds: 0, endSeconds: Infinity } }, { sourceWindow: { startSeconds: 3, endSeconds: 2 } }, { sourceWindow: { startSeconds: 0, endSeconds: 2, extra: true } }, { formats: { blogs: {} } }, { formats: { x_posts: { maxPosts: 11 } } }, { formats: { x_posts: { length: 'medium' } } }]) {
    assert.throws(() => parseGenerationControls(value, selection), { code: 'invalid_generation_controls' });
  }
  assert.throws(() => parseGenerationControls({ sourceWindow: { startSeconds: 0, endSeconds: 9 } }, { ...selection, short_videos: 1 }), /ten seconds/);
  const writing = parseGenerationControls({ sourceWindow: { startSeconds: 0, endSeconds: 1 } }, selection);
  validateControlsWindow(writing, 1);
  assert.throws(() => validateControlsWindow(writing, 0.5), /original video/);
  assert.throws(() => validateControlsWindow(writing, null), /original video/);
  for (const input of [{ focus: 'private' }, { sourceWindow: {} }, { uid: 'other' }, { short_videos: { duration: 20 } }]) assert.throws(() => parseGenerationDefaults(input));
});

test('absent fields inherit, explicit Auto wins, reset does not mutate defaults and snapshots copy inputs', async () => {
  const defaults = { x_posts: { length: 'short' as const }, short_videos: { duration: 30 as const, captions: 'off' as const } };
  const saved = await readGenerationDefaults('alice', async uid => { assert.equal(uid, 'alice'); return defaults; });
  const first = resolveGenerationControls({}, selection, saved);
  assert.equal(first.formats.x_posts!.length, 'short');
  assert.equal(first.origins.x_posts!.length, 'saved');
  const request = parseGenerationControls({ focus: '  Topic  ', formats: { x_posts: { length: 'auto' } } }, selection);
  const explicit = resolveGenerationControls(request, selection, saved);
  assert.equal(explicit.formats.x_posts!.length, 'auto');
  assert.equal(explicit.origins.x_posts!.length, 'explicit');
  assert.equal(explicit.focus, 'Topic');
  assert.deepEqual(resolveGenerationControls({}, selection, saved), first);
  defaults.x_posts.length = 'auto' as 'short';
  assert.equal(first.formats.x_posts!.length, 'short');
  const video = resolveGenerationControls({}, { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, saved);
  assert.equal(video.formats.short_videos!.duration, 30);
  assert.equal(video.formats.x_posts, undefined);
});

test('read failures are visible and threads require explicit or saved count and numbering', async () => {
  const failed = await readGenerationDefaults('alice', async () => { throw Error('private'); });
  const fallback = resolveGenerationControls({}, selection, failed);
  assert.equal(fallback.status, 'unavailable');
  assert.equal(fallback.formats.x_posts!.length, 'auto');
  assert.equal(fallback.origins.x_posts!.length, 'builtin');
  for (const x_posts of [{ mode: 'thread' }, { mode: 'thread', maxPosts: 10 }, { mode: 'thread', numbering: 'include' }]) {
    assert.throws(() => resolveGenerationControls(parseGenerationControls({ formats: { x_posts } }, selection), selection, failed), /maximum posts and numbering/);
  }
  const saved = await readGenerationDefaults('alice', async () => ({ x_posts: { maxPosts: 10, numbering: 'exclude' } }));
  const thread = resolveGenerationControls({ formats: { x_posts: { mode: 'thread' } } }, selection, saved);
  assert.deepEqual(thread.formats.x_posts, { length: 'auto', mode: 'thread', maxPosts: 10, numbering: 'exclude' });
});

test('normalized controls fingerprint includes explicit intent and preserves legacy fingerprints', () => {
  const a = parseGenerationControls({ formats: { x_posts: { length: 'short', mode: 'single' } }, focus: ' Topic ' }, selection);
  const b = parseGenerationControls({ focus: 'Topic', formats: { x_posts: { mode: 'single', length: 'short' } } }, selection);
  const fingerprint = (controls?: typeof a) => generationRequestFingerprint(selection, undefined, undefined, controls);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint({}), generationRequestFingerprint(selection));
  assert.notEqual(fingerprint({}), fingerprint({ formats: { x_posts: { length: 'auto' } } }));
});

test('replay returns original snapshot before mutable settings or configuration', async () => {
  const request = parseGenerationControls({ focus: 'Original' }, selection);
  const snapshot = resolveGenerationControls(request, selection, { status: 'unavailable', defaults: {} });
  const batch = { id: 'accepted', controls: snapshot, status: 'completed', slots: [], errorCode: null } as unknown as GenerationBatch;
  let lookedUp = false;
  const store = { lookup: async (_uid: string, _project: string, _key: string, _selection: unknown, _brand: unknown, _intent: unknown, controls: unknown) => { assert.deepEqual(controls, request); lookedUp = true; return batch; }, start: async () => assert.fail('No second acceptance') } as unknown as GenerationStore;
  const service = createGenerationService({ store, processingConfigured: false, readDefaults: async () => assert.fail('No mutable defaults read'), readBrand: async () => assert.fail('No brand read') });
  const result = await service.start('alice', 'project', { outputs: { x_posts: 1 }, controls: request }, 'request-key');
  assert.equal(lookedUp, true);
  assert.deepEqual(result.controls, snapshot);
});

test('new requests without overrides accept saved defaults independently of brand and video uses Off fallback', async () => {
  const accepted: any[] = [];
  const store = { lookup: async () => null, start: async (...args: unknown[]) => { accepted.push(args[7]); return { id: 'batch', status: 'queued', slots: [], errorCode: null }; } } as unknown as GenerationStore;
  let failDefaults = false;
  const service = createGenerationService({ store, readDefaults: async () => { if (failDefaults) throw Error('private'); return { x_posts: { length: 'short' } }; }, readBrand: async () => assert.fail('Brand disabled') });
  await service.start('alice', 'project', { outputs: { x_posts: 1 }, brand: { mode: 'none' } }, 'request-key');
  assert.deepEqual(accepted[0].request, {});
  assert.equal(accepted[0].snapshot.formats.x_posts.length, 'short');
  assert.equal(accepted[0].snapshot.origins.x_posts.length, 'saved');
  failDefaults = true;
  await service.start('alice', 'project', { outputs: { short_videos: 1 } }, 'request-key');
  assert.equal(accepted[1].snapshot.status, 'unavailable');
  assert.equal(accepted[1].snapshot.formats.short_videos.captions, 'off');
  assert.equal(accepted[1].snapshot.origins.short_videos.captions, 'builtin');
});

test('new generation starts both preference reads after authorization and waits for both snapshots', async () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  const authorization = deferred<void>();
  const authorizing = deferred<void>();
  const defaults = deferred<GenerationDefaults>();
  const brand = deferred<{ voice: string }>();
  const bothStarted = deferred<void>();
  const reads: string[] = [];
  let accepted = false;
  const started = (name: string) => { reads.push(name); if (reads.length === 2) bothStarted.resolve(); };
  const store = {
    lookup: async () => null,
    start: async (...args: Parameters<GenerationStore['start']>) => {
      accepted = true;
      assert.deepEqual(args[5]?.snapshot, { status: 'applied', profile: { voice: 'Warm' } });
      assert.equal(args[7]?.snapshot.formats.x_posts?.length, 'short');
      return { id: 'batch', status: 'queued', slots: [], errorCode: null };
    },
  } as unknown as GenerationStore;
  const service = createGenerationService({ store,
    readDefaults: async () => { started('defaults'); return defaults.promise; },
    readBrand: async () => { started('brand'); return brand.promise; },
  });
  const pending = service.start('alice', 'project', { outputs: { x_posts: 1 } }, 'request-key', async () => { authorizing.resolve(); await authorization.promise; });
  await authorizing.promise;
  assert.deepEqual(reads, []);
  authorization.resolve();
  // Neither read is released until both have started: a serial implementation cannot pass.
  await bothStarted.promise;
  assert.deepEqual(reads, ['defaults', 'brand']);
  assert.equal(accepted, false);
  defaults.resolve({ x_posts: { length: 'short' } });
  await defaults.promise;
  assert.equal(accepted, false);
  brand.resolve({ voice: 'Warm' });
  await pending;
  assert.equal(accepted, true);
});

test('replay and rejected requests do not fetch mutable preferences', async () => {
  let reads = 0;
  const read = async () => { reads++; return {}; };
  const batch = { id: 'accepted', status: 'completed', slots: [], errorCode: null } as unknown as GenerationBatch;
  const store = { lookup: async () => null, start: async () => assert.fail('Cannot accept rejected requests') } as unknown as GenerationStore;
  const service = createGenerationService({ store, readDefaults: read, readBrand: read });
  await assert.rejects(service.start('alice', 'project', { outputs: { x_posts: null } }, 'request-key'), { code: 'invalid_outputs' });
  await assert.rejects(service.start('alice', 'project', { controls: { unknown: true } }, 'request-key'), { code: 'invalid_generation_controls' });
  await assert.rejects(service.start('alice', 'project', {}, 'request-key', async () => { throw Error('denied'); }), /denied/);
  await assert.rejects(createGenerationService({ store, processingConfigured: false, readDefaults: read, readBrand: read }).start('alice', 'project', {}, 'request-key'), { code: 'generation_not_configured' });
  store.lookup = async () => batch;
  await service.start('alice', 'project', {}, 'request-key', async () => assert.fail('Replay cannot authorize again'));
  assert.equal(reads, 0);
});

test('availability resolves defaults only after owned-project availability and reports fallback', async () => {
  let owned = false;
  const store = { availability: async () => { owned = true; return { outputs: {} }; } } as unknown as GenerationStore;
  const service = createGenerationService({ store, readDefaults: async uid => { assert.equal(uid, 'alice'); assert.equal(owned, true); throw Error('private'); } });
  const availability = await service.availability('alice', 'project');
  assert.equal(availability.controls.available, true);
  assert.equal(availability.controls.defaultsStatus, 'unavailable');
  assert.deepEqual(availability.controls.defaults, {});
  assert.equal(availability.controls.builtins.short_videos!.captions, 'off');
  const denied = createGenerationService({ store: { availability: async () => { throw Error('not owned'); } } as unknown as GenerationStore, readDefaults: async () => assert.fail('Do not read settings before project access') });
  await assert.rejects(denied.availability('other', 'project'), /not owned/);
});

test('defaults API uses verified ownership, strict replacement, active-write boundary and no allowance writes', async () => {
  const values = new Map<string, GenerationDefaults>();
  const defaults = createGenerationDefaultsService({ read: async uid => values.get(uid) ?? null, save: async (uid, value) => { values.set(uid, value); } });
  let active = true;
  const server = createServer(createHandler({ generationDefaults: defaults, verifyToken: async uid => ({ uid }), now: () => new Date('2026-10-31'), loadGrant: async () => active ? { status: 'active', startsAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 100])) } : null }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (uid: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/generation-defaults`, { method: body === undefined ? 'GET' : 'PUT', headers: { authorization: `Bearer ${uid}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    assert.equal((await request('alice')).body.data.defaults, null);
    assert.equal((await request('alice', { x_posts: { length: 'short' } })).status, 200);
    assert.equal((await request('bob')).body.data.defaults, null);
    assert.equal((await request('alice', { uid: 'bob' })).status, 400);
    await request('alice', { short_videos: { duration: 30 } });
    assert.deepEqual(values.get('alice'), { short_videos: { duration: 30 } });
    assert.equal((await request('alice')).body.data.controls.available, true);
    active = false;
    assert.equal((await request('alice', {})).status, 403);
    assert.equal((await request('alice')).status, 200);
    assert.deepEqual(values.get('alice'), { short_videos: { duration: 30 } });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


test('new video captions default Off while saved and explicit choices keep their precedence', async () => {
  const videos = { x_posts: 0, linkedin_posts: 0, short_videos: 1 };
  for (const savedCaption of [undefined, 'clean', 'off'] as const) {
    const saved = await readGenerationDefaults('alice', async () => parseGenerationDefaults(
      savedCaption ? { short_videos: { captions: savedCaption } } : {},
    ));
    for (const explicitCaption of [undefined, 'clean', 'off'] as const) {
      const request = parseGenerationControls(explicitCaption
        ? { formats: { short_videos: { captions: explicitCaption } } } : undefined, videos);
      const resolved = resolveGenerationControls(request, videos, saved);
      assert.equal(resolved.formats.short_videos!.captions, explicitCaption ?? savedCaption ?? 'off');
      assert.equal(resolved.origins.short_videos!.captions, explicitCaption ? 'explicit' : savedCaption ? 'saved' : 'builtin');
    }
  }
});
