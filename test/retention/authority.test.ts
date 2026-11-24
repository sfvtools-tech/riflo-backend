import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { activatePaidPlan } from '../helpers/access.js';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { admittedRetention, readRetentionContext } from '../../src/access/retention-firestore.js';
import { createGenerationStore, generationRequestFingerprint } from '../../src/generation/firestore.js';
import { createGenerationService } from '../../src/generation/service.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
async function fixture(run: (db: ReturnType<typeof getFirestore>, uid: string) => Promise<void>) {
  const uid = `retention-authority-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  try { await run(db, uid); }
  finally { await db.recursiveDelete(db.collection('accounts').doc(uid)); await db.collection('subscriptionGrants').doc(uid).delete(); await db.terminate(); await deleteApp(app); }
}

test('ordinary paid activation creates authority and rejects foreign tenure ownership', local, async () => fixture(async (db, uid) => {
  const access = await activatePaidPlan(db, uid, start, start + day);
  const context = await readRetentionContext(db, uid, access, []);
  assert.deepEqual(admittedRetention(access, start, context), { kind: 'paid', tenureId: access.retention!.paidTenureId });
  assert.equal((await db.collection('accounts').doc(uid).collection('retentionTenures').get()).size, 1);
  const tenure = db.collection('accounts').doc(uid).collection('retentionTenures').doc(access.retention!.paidTenureId!);
  await tenure.update({ uid: 'another-owner' });
  const foreign = await readRetentionContext(db, uid, access, []);
  assert.throws(() => admittedRetention(access, start, foreign), /unavailable/);
}));

for (const promote of [false, true]) test(`generation snapshots respect logical expiry before cleanup (paid promotion: ${promote})`, local, async () => fixture(async (db, uid) => {
  let now = start;
  const lifecycle = createLifecycleStore(db, { now: () => now });
  await lifecycle.startTrial(uid, start);
  const project = db.collection('accounts').doc(uid).collection('projects').doc('snapshot-project');
  const batchRef = project.collection('generation').doc('batch');
  const selection = { x_posts: 1, linkedin_posts: 0 };
  const request = { focus: 'Private source direction' };
  const controls = resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} });
  const key = 'snapshot-request';
  const fingerprint = generationRequestFingerprint(selection, undefined, undefined, request);
  await project.set({ uid, id: project.id, status: 'source_expired' });
  await batchRef.set({ id: 'snapshot-batch', uid, projectId: project.id, status: 'completed', slots: [], selection, transcriptReady: true, createdAt: start, updatedAt: start, controls,
    keyHash: createHash('sha256').update(key).digest('hex'), fingerprint,
    snapshotExpiresAt: start + 30 * day, snapshotCleanupAt: start + 30 * day,
    snapshotRetention: { version: 1, kind: 'trial', startsAt: start, promisedUntil: start + 30 * day } });
  const store = createGenerationStore(db);
  const service = createGenerationService({ store, now: () => now });
  if (promote) {
    now = start + 5 * day;
    await lifecycle.transition(uid, 'snapshot-activation', { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: randomUUID(), startsAt: iso(now), expiresAt: iso(start + 35 * day) });
  }
  now = start + 40 * day;
  if (promote) {
    assert.equal((await service.get(uid, project.id)).controls!.focus, request.focus, 'The stale trial deadline must not hide paid-retained content.');
  } else {
    assert.equal((await service.get(uid, project.id)).controls, undefined);
    assert.equal((await service.start(uid, project.id, { outputs: { x_posts: 1 }, controls: request }, key)).controls, undefined);
    assert.equal((await store.start(uid, project.id, key, selection, now, undefined, undefined, { request, snapshot: controls })).controls, undefined);
    assert.equal((await batchRef.get()).data()!.controls.focus, request.focus, 'Read filtering must not mutate the stored snapshot.');
  }
  await batchRef.update({ snapshotRetention: FieldValue.delete() });
  assert.equal((await service.get(uid, project.id)).controls, undefined);
  assert.equal((await service.get(uid, project.id)).status, 'completed');
}));

test('missing admission authority leaves imports, generation reservations and request receipts unchanged', local, async () => fixture(async (db, uid) => {
  const { createProjectStore } = await import('../../src/projects/firestore.js');
  const account = db.collection('accounts').doc(uid);
  const grant = { status: 'active', startsAt: iso(start), expiresAt: iso(start + day), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 100])) };
  await db.collection('subscriptionGrants').doc(uid).set(grant);
  const source = { fileId: 'fixture-video', name: 'Video', mimeType: 'video/mp4', bytes: 100, durationSeconds: 10, requiresProbe: false };
  const imports = createProjectStore(db);
  const id = randomUUID();
  await assert.rejects(imports.create({ uid, id, key: 'missing-authority-import', input: { fileId: source.fileId }, source, now: start }), { code: 'retention_unavailable' });
  for (const collection of ['projects', 'intakeKeys', 'allowances', 'processing']) assert.equal((await account.collection(collection).get()).size, 0, collection);
  assert.equal((await db.collection('intakeJobs').doc(id).get()).exists, false);

  await db.collection('subscriptionGrants').doc(uid).delete();
  const managed = await activatePaidPlan(db, uid, start, start + day);
  await db.collection('subscriptionGrants').doc(uid).update({ retention: FieldValue.delete() });
  const project = account.collection('projects').doc(id);
  const stored = { id, uid, source, status: 'source_ready', sourceAllowanceConsumed: true, reservedSourceSeconds: 0, period: 'fixture-period', storagePath: `accounts/${uid}/projects/${id}/source/video.mp4`, importedAt: start, sourceExpiresAt: start + 60 * day, sourceRetention: { version: 1, kind: 'paid', tenureId: managed.retention!.paidTenureId, promisedUntil: start + 60 * day } };
  await project.set(stored);
  const store = createGenerationStore(db);
  await assert.rejects(store.start(uid, id, 'missing-authority-generation', { x_posts: 1, linkedin_posts: 0 }, start), { code: 'retention_unavailable' });
  assert.deepEqual((await project.get()).data(), stored);
  for (const collection of ['generation', 'generationRequests']) assert.equal((await project.collection(collection).get()).size, 0, collection);
  for (const collection of ['allowances', 'processing']) assert.equal((await account.collection(collection).get()).size, 0, collection);
  assert.equal((await db.collection('generationJobs').where('uid', '==', uid).get()).size, 0);
}));

test('archived request replay hides expired brand snapshots at the deadline without altering stored history', local, async () => fixture(async (db, uid) => {
  await createLifecycleStore(db).startTrial(uid, start);
  const project = db.collection('accounts').doc(uid).collection('projects').doc('archived-project');
  await project.set({ id: project.id, uid, status: 'source_expired' });
  const selection = { x_posts: 1, linkedin_posts: 0 };
  const key = 'archived-brand-request';
  const keyHash = createHash('sha256').update(key).digest('hex');
  const fingerprint = generationRequestFingerprint(selection);
  const brand = { status: 'applied' as const, profile: { name: 'Private saved brand' } };
  const deadline = start + 30 * day;
  const archived = { id: 'archived-batch', uid, projectId: project.id, status: 'completed', slots: [], selection, createdAt: start, updatedAt: start, brand, keyHash, fingerprint,
    snapshotExpiresAt: deadline, snapshotCleanupAt: deadline, snapshotRetention: { version: 1, kind: 'trial', startsAt: start, promisedUntil: deadline } };
  await project.collection('generation').doc(`history-${archived.id}`).set(archived);
  await project.collection('generation').doc('batch').set({ ...archived, id: 'current-batch', keyHash: 'different-request' });
  await project.collection('generationRequests').doc(keyHash).set({ batchId: archived.id, fingerprint });
  const store = createGenerationStore(db);
  assert.deepEqual((await store.lookup!(uid, project.id, key, selection, undefined, undefined, undefined, deadline - 1))!.brand, brand);
  for (const now of [deadline, deadline + day]) {
    assert.equal((await store.lookup!(uid, project.id, key, selection, undefined, undefined, undefined, now))!.brand, undefined);
    const replay = await store.start(uid, project.id, key, selection, now);
    assert.equal(replay.brand, undefined);
    assert.equal(replay.id, archived.id);
    assert.equal(replay.status, 'completed');
  }
  assert.deepEqual((await project.collection('generation').doc(`history-${archived.id}`).get()).data(), archived);
}));


for (const failure of ['missing', 'malformed', 'missing promotion'] as const) test(`cleanup preserves promoted trial content when access authority is ${failure}`, local, async () => fixture(async (db, uid) => {
  const { createProjectStore } = await import('../../src/projects/firestore.js');
  let now = start;
  const lifecycle = createLifecycleStore(db, { now: () => now });
  await lifecycle.startTrial(uid, start);
  const project = db.collection('accounts').doc(uid).collection('projects').doc('promoted-trial');
  const sourcePath = `accounts/${uid}/projects/${project.id}/source/video.mp4`;
  await project.set({ id: project.id, uid, status: 'source_ready', attempts: 0, period: 'trial-period', reservedSourceSeconds: 0, deadline: start + day,
    storagePath: sourcePath, importedAt: start, sourceExpiresAt: start + 14 * day, sourceCleanupAt: start + 14 * day,
    sourceRetention: { version: 1, kind: 'trial', startsAt: start, promisedUntil: start + 14 * day } });
  const output = project.collection('outputs').doc('trial-output');
  await output.set({ id: output.id, uid, projectId: project.id, feature: 'x_posts', text: 'Saved content', expiresAt: start + 30 * day, cleanupAt: start + 30 * day,
    retention: { version: 1, kind: 'trial', startsAt: start, promisedUntil: start + 30 * day } });
  now = start + 5 * day;
  const paid = await lifecycle.transition(uid, 'trial-promotion', { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: randomUUID(), startsAt: iso(now), expiresAt: iso(start + 35 * day) });
  const access = db.collection('subscriptionGrants').doc(uid);
  if (failure === 'missing') await access.delete();
  else if (failure === 'malformed') await access.set({ ...paid, retention: { version: 1, paidTenureId: 123 } });
  else await access.update({ 'retention.trialPromotion': FieldValue.delete() });
  now = start + 31 * day;
  await createGenerationStore(db).cleanup(now);
  await createProjectStore(db).remove(uid, project.id, now, true);
  const savedOutput = (await output.get()).data()!;
  assert.equal(savedOutput.text, 'Saved content');
  assert.equal(savedOutput.retentionCleanupError, 'retention_facts_unavailable');
  assert.equal(savedOutput.cleanupAt, null);
  const savedProject = (await project.get()).data()!;
  assert.equal(savedProject.storagePath, sourcePath);
  assert.equal(savedProject.status, 'source_ready');
  assert.equal(savedProject.sourceCleanupError, 'retention_facts_unavailable');
  assert.equal(savedProject.sourceCleanupAt, null);
}));
