import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { createGenerationService } from '../../src/generation/service.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
// Exercise real store transactions against a tiny isolated document adapter; no Firebase initialization.
function documents() {
  const saved = new Map<string, any>();
  const reference = (path: string): any => ({ path,
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => ({ exists: saved.has(path), data: () => structuredClone(saved.get(path)) }),
  });
  const collection = (path: string): any => ({ doc: (id: string) => reference(`${path}/${id}`) });
  const db = { collection, runTransaction: async (run: any) => run({
    get: (ref: any) => ref.get(),
    set: (ref: any, data: any) => saved.set(ref.path, structuredClone(data)),
    create: (ref: any, data: any) => { assert.equal(saved.has(ref.path), false); saved.set(ref.path, structuredClone(data)); },
  }) } as unknown as Firestore;
  saved.set('subscriptionGrants/alice', { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 3600])) });
  return { db, saved };
}

test('durable import identities survive retries and accepted key replay bypasses new admission', async () => {
  const { db, saved } = documents();
  const store = createProjectStore(db);
  const input = { uid: 'alice', id: 'project', key: 'initial-key', input: { fileId: 'video-id' }, now,
    source: { fileId: 'video-id', name: 'Video', mimeType: 'video/mp4', bytes: 12, durationSeconds: 20, requiresProbe: false } };
  const first = await store.create(input);
  assert.match(first.importOperationId!, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(saved.get(`accounts/alice/intakeKeys/${hash(input.key)}`).importOperationId, first.importOperationId);
  assert.equal(saved.get('intakeJobs/project').projectId, first.id);
  saved.delete('intakeJobs/project');
  saved.set('accounts/alice/projects/project', { ...first, status: 'failed', retryAvailableAt: now, updatedAt: now });
  const second = await store.retry({ uid: 'alice', id: first.id, key: 'retry-key', source: input.source, attempts: 0, updatedAt: now, now });
  assert.notEqual(second.importOperationId, first.importOperationId);
  assert.match(second.importOperationId!, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  saved.delete('subscriptionGrants/alice');
  await assert.rejects(store.lookup('alice', input.key, input.input), { code: 'operation_superseded', operation: { projectId: first.id, kind: 'import', id: first.importOperationId } });
  saved.set('accounts/alice/projects/project', { ...second, status: 'source_ready' });
  await assert.rejects(store.lookup('alice', input.key, input.input), { code: 'operation_superseded', operation: { projectId: first.id, kind: 'import', id: first.importOperationId } });
  assert.equal(saved.get('intakeJobs/project').projectId, first.id);
  assert.equal([...saved.keys()].filter(path => path.startsWith('intakeJobs/')).length, 1);
  assert.equal((await store.lookupRetry('alice', first.id, 'retry-key'))!.importOperationId, second.importOperationId);
  await assert.rejects(store.lookup('alice', input.key, { fileId: 'different' }), { code: 'idempotency_conflict' });
  assert.equal(await store.lookup('bob', input.key, input.input), null);
  saved.delete('accounts/alice/projects/project');
  await assert.rejects(store.lookup('alice', input.key, input.input), { code: 'request_unresolved' });
});

test('legacy accepted imports retain JSON recovery without inventing operation identities', async () => {
  const { db, saved } = documents();
  saved.set(`accounts/alice/intakeKeys/${hash('legacy-key')}`, { projectId: 'project', fingerprint: hash(JSON.stringify({ fileId: 'video-id' })) });
  saved.set('accounts/alice/projects/project', { id: 'project', status: 'source_ready' });
  const result = await createProjectStore(db).lookup('alice', 'legacy-key', { fileId: 'video-id' });
  assert.equal(result!.id, 'project');
  assert.equal(result!.importOperationId, undefined);
});

test('real generation lookup resolves archived accepted requests before provider and access gates', async () => {
  const { db, saved } = documents();
  const base = 'accounts/alice/projects/project';
  const selection = { x_posts: 1, linkedin_posts: 0 };
  saved.set(base, { id: 'project', status: 'source_expired' });
  saved.set(`${base}/generation/batch`, { id: 'new-batch', status: 'queued' });
  saved.set(`${base}/generationRequests/${hash('accepted-key')}`, { batchId: 'batch', fingerprint: hash(JSON.stringify(selection)) });
  saved.set(`${base}/generation/history-batch`, { id: 'batch', status: 'partial', selection, slots: [], createdAt: now, updatedAt: now, errorCode: null });
  const service = createGenerationService({ store: createGenerationStore(db), processingConfigured: false });
  const rejected = async () => { throw Error('New admission must not run'); };
  assert.equal((await service.start('alice', 'project', { outputs: { x_posts: 1 } }, 'accepted-key', rejected)).status, 'partial');
  await assert.rejects(service.start('alice', 'project', { outputs: { x_posts: 2 } }, 'accepted-key', rejected), { code: 'idempotency_conflict' });
  await assert.rejects(service.start('alice', 'project', { outputs: { x_posts: 1 } }, 'new-request-key', rejected), { code: 'generation_not_configured' });
  await assert.rejects(service.start('bob', 'project', { outputs: { x_posts: 1 } }, 'accepted-key', rejected), { code: 'project_not_found' });
});

test('accepted UUID v4 import and generation identities replay unchanged', async () => {
  const { db, saved } = documents();
  const projectId = 'ef075f0f-7772-4d2e-932f-e026f0b5c016';
  const importId = 'cb141841-51d0-4b93-971b-69559a4f5bf1';
  const batchId = 'dc87a3b6-e195-4fc9-9f20-29bbba226e31';
  const outputId = 'ea3dd6b7-6490-4495-85e5-e820446c99b7';
  const base = `accounts/alice/projects/${projectId}`;
  const input = { fileId: 'video-id' };
  const selection = { x_posts: 1, linkedin_posts: 0 };
  saved.set(base, { id: projectId, importOperationId: importId, status: 'source_expired' });
  saved.set(`accounts/alice/intakeKeys/${hash('v4-import-key')}`, { projectId, importOperationId: importId, fingerprint: hash(JSON.stringify(input)) });
  saved.set(`${base}/generation/batch`, { id: batchId, status: 'completed', selection, slots: [{ id: outputId, feature: 'x_posts', status: 'ready' }], keyHash: hash('v4-generation-key'), fingerprint: hash(JSON.stringify(selection)) });
  saved.delete('subscriptionGrants/alice');
  const before = structuredClone([...saved]);
  const project = await createProjectStore(db).lookup('alice', 'v4-import-key', input);
  assert.equal(project!.id, projectId);
  assert.equal(project!.importOperationId, importId);
  const store = createGenerationStore(db);
  const batch = await store.lookup!('alice', projectId, 'v4-generation-key', selection);
  assert.equal(batch!.id, batchId);
  assert.equal(batch!.slots[0]!.id, outputId);
  assert.deepEqual(await store.start('alice', projectId, 'v4-generation-key', selection, now), batch);
  assert.deepEqual([...saved], before);
});
