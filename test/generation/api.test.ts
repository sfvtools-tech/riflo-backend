import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import sharp from 'sharp';
import { createHandler, AuthenticationError } from '../../src/http/app.js';
import { buildCapabilities, featureIds, quotaKeys, type FeatureId } from '../../src/access/policy.js';
import { createGenerationService, generationBodyLimit, GenerationError, type GenerationBatch, type GenerationStore, type GeneratedOutput, type GenerationAvailability } from '../../src/generation/service.js';
import { brandLanguages, brandLimits } from '../../src/brand/service.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const grant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, 1800])) };

async function withApi(run: (request: (path: string, options?: { token?: string; method?: string; body?: string; key?: string }) => Promise<{ status: number; text: string; headers: Headers; bytes: Buffer }>) => Promise<void>, configured = true, activeGrant: unknown = grant, outputOverride: Partial<GeneratedOutput> = {}, assetBytes = Buffer.alloc(0), options: { generationConfigured?: boolean; processingConfigured?: boolean; implementedFeatures?: readonly FeatureId[]; transcription?: GenerationAvailability['transcription']; batchOverride?: Partial<GenerationBatch> } = {}) {
  const batch: GenerationBatch = { uid: 'alice', projectId: 'project-id', status: 'completed', selection: { x_posts: 1, linkedin_posts: 0 }, slots: [{ id: 'output-id', feature: 'x_posts', ordinal: 1, status: 'ready', attempts: 1, errorCode: null }], createdAt: now, updatedAt: now, deadline: now + 86_400_000, period: 'private-period', transcriptionAttempts: 1, transcriptReady: true, errorCode: null, ...options.batchOverride };
  const output: GeneratedOutput = { id: 'output-id', feature: 'x_posts', text: 'A useful idea from the source.', createdAt: now, expiresAt: now + 30 * 86_400_000, model: 'test-model', promptVersion: 'test-version', ...outputOverride };
  const unused = async (): Promise<never> => { throw Error('Unexpected worker operation.'); };
  const owns = (uid: string, id: string) => uid === 'alice' && id === 'project-id';
  const store: GenerationStore = {
    lookup: async (uid, id, key, selection, _brand, intent) => {
      if (!owns(uid, id) || key !== 'replay-batch-key') return null;
      if (!intent) assert.deepEqual(selection, batch.selection);
      return batch;
    },
    start: async (uid, id, _key, selection) => {
      if (!owns(uid, id)) throw new GenerationError(404, 'project_not_found', 'Project not found.');
      return { ...batch, status: 'queued', selection };
    },
    availability: async (uid, id) => {
      if (!owns(uid, id)) throw new GenerationError(404, 'project_not_found', 'Project not found.');
      const access = buildCapabilities(activeGrant, new Date(now)).subscription;
      return { access, transcription: options.transcription, sourceAvailable: false, transcriptAvailable: true, sourceExpiresAt: new Date(now).toISOString(), transcriptExpiresAt: new Date(now + 1000).toISOString(), activeBatch: false, outputs: Object.fromEntries(featureIds.map(feature => [feature, { available: access.active && feature !== 'short_videos', reason: !access.active ? 'subscription_required' : feature === 'short_videos' ? 'requires_reimport' : 'available' }])) as any };
    },
    batch: async (uid, id) => owns(uid, id) ? batch : null,
    outputs: async (uid, id) => owns(uid, id) ? [output] : [],
    output: async (uid, id, outputId) => owns(uid, id) && outputId === output.id ? output : null,
    asset: async (uid, id, outputId, assetId) => owns(uid, id) && outputId === output.id ? output.assets?.find((asset) => asset.id === assetId) ?? null : null,
    claim: unused, renew: unused, markProviderInvoked: unused, transcript: unused, saveTranscript: unused, saveOutput: unused, fail: unused, cleanup: unused,
  };
  let grantReads = 0;
  const generation = createGenerationService({ store, now: () => now, processingConfigured: options.processingConfigured });
  const server = createServer(createHandler({ verifyToken: async (token) => {
    if (token === 'bad') throw new AuthenticationError();
    return { uid: token };
  }, loadGrant: async () => { grantReads++; return activeGrant; }, now: () => new Date(now), generationConfigured: options.generationConfigured, implementedFeatures: options.implementedFeatures ?? (configured ? featureIds : []), ...(configured ? { generation, readOutputAsset: async (path: string) => {
    assert.ok(output.assets?.some((asset) => asset.storagePath === path));
    return { body: new Response(assetBytes).body!, contentType: output.assets![0]!.contentType };
  } } : {}) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(async (path, options = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (options.key) headers['idempotency-key'] = options.key;
      const previousGrantReads = grantReads;
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: options.body }) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (path.endsWith('/generation/availability')) assert.equal(grantReads, previousGrantReads);
      return { status: response.status, text: bytes.toString(), headers: response.headers, bytes };
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('generation routes require sign-in and reject unsupported selections before work', async () => {
  await withApi(async (request) => {
    for (const token of [undefined, 'bad']) {
      assert.equal((await request('/v1/projects/project-id/generate', { method: 'POST', token })).status, 401);
    }
    for (const body of ['{', '{}', '{"outputs":{"unknown_format":1}}', '{"outputs":{"x_posts":3}}', '{"outputs":{"x_posts":1},"uid":"bob"}']) {
      const result = await request('/v1/projects/project-id/generate', { method: 'POST', token: 'alice', key: body === '{}' ? 'short' : 'valid-request-key', body });
      assert.equal(result.status, 400);
    }
    const accepted = await request('/v1/projects/project-id/generate', { method: 'POST', token: 'alice', key: 'valid-request-key', body: '{"outputs":{"x_posts":1}}' });
    assert.equal(accepted.status, 202);
    assert.equal(JSON.parse(accepted.text).data.status, 'queued');
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
  });
});

test('new generation rejects explicit null counts for every format and preserves omitted selection defaults', async () => {
  await withApi(async request => {
    for (const feature of featureIds) {
      const selected = feature === 'x_posts' ? 'linkedin_posts' : 'x_posts';
      const result = await request('/v1/projects/project-id/generate', {
        method: 'POST', token: 'alice', key: 'new-null-count-key',
        body: JSON.stringify({ outputs: { [selected]: 1, [feature]: null } }),
      });
      assert.equal(result.status, 400, feature);
      assert.equal(JSON.parse(result.text).error.code, 'invalid_outputs', feature);
    }
    const defaults = await request('/v1/projects/project-id/generate', {
      method: 'POST', token: 'alice', key: 'omitted-output-key', body: '{}',
    });
    assert.equal(defaults.status, 202);
  });
});

test('accepted historical null-count requests replay after access and generation configuration are removed', async () => {
  for (const feature of featureIds) {
    const selection = feature === 'x_posts' ? { x_posts: 0, linkedin_posts: 1 } : { x_posts: 1, linkedin_posts: 0 };
    await withApi(async request => {
      const result = await request('/v1/projects/project-id/generate', {
        method: 'POST', token: 'alice', key: 'replay-batch-key',
        body: JSON.stringify({ outputs: { ...selection, [feature]: null } }),
      });
      assert.equal(result.status, 202, feature);
      assert.equal(JSON.parse(result.text).data.status, 'completed', feature);
      assert.equal(JSON.parse(result.text).data.slots[0].id, 'output-id', feature);
    }, true, null, {}, Buffer.alloc(0), { processingConfigured: false, generationConfigured: false, batchOverride: { selection } });
  }
});

test('generation accepts maximum writing overrides in multibyte and escaped JSON while rejecting bodies above its budget', async () => {
  const overrides = Object.fromEntries(Object.entries(brandLimits).filter(([field]) => !['colours', 'fonts'].includes(field)).map(([field, limit]) => [field,
    typeof limit === 'number' ? '界'.repeat(limit) : Array.from({ length: limit.count }, () => '界'.repeat(limit.length)),
  ]));
  const compact = JSON.stringify({ outputs: { x_posts: 1 }, brand: { mode: 'saved', overrides } });
  assert.ok(Buffer.byteLength(compact) > 32_768);
  const escaped = compact.replace(/[\u0080-\uffff]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  await withApi(async request => {
    for (const body of [compact, escaped]) {
      assert.ok(Buffer.byteLength(body) <= generationBodyLimit);
      const result = await request('/v1/projects/project-id/generate', { token: 'alice', method: 'POST', key: 'large-brand-request', body });
      assert.equal(result.status, 202);
    }
    const result = await request('/v1/projects/project-id/generate', { token: 'alice', method: 'POST', key: 'large-brand-request', body: ' '.repeat(generationBodyLimit) + compact });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.text).error.code, 'request_too_large');
  });
});

test('owners can read progress and download plain text while other accounts cannot', async () => {
  await withApi(async (request) => {
    const progress = await request('/v1/projects/project-id/generation', { token: 'alice' });
    assert.equal(progress.status, 200);
    assert.equal(JSON.parse(progress.text).data.slots[0].status, 'ready');
    assert.ok(!progress.text.includes('private-period'));
    assert.ok(!progress.text.includes('alice'));
    const listed = await request('/v1/projects/project-id/outputs', { token: 'alice' });
    assert.equal(JSON.parse(listed.text).data.length, 1);
    const download = await request('/v1/projects/project-id/outputs/output-id/download', { token: 'alice' });
    assert.equal(download.status, 200);
    assert.equal(download.text, 'A useful idea from the source.');
    assert.match(download.headers.get('content-type')!, /^text\/plain/);
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    for (const path of ['/v1/projects/project-id/generation', '/v1/projects/project-id/outputs/output-id', '/v1/projects/project-id/outputs/output-id/download']) {
      assert.equal((await request(path, { token: 'bob' })).status, 404);
    }
    assert.deepEqual(JSON.parse((await request('/v1/projects/project-id/outputs', { token: 'bob' })).text).data, []);
  });
});

test('output list and single JSON preserve content and public metadata while keeping provider and storage details internal', async () => {
  const variants: Partial<GeneratedOutput>[] = [
    {},
    { feature: 'blogs', data: { status: 'ok', title: 'Title', bodyMarkdown: 'Saved article.' } },
    { feature: 'newsletters', data: { status: 'ok', subject: 'Subject', previewText: 'Preview', bodyMarkdown: 'Saved letter.' } },
    { feature: 'carousels', data: { status: 'ok', slides: [{ title: 'Title', body: 'Copy' }] }, assets: [{ id: 'slide-1', storagePath: 'private/slide.png', contentType: 'image/png', bytes: 120, width: 1080, height: 1080 }] },
    { feature: 'short_videos', data: { status: 'ok', segments: [{ startSeconds: 0, endSeconds: 12 }] }, assets: [{ id: 'clip', storagePath: 'private/clip.mp4', contentType: 'video/mp4', bytes: 240, width: 720, height: 1280, durationSeconds: 12 }] },
    { feature: 'short_videos', data: { status: 'ok', startSeconds: 0, endSeconds: 12 } },
  ];
  for (const variant of variants) {
    const stored = Object.assign({ id: 'output-id', feature: 'x_posts' as const, text: 'Saved export.', createdAt: now, expiresAt: now + 30 * 86_400_000, model: 'private-model', promptVersion: 'private-version', ...variant }, { privateWorker: 'private-worker' });
    stored.assets?.forEach(asset => Object.assign(asset, { privateUpload: 'private-upload' }));
    const before = structuredClone(stored);
    await withApi(async request => {
      for (const path of ['/v1/projects/project-id/outputs', '/v1/projects/project-id/outputs/output-id']) {
        const response = await request(path, { token: 'alice' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const data = JSON.parse(response.text).data;
        const value = Array.isArray(data) ? data[0] : data;
        assert.deepEqual(Object.keys(value).sort(), ['id', 'feature', 'text', 'createdAt', 'expiresAt', ...(stored.data ? ['data'] : []), ...(stored.assets ? ['assets'] : [])].sort());
        assert.equal(value.id, stored.id);
        assert.equal(value.feature, stored.feature);
        assert.equal(value.text, stored.text);
        assert.equal(value.createdAt, new Date(stored.createdAt).toISOString());
        assert.equal(value.expiresAt, new Date(stored.expiresAt).toISOString());
        assert.deepEqual(value.data, stored.data);
        assert.doesNotMatch(response.text, /private-|storagePath|promptVersion|"model"/);
        for (const [index, asset] of (stored.assets ?? []).entries()) {
          const { id, contentType, bytes, width, height, durationSeconds } = asset;
          assert.deepEqual(value.assets[index], { id, contentType, bytes, width, height, ...(durationSeconds === undefined ? {} : { durationSeconds }), downloadPath: `/v1/projects/project-id/outputs/output-id/assets/${id}/download` });
        }
      }
      const download = await request('/v1/projects/project-id/outputs/output-id/download', { token: 'alice' });
      assert.equal(download.status, 200);
      assert.equal(download.text, stored.text);
    }, true, null, stored);
    assert.deepEqual(stored, before);
  }
});

test('generation JSON reads, acceptance and archived replay expose only public batch and slot fields', async () => {
  const storedSlot = Object.assign({ id: 'output-id', feature: 'x_posts' as const, ordinal: 1, status: 'ready' as const, attempts: 2, errorCode: null }, { privateWorker: 'private-worker' });
  const stored = { selection: { x_posts: 1, linkedin_posts: 0 }, slots: [storedSlot], brand: { status: 'applied' as const, profile: { voice: 'private-style' } } };
  const before = structuredClone(stored);
  await withApi(async request => {
    for (const [path, options, status] of [
      ['/v1/projects/project-id/generation', {}, 200],
      ['/v1/projects/project-id/generate', { method: 'POST', body: '{"outputs":{"x_posts":1}}', key: 'fresh-batch-key' }, 202],
      ['/v1/projects/project-id/generate', { method: 'POST', body: '{"outputs":{"x_posts":1}}', key: 'replay-batch-key' }, 202],
    ] as const) {
      const response = await request(path, { token: 'alice', ...options });
      assert.equal(response.status, status);
      const value = JSON.parse(response.text).data;
      assert.deepEqual(Object.keys(value).sort(), ['brand', 'errorCode', 'id', 'slots', 'status', 'transcriptReady']);
      assert.deepEqual(Object.keys(value.slots[0]).sort(), ['errorCode', 'feature', 'id', 'status']);
      assert.deepEqual(value.brand, { status: 'applied' });
      assert.equal(value.id, 'batch');
      assert.equal(value.slots[0].id, 'output-id');
      assert.ok(!response.text.includes('private-worker'));
      assert.ok(!response.text.includes('private-style'));
    }
  }, true, grant, {}, Buffer.alloc(0), { batchOverride: stored });
  assert.deepEqual(stored, before);
});

test('public generation errors describe final outcomes rather than an earlier transient failure', async () => {
  const slot = (id: string, status: 'pending' | 'ready' | 'failed', errorCode: string | null) => ({ id, feature: 'x_posts' as const, ordinal: 1, status, attempts: 1, errorCode });
  const cases: Array<{ batch: Partial<GenerationBatch>; errorCode: string | null }> = [
    ...(['queued', 'transcribing', 'generating', 'completed'] as const).map(status => ({ batch: { status, errorCode: 'transcription_unavailable', slots: [slot('one', status === 'completed' ? 'ready' : 'pending', 'old-error')] }, errorCode: null })),
    { batch: { status: 'partial', slots: [slot('one', 'ready', null), slot('two', 'failed', 'invalid_generated_output')] }, errorCode: null },
    { batch: { status: 'failed', errorCode: 'transcription_unavailable', slots: [slot('one', 'failed', 'invalid_generated_output')] }, errorCode: 'invalid_generated_output' },
    { batch: { status: 'failed', slots: [slot('one', 'failed', 'subscription_required'), slot('two', 'failed', 'subscription_required')] }, errorCode: 'subscription_required' },
    { batch: { status: 'failed', errorCode: 'stale-error', slots: [slot('one', 'failed', 'invalid_generated_output'), slot('two', 'failed', 'duplicate_generated_output')] }, errorCode: null },
    { batch: { status: 'failed', errorCode: 'stale-error', slots: [slot('one', 'failed', null), slot('two', 'failed', 'generation_reset')] }, errorCode: null },
    { batch: { status: 'failed', errorCode: 'stale-error', slots: [slot('one', 'failed', 'source_expired'), slot('two', 'pending', null)] }, errorCode: null },
    { batch: { intent: 'transcription_retry', status: 'failed', slots: [], errorCode: 'old-error', transcriptionFailure: { code: 'transcription_interrupted', retryable: true } }, errorCode: 'transcription_interrupted' },
    { batch: { intent: 'transcription_retry', status: 'failed', slots: [], errorCode: 'transcription_failed', transcriptionFailure: null }, errorCode: 'transcription_failed' },
    { batch: { intent: 'transcription_retry', status: 'completed', slots: [], errorCode: 'old-error', transcriptionFailure: { code: 'transcription_failed', retryable: true } }, errorCode: null },
    { batch: { status: 'failed', slots: [], errorCode: 'generation_expired' }, errorCode: 'generation_expired' },
  ];
  for (const { batch, errorCode } of cases) {
    const before = structuredClone(batch);
    await withApi(async request => {
      const response = await request('/v1/projects/project-id/generation', { token: 'alice' });
      assert.equal(response.status, 200);
      const value = JSON.parse(response.text).data;
      assert.equal(value.errorCode, errorCode);
      if (batch.intent) assert.equal(value.intent, batch.intent);
      for (let index = 0; index < value.slots.length; index++) {
        assert.equal(value.slots[index].errorCode, batch.slots![index]!.status === 'failed' ? batch.slots![index]!.errorCode : null);
      }
    }, true, grant, {}, Buffer.alloc(0), { batchOverride: batch });
    assert.deepEqual(batch, before);
  }
});

test('transcription-only JSON acceptance and cached replay keep zero slots and minimal public fields', async () => {
  await withApi(async request => {
    for (const [key, status] of [['fresh-retry-key', 202], ['replay-batch-key', 200]] as const) {
      const result = await request('/v1/projects/project-id/retry-transcription', { token: 'alice', method: 'POST', key, body: '{}' });
      assert.equal(result.status, status);
      const value = JSON.parse(result.text).data;
      assert.deepEqual(Object.keys(value).sort(), ['errorCode', 'id', 'intent', 'slots', 'status', 'transcriptReady']);
      assert.equal(value.intent, 'transcription_retry');
      assert.deepEqual(value.slots, []);
      assert.equal(value.errorCode, null);
    }
  }, true, grant, {}, Buffer.alloc(0), { batchOverride: { intent: 'transcription_retry', status: 'completed', slots: [] } });
});

test('generation authentication failures include a Bearer challenge, not access denials', async () => {
  await withApi(async request => {
    for (const token of [undefined, 'bad']) {
      const result = await request('/v1/projects/project-id/generation', { token });
      assert.equal(result.status, 401);
      assert.equal(result.headers.get('www-authenticate'), 'Bearer');
      assert.equal(JSON.parse(result.text).error.code, 'unauthenticated');
    }
  });
  await withApi(async request => {
    const result = await request('/v1/projects/project-id/generate', { token: 'alice', method: 'POST', body: '{"outputs":{"x_posts":1}}', key: 'denied-request-key' });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('www-authenticate'), null);
  }, true, null);
});

test('missing generation configuration keeps generation disabled and health available', async () => {
  await withApi(async (request) => {
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/v1/projects/project-id/generate', { token: 'alice', method: 'POST', key: 'valid-request-key', body: '{}' })).status, 503);
    const capabilities = JSON.parse((await request('/v1/capabilities', { token: 'alice' })).text).data;
    assert.equal(capabilities.features.x_posts.implemented, false);
    assert.equal(capabilities.features.linkedin_posts.available, false);
  }, false);
});

test('unpaid accounts cannot start generation but can still read their existing outputs', async () => {
  await withApi(async (request) => {
    assert.equal((await request('/v1/projects/project-id/generate', { token: 'alice', method: 'POST', key: 'valid-request-key', body: '{}' })).status, 403);
    assert.equal((await request('/v1/projects/project-id/outputs/output-id', { token: 'alice' })).status, 200);
  }, true, null);
});

test('long-form reads keep structured fields while private downloads remain plain text', async () => {
  const formats: Array<Partial<GeneratedOutput>> = [
    { feature: 'blogs', text: 'A title\n\nA grounded article.', data: { status: 'ok', title: 'A title', bodyMarkdown: 'A grounded article.' } },
    { feature: 'newsletters', text: 'Subject: A subject\nPreview: A preview\n\nA grounded email.', data: { status: 'ok', subject: 'A subject', previewText: 'A preview', bodyMarkdown: 'A grounded email.' } },
  ];
  for (const output of formats) {
    await withApi(async (request) => {
      const read = await request('/v1/projects/project-id/outputs/output-id', { token: 'alice' });
      assert.deepEqual(JSON.parse(read.text).data.data, output.data);
      const download = await request('/v1/projects/project-id/outputs/output-id/download', { token: 'alice' });
      assert.equal(download.text, output.text);
      assert.match(download.headers.get('content-type')!, /^text\/plain/);
      assert.equal(download.headers.get('cache-control'), 'no-store');
      assert.equal((await request('/v1/projects/project-id/outputs/output-id', { token: 'bob' })).status, 404);
    }, true, grant, output);
  }
});

test('carousel images download only through their owner endpoint without exposing storage paths', async () => {
  const bytes = await sharp({ create: { width: 1080, height: 1080, channels: 4, background: '#111827' } }).png().toBuffer();
  const output: Partial<GeneratedOutput> = { feature: 'carousels', assets: [{ id: 'slide-1', storagePath: 'accounts/alice/private-carousel.png', contentType: 'image/png', bytes: bytes.length, width: 1080, height: 1080 }] };
  await withApi(async (request) => {
    const read = await request('/v1/projects/project-id/outputs/output-id', { token: 'alice' });
    const asset = JSON.parse(read.text).data.assets[0];
    assert.equal(asset.storagePath, undefined);
    assert.ok(!read.text.includes('accounts/alice'));
    assert.equal(asset.downloadPath, '/v1/projects/project-id/outputs/output-id/assets/slide-1/download');
    const download = await request(asset.downloadPath, { token: 'alice' });
    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, bytes);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal((await request(asset.downloadPath, { token: 'bob' })).status, 404);
    assert.equal((await request(asset.downloadPath)).status, 401);
    assert.equal((await request('/v1/projects/project-id/outputs/output-id/assets/slide-99/download', { token: 'alice' })).status, 404);
  }, true, grant, output, bytes);
});

test('MP4 downloads preserve private asset bytes and the correct filename and media type', async () => {
  const bytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
  const output: Partial<GeneratedOutput> = { feature: 'short_videos', assets: [{ id: 'clip', storagePath: 'accounts/alice/private-clip.mp4', contentType: 'video/mp4', bytes: bytes.length, width: 720, height: 1280, durationSeconds: 10 }] };
  await withApi(async (request) => {
    const metadata = await request('/v1/projects/project-id/outputs/output-id', { token: 'alice' });
    assert.ok(!metadata.text.includes('accounts/alice'));
    const asset = JSON.parse(metadata.text).data.assets[0];
    const download = await request(asset.downloadPath, { token: 'alice' });
    assert.deepEqual(download.bytes, bytes);
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    assert.match(download.headers.get('content-disposition')!, /clip\.mp4/);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.equal((await request(asset.downloadPath, { token: 'bob' })).status, 404);
    assert.equal((await request(asset.downloadPath)).status, 401);
  }, true, grant, output, bytes);
});

 test('generation availability is private and returns resource-specific decisions before any paid request', async () => {
  await withApi(async request => {
    const path = '/v1/projects/project-id/generation/availability';
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { token: 'bob' })).status, 404);
    const response = await request(path, { token: 'alice' });
    assert.equal(response.status, 200);
    const data = JSON.parse(response.text).data;
    assert.equal(data.sourceAvailable, false);
    assert.equal(data.transcriptAvailable, true);
    assert.equal(data.outputs.x_posts.available, true);
    assert.equal(data.outputs.short_videos.reason, 'requires_reimport');
    assert.deepEqual(data.access, { active: true, reason: 'active', expiresAt: grant.expiresAt });
    assert.deepEqual(data.preferences, { languages: brandLanguages, limits: { audience: 1000, voice: 1000, language: 80, spelling: 80 } });
    assert.ok(!('profile' in data.preferences));
    assert.equal((await request(path + '/download', { token: 'alice' })).status, 404);
  });
});


test('availability respects runtime admission and preserves source and ready-transcript reasons', async () => {
  const path = '/v1/projects/project-id/generation/availability';
  for (const options of [{ generationConfigured: false }, { processingConfigured: false }, { implementedFeatures: [] }]) {
    await withApi(async request => {
      const response = await request(path, { token: 'alice' });
      assert.equal(response.status, 200);
      const data = JSON.parse(response.text).data;
      assert.deepEqual(data.outputs.x_posts, { available: false, reason: 'implementedFeatures' in options ? 'feature_not_implemented' : 'generation_not_configured' });
      assert.equal(data.outputs.short_videos.reason, 'requires_reimport');
      assert.deepEqual(data.transcription, { status: 'ready', retryAvailable: false, reason: 'transcript_ready' });
    }, true, grant, {}, Buffer.alloc(0), { ...options, transcription: { status: 'ready', retryAvailable: false, reason: 'transcript_ready' } });
  }
});

test('availability disables manual transcription only when processing admission is unavailable', async () => {
  for (const options of [{ generationConfigured: false }, { processingConfigured: false }, { implementedFeatures: [] }]) {
    await withApi(async request => {
      const data = JSON.parse((await request('/v1/projects/project-id/generation/availability', { token: 'alice' })).text).data;
      assert.deepEqual(data.transcription, { status: 'failed', retryAvailable: 'implementedFeatures' in options, reason: 'implementedFeatures' in options ? 'available' : 'generation_not_configured', errorCode: 'transcription_unavailable' });
    }, true, grant, {}, Buffer.alloc(0), { ...options, transcription: { status: 'failed', retryAvailable: true, reason: 'available', errorCode: 'transcription_unavailable' } });
  }
});


test('availability returns inactive access without configuration masking its denial', async () => {
  await withApi(async request => {
    const data = JSON.parse((await request('/v1/projects/project-id/generation/availability', { token: 'alice' })).text).data;
    assert.deepEqual(data.access, { active: false, reason: 'subscription_required', expiresAt: null });
    assert.deepEqual(data.outputs.x_posts, { available: false, reason: 'subscription_required' });
    assert.deepEqual(Object.keys(data.preferences).sort(), ['languages', 'limits']);
  }, true, null, {}, Buffer.alloc(0), { generationConfigured: false, implementedFeatures: [] });
});
