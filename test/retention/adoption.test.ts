import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createRetentionAdoption } from '../../src/access/retention-adoption.js';
import { outputFingerprint } from '../../src/generation/history.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const value = await setup();
  try { await run(value); }
  finally {
    await value.db.recursiveDelete(value.account);
    await value.db.collection('subscriptionGrants').doc(value.uid).delete();
    for (const id of value.manifests) await value.db.collection('assetCleanup').doc(id).delete();
    await value.db.terminate();
    await deleteApp(value.app);
  }
}
async function setup() {
  const uid = `adoption-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const project = account.collection('projects').doc('project-one');
  const lifecycle = createLifecycleStore(db, { retentionEnabled: true, now: () => start + day });
  const trial = await lifecycle.startTrial(uid, start);
  const period = `shared-${trial.trial!.allowancePeriodId}`;
  await project.set({ id: project.id, uid, status: 'source_ready', period, sourceExpiresAt: start + 7 * day, sourceRetentionDays: 7, storagePath: `accounts/${uid}/projects/${project.id}/source/attempt-1.mp4`, updatedAt: start + 100 * day });
  const batch = { id: 'original-batch', uid, projectId: project.id, period, status: 'completed', slots: [{ id: 'output-one', feature: 'x_posts', status: 'ready' }], transcriptReady: true, transcriptionAttempts: 1 };
  await project.collection('generation').doc('batch').set(batch);
  const output = project.collection('outputs').doc('output-one');
  await output.set({ id: output.id, feature: 'x_posts', text: 'saved', expiresAt: start + 10 * day });
  return { uid, app, db, account, project, output, lifecycle, period, batch, manifests: [] as string[], adoption: createRetentionAdoption(db, { now: () => start + day }) };
}

test('adoption dry run is read only, recovers only frozen import anchor, preserves floors and is idempotent', local, async () => {
  await fixture(async ({ adoption, uid, project, output }) => {
    const input = { uid, projectId: project.id };
    const dry = await adoption.adoptProject(input);
    assert.equal(dry.eligible, 2);
    assert.equal(dry.applied, 0);
    assert.equal((await project.get()).data()!.sourceRetention, undefined);
    const result = await adoption.adoptProject({ ...input, apply: true });
    assert.equal(result.applied, 2);
    const saved = (await project.get()).data()!;
    assert.equal(saved.importedAt, start);
    assert.equal(saved.sourceRetention.promisedUntil, start + 14 * day);
    assert.equal((await output.get()).data()!.retention.promisedUntil, start + 30 * day);
    const repeated = await adoption.adoptProject({ ...input, apply: true });
    assert.equal(repeated.applied, 0);
    assert.ok(repeated.items.every(item => item.reason === 'already_managed'));
  });
});

test('expired raw output, unknown source anchor, ambiguous slots and cleanup proof stay untouched', local, async () => {
  await fixture(async ({ adoption, uid, project, output, db, manifests, batch }) => {
    await project.update({ sourceRetentionDays: 99 });
    await output.update({ expiresAt: start + day });
    const first = await adoption.adoptProject({ uid, projectId: project.id, apply: true });
    assert.deepEqual(first.items.map(item => item.reason), ['import_anchor_unverified', 'already_expired']);
    await output.update({ expiresAt: start + 10 * day });
    await project.collection('generation').doc('history-duplicate').set(batch);
    const ambiguous = await adoption.adoptProject({ uid, projectId: project.id, apply: true });
    assert.equal(ambiguous.items.at(-1)!.reason, 'accepted_slot_unverified');
    await project.collection('generation').doc('history-duplicate').delete();
    const manifest = createHash('sha256').update(output.path).digest('hex');
    manifests.push(manifest);
    await db.collection('assetCleanup').doc(manifest).set({ paths: [] });
    const deleted = await adoption.adoptProject({ uid, projectId: project.id, apply: true });
    assert.equal(deleted.items.at(-1)!.reason, 'deletion_claimed');
    assert.equal((await output.get()).data()!.retention, undefined);
  });
});

test('transcript adoption follows actual transcription event and historical batch, never cached latest batch', local, async () => {
  await fixture(async ({ adoption, uid, project, account, batch, lifecycle }) => {
    await project.collection('generation').doc('history-original').set(batch);
    const paid = await lifecycle.transition(uid, 'activation-adoption', { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: randomUUID(), startsAt: new Date(start + day).toISOString(), expiresAt: new Date(start + 31 * day).toISOString() });
    await project.collection('generation').doc('batch').set({ ...batch, id: 'cached-consumer', period: `shared-${paid.paid!.grant.allowancePeriodId}`, slots: [] });
    const transcript = project.collection('transcripts').doc('shared');
    await transcript.set({ text: 'original', createdAt: start + 1000, expiresAt: start + 40 * day });
    let result = await adoption.adoptProject({ uid, projectId: project.id });
    assert.equal(result.items.find(item => item.kind === 'transcript')!.reason, 'transcription_origin_unverified');
    await account.collection('usageEvents').doc('actual-transcription').set({ uid, projectId: project.id, batchId: batch.id, stage: 'transcribe', status: 'succeeded', endedAt: start + 1000 });
    result = await adoption.adoptProject({ uid, projectId: project.id, apply: true });
    assert.equal(result.items.find(item => item.kind === 'transcript')!.reason, 'eligible');
    assert.equal((await transcript.get()).data()!.retention.kind, 'trial');
    assert.equal((await transcript.get()).data()!.retention.promisedUntil, start + 91 * day);
  });
});

test('bounded output pages, history overflow, active work and tombstones fail safely', local, async () => {
  await fixture(async ({ adoption, uid, project, batch }) => {
    await assert.rejects(adoption.adoptProject({ uid, projectId: project.id, pageSize: 21 }));
    const page = await adoption.adoptProject({ uid, projectId: project.id, pageSize: 1 });
    assert.equal(page.nextOutputId, 'output-one');
    assert.equal((await adoption.adoptProject({ uid, projectId: project.id, afterOutputId: page.nextOutputId! })).items.filter(item => item.kind === 'output').length, 0);
    await project.collection('retentionDeletions').doc('output-output-one').set({ deletedAt: start });
    assert.equal((await adoption.adoptProject({ uid, projectId: project.id, apply: true })).items.at(-1)!.reason, 'deletion_claimed');
    await project.collection('generation').doc('batch').update({ status: 'generating' });
    assert.ok((await adoption.adoptProject({ uid, projectId: project.id })).items.every(item => item.reason === 'active_work'));
    await project.collection('generation').doc('batch').update({ status: 'completed' });
    const writes = project.firestore.batch();
    for (let index = 0; index < 50; index++) writes.set(project.collection('generation').doc(`history-${index}`), { ...batch, id: `old-${index}`, slots: [] });
    await writes.commit();
    assert.ok((await adoption.adoptProject({ uid, projectId: project.id })).items.every(item => item.reason === 'history_limit'));
  });
});

test('verified old lifecycle facts are created only by apply with adoption-time promotion cutoff', local, async () => {
  await fixture(async ({ adoption, uid, project, db, lifecycle, output }) => {
    await lifecycle.transition(uid, 'old-paid-activation', { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: randomUUID(), startsAt: new Date(start).toISOString(), expiresAt: new Date(start + 31 * day).toISOString() });
    const grant = db.collection('subscriptionGrants').doc(uid);
    await grant.update({ retention: FieldValue.delete() });
    // Expired before the cutoff remains expired even though trial policy would have extended it.
    await output.update({ expiresAt: start + day });
    const dry = await adoption.adoptProject({ uid, projectId: project.id });
    assert.equal(dry.authorityWouldChange, true);
    assert.equal((await grant.get()).data()!.retention, undefined);
    const result = await adoption.adoptProject({ uid, projectId: project.id, apply: true });
    assert.equal(result.applied, 1);
    const saved = (await grant.get()).data()!;
    assert.equal(saved.retention.trialPromotion.at, start + day);
    const tenure = (await db.collection('accounts').doc(uid).collection('retentionTenures').doc(saved.retention.paidTenureId).get()).data()!;
    assert.equal(tenure.activatedAt, start + day);
    assert.equal(tenure.startsAt, start);
    assert.equal(saved.revision, 3);
    assert.equal((await output.get()).data()!.retention, undefined);
    assert.equal((await db.collection('accounts').doc(uid).collection('retentionAdoptions').get()).size, 1);
  });
});

test('fingerprint backfill resumes bounded pages, stays private and requires explicit writer guard to mark complete', local, async () => {
  await fixture(async ({ adoption, uid, project, output }) => {
    const second = project.collection('outputs').doc('output-two');
    await second.set({ id: second.id, feature: 'x_posts', text: 'second', expiresAt: start + 10 * day });
    const dry = await adoption.adoptProject({ uid, projectId: project.id, pageSize: 1, writersUpgraded: true });
    assert.equal(dry.fingerprintsEligible, 1);
    assert.equal(dry.fingerprintsApplied, 0);
    assert.equal((await output.get()).data()!.contentFingerprint, undefined);
    const first = await adoption.adoptProject({ uid, projectId: project.id, pageSize: 1, apply: true, writersUpgraded: true });
    assert.equal(first.dedupComplete, false);
    assert.equal((await project.get()).data()!.dedupVersion, undefined);
    const resumed = await adoption.adoptProject({ uid, projectId: project.id, pageSize: 1, afterOutputId: first.nextOutputId!, apply: true });
    assert.equal(resumed.fingerprintsApplied, 1);
    assert.equal(resumed.dedupComplete, false);
    assert.equal((await project.get()).data()!.dedupVersion, undefined);
    const complete = await adoption.adoptProject({ uid, projectId: project.id, writersUpgraded: true, apply: true });
    assert.equal(complete.dedupComplete, true);
    assert.equal((await project.get()).data()!.dedupVersion, 1);
    assert.equal((await second.get()).data()!.contentFingerprint, outputFingerprint('x_posts', { text: 'second' }));
    assert.equal((await output.get()).data()!.text, 'saved');
  });
});

test('new output before resume cursor blocks completion until full bounded audit proves hashes', local, async () => {
  await fixture(async ({ adoption, uid, project, output }) => {
    const first = await adoption.adoptProject({ uid, projectId: project.id, pageSize: 1, writersUpgraded: true, apply: true });
    assert.equal(first.dedupComplete, true);
    // Simulate a deployment that has not actually met the explicit upgraded-writer guard.
    await project.update({ dedupVersion: FieldValue.delete() });
    const concurrent = project.collection('outputs').doc('output-before');
    await concurrent.set({ id: concurrent.id, feature: 'x_posts', text: 'concurrent', expiresAt: start + 10 * day });
    const resume = await adoption.adoptProject({ uid, projectId: project.id, afterOutputId: output.id, writersUpgraded: true, apply: true });
    assert.equal(resume.dedupComplete, false);
    assert.equal((await project.get()).data()!.dedupVersion, undefined);
    const final = await adoption.adoptProject({ uid, projectId: project.id, writersUpgraded: true, apply: true });
    assert.equal(final.dedupComplete, true);
    assert.equal((await concurrent.get()).data()!.contentFingerprint, outputFingerprint('x_posts', { text: 'concurrent' }));
  });
});

test('large or noncanonical output inventory keeps compatibility deduplication fallback', local, async () => {
  await fixture(async ({ adoption, uid, project, output }) => {
    await output.update({ feature: 'blogs', data: { title: 'incomplete' } });
    assert.equal((await adoption.adoptProject({ uid, projectId: project.id, writersUpgraded: true, apply: true })).dedupComplete, false);
    const writes = project.firestore.batch();
    for (let index = 0; index < 21; index++) writes.set(project.collection('outputs').doc(`many-${index}`), { id: `many-${index}`, feature: 'x_posts', text: `row ${index}`, expiresAt: start + 10 * day });
    await writes.commit();
    const result = await adoption.adoptProject({ uid, projectId: project.id, writersUpgraded: true, apply: true });
    assert.equal(result.fingerprintsApplied, 20);
    assert.equal(result.dedupComplete, false);
    assert.equal((await project.get()).data()!.dedupVersion, undefined);
  });
});

test('historical accepted paid period resolves frozen lifecycle receipt, and apply rereads withdrawn authority', local, async () => {
  await fixture(async ({ adoption, uid, project, db, lifecycle, output }) => {
    const firstPeriod = randomUUID();
    const paid = await lifecycle.transition(uid, 'first-paid-proof', { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: firstPeriod, startsAt: new Date(start + day).toISOString(), expiresAt: new Date(start + 31 * day).toISOString() });
    await project.collection('generation').doc('batch').update({ period: `shared-${firstPeriod}`, sourceFunding: [{ period: 'untrusted-trial-owner' }] });
    const laterLifecycle = createLifecycleStore(db, { retentionEnabled: true, now: () => start + 31 * day });
    await laterLifecycle.transition(uid, 'renew-paid-proof', { type: 'renew', expectedRevision: paid.revision, plan: 'lower', periodId: randomUUID(), startsAt: new Date(start + 31 * day).toISOString(), expiresAt: new Date(start + 61 * day).toISOString() });
    const dry = await adoption.adoptProject({ uid, projectId: project.id });
    assert.equal(dry.items.find(item => item.kind === 'output')!.expiresAt, start + 121 * day);
    await db.collection('subscriptionGrants').doc(uid).update({ withdrawn: true });
    const rejected = await adoption.adoptProject({ uid, projectId: project.id, apply: true });
    assert.equal(rejected.applied, 0);
    assert.ok(rejected.items.every(item => item.reason === 'authority_unverified'));
    assert.equal((await output.get()).data()!.retention, undefined);
  });
});
