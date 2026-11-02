import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHandler, type Dependencies } from '../../src/http/app.js';
import { createGenerationService, type GenerationStore, type GenerationBatch } from '../../src/generation/service.js';
import { ProjectError } from '../../src/projects/service.js';
import { startTrial } from '../../src/access/lifecycle.js';

const now = Date.parse('2026-10-30T12:00:00Z');
const active = startTrial(null, 'http_trial_abuse_period', now);
async function withApi(overrides: Partial<Dependencies>, run: (request: (path: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const server = createServer(createHandler({ verifyToken: async () => ({ uid: 'alice' }), loadGrant: async () => active, now: () => new Date(now), trialEnabled: true, ...overrides }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run((path, body) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer verified-fixture', 'content-type': 'application/json', 'idempotency-key': 'trial_http_work_01' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('all trial preparation and generation/transcription admission routes enforce backend rate feedback before upstream work', async () => {
  const kinds: boolean[] = [];
  const forbidden = async (): Promise<never> => assert.fail('Rate rejection must precede upstream work');
  const generation = createGenerationService({ store: { lookup: async () => null, start: forbidden } as unknown as GenerationStore });
  await withApi({ prepareTrialWork: async (identity, source) => { assert.equal(identity.uid, 'alice'); kinds.push(Boolean(source)); throw new ProjectError(429, 'trial_rate_limited', 'Wait for the trial request window.', 37); }, generation,
    sourceValidation: forbidden,
    driveFiles: { pickerSession: forbidden, validate: forbidden },
    drive: { authorize: forbidden, complete: forbidden, status: forbidden, disconnect: forbidden },
  }, async request => {
    for (const [path, body] of [ ['/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' }], ['/v1/drive/files/validate', { fileId: 'fixture' }], ['/v1/drive/picker-session', undefined], ['/v1/drive/connection/authorize', {}], ['/v1/projects/project/generate', { outputs: { x_posts: 1 } }], ['/v1/projects/project/retry-transcription', {}] ] as const) {
      const response = await request(path, body);
      assert.equal(response.status, 429, path); assert.equal(response.headers.get('Retry-After'), '37');
      assert.deepEqual((await response.json()).error, { code: 'trial_rate_limited', message: 'Wait for the trial request window.', retryAfterSeconds: 37 });
    }
  });
  assert.deepEqual(kinds, [true, true, true, true, false, false]);
});

test('malformed and unconfigured preparation rejects locally without reserving provider budget', async () => {
  let gated = 0;
  await withApi({ prepareTrialWork: async () => { gated++; }, sourceValidation: async () => assert.fail('Invalid input cannot reach provider'), sourceAvailability: { drive: { configured: false }, youtube: { configured: false } }, driveFiles: { pickerSession: async () => assert.fail(), validate: async () => assert.fail() } }, async request => {
    assert.equal((await request('/v1/sources/youtube/validate', { url: 'not a link' })).status, 400);
    assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' })).status, 503);
    assert.equal((await request('/v1/drive/files/validate', { fileId: 'bad/id' })).status, 400);
  });
  assert.equal(gated, 0);
});

test('accepted generation and transcription replays bypass new-access and provider-budget checks', async () => {
  const batch = { id: 'saved_batch', status: 'queued', slots: [], errorCode: null } as unknown as GenerationBatch;
  const generation = createGenerationService({ store: { lookup: async () => batch, start: async () => assert.fail('Replay cannot readmit work') } as unknown as GenerationStore });
  await withApi({ generation, generationConfigured: false, loadGrant: async () => assert.fail('Accepted replay bypasses new access'), prepareTrialWork: async () => assert.fail('Accepted replay is free') }, async request => {
    assert.equal((await request('/v1/projects/project/generate', { outputs: { x_posts: 1 } })).status, 202);
    assert.equal((await request('/v1/projects/project/retry-transcription', {})).status, 202);
  });
});


test('trial cumulative processing denial stops zero-credit transcription without a misleading retry window', async () => {
  const generation = createGenerationService({ store: { lookup: async () => null, start: async () => assert.fail('Capped trial cannot enqueue transcription') } as unknown as GenerationStore });
  await withApi({ generation, prepareTrialWork: async (_identity, preparation) => {
    assert.equal(preparation, undefined);
    throw new ProjectError(403, 'trial_work_limited', 'The trial processing request limit has been reached. Paid access remains available.');
  } }, async request => {
    const response = await request('/v1/projects/project/retry-transcription', {});
    assert.equal(response.status, 403); assert.equal(response.headers.get('Retry-After'), null);
    assert.equal((await response.json()).error.code, 'trial_work_limited');
  });
});
