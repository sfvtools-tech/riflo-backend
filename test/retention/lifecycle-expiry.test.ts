import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { emptyCounters } from '../../src/access/accounting.js';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { unknownUsage } from '../../src/generation/service.js';
import { createProjectStore } from '../../src/projects/firestore.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const start = Date.parse('2026-10-01T00:00:00Z');
const day = 86_400_000;
const iso = (at: number) => new Date(at).toISOString();
const result = <T>(value: T) => ({ value, usage: unknownUsage(), provider: 'fixture', model: 'fixture', promptVersion: 'fixture', rates: null });

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); }
  finally {
    for (const name of ['intakeJobs', 'generationJobs', 'assetCleanup']) {
      const entries = await f.db.collection(name).where(name === 'assetCleanup' ? 'owner.uid' : 'uid', '==', f.uid).get();
      await Promise.all(entries.docs.map(doc => doc.ref.delete()));
    }
    await f.db.recursiveDelete(f.account);
    await f.db.collection('subscriptionGrants').doc(f.uid).delete();
    await f.db.terminate(); await deleteApp(f.app);
  }
}
async function setup() {
  const uid = `lifecycle-expiry-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  let clock = start;
  const lifecycle = createLifecycleStore(db, { now: () => clock });
  const imports = createProjectStore(db);
  const generation = createGenerationStore(db);
  const imported = async (at: number) => {
    const project = await imports.create({ uid, id: randomUUID(), key: randomUUID(), now: at, input: { fileId: 'source' }, source: { fileId: 'source', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true } });
    const claim = (await imports.claim('importer', at + 1, 1000)) ?? (await imports.claim('importer', at + 1, 1000));
    assert.ok(claim);
    assert.equal(claim.project.id, project.id);
    const source = { bytes: 9, durationSeconds: 30, sourceSha256: 'a'.repeat(64), storagePath: `accounts/${uid}/projects/${project.id}/source/attempt-${claim.attempt}.video` };
    const transcription = (await generation.claimImport!(claim, source, at + 2))!;
    assert.equal(await generation.saveTranscript(transcription, result({ text: 'A useful source idea.', words: [{ text: 'Idea.', start: 0, end: 5 }] }), at + 3), true);
    assert.equal(await imports.complete(claim, source, at + 4), true);
    return account.collection('projects').doc(project.id);
  };
  return { uid, app, db, account, lifecycle, imports, generation, imported, setNow: (at: number) => { clock = at; } };
}

test('a valid trial transcript expires after worker downtime, rejects stale delivery and releases pending funding once', local, async () => fixture(async f => {
  const trial = await f.lifecycle.startTrial(f.uid, start);
  const project = await f.imported(start);
  const transcript = project.collection('transcripts').doc('shared');
  const deadline = start + 30 * day;
  assert.deepEqual((await transcript.get()).data()!.retention, { version: 1, kind: 'trial', startsAt: start, promisedUntil: deadline });
  await f.generation.start(f.uid, project.id, 'pending-trial-output', { x_posts: 1, linkedin_posts: 0 }, start + 5);
  const claim = (await f.generation.claim('writer', start + 6, 1000))!;
  assert.ok(claim);
  const ledger = f.account.collection('allowances').doc(`shared-${trial.trial!.allowancePeriodId}`);
  const before = (await ledger.get()).data()!;
  assert.equal(before.reserved.creationCredits, 1);
  assert.ok(await f.generation.transcript(f.uid, project.id, deadline - 1));
  assert.equal(await f.generation.transcript(f.uid, project.id, deadline), null);
  // This abandoned claim also exceeds its lease and batch deadline; the read assertions above isolate retention.
  assert.equal(await f.generation.renew(claim, deadline, 1000), false);
  assert.equal(await f.generation.markProviderInvoked(claim, { provider: 'fixture', model: 'fixture', rates: null }, deadline), false);
  assert.equal(await f.generation.saveOutput(claim, result('A stale output.'), deadline), false);
  await f.generation.cleanup(deadline);
  assert.equal((await transcript.get()).exists, false);
  // Cleanup removes the payload; the queue reconciles the abandoned reservation.
  assert.equal(await f.generation.claim('reconciler', deadline, 1000), null);
  const after = (await ledger.get()).data()!;
  assert.deepEqual(after, { ...before, reserved: { ...before.reserved, creationCredits: 0 } });
  assert.equal((await f.generation.batch(f.uid, project.id))!.status, 'failed');
  await f.generation.cleanup(deadline + 1);
  assert.equal(await f.generation.claim('reconciler', deadline + 1, 1000), null);
  assert.equal(await f.generation.saveOutput(claim, result('Another stale output.'), deadline + 1), false);
  assert.deepEqual((await ledger.get()).data(), after);
}));

test('actual source expiry releases split trial and paid video funding once and preserves unrelated balances', local, async () => fixture(async f => {
  const trial = await f.lifecycle.startTrial(f.uid, start);
  const paid = await f.lifecycle.transition(f.uid, 'activate-split-paid', { type: 'activate_paid', expectedRevision: trial.revision, plan: 'lower', periodId: 'split_paid_period', startsAt: iso(start), expiresAt: iso(start + 31 * day) });
  const trialLedger = f.account.collection('allowances').doc(`shared-${trial.trial!.allowancePeriodId}`);
  const paidLedger = f.account.collection('allowances').doc(`shared-${paid.paid!.grant.allowancePeriodId}`);
  const counters = emptyCounters();
  counters.consumed.creationCredits = 13;
  await trialLedger.set(counters);
  const project = await f.imported(start);
  const waiting = await f.imported(start + 10);
  const batch = await f.generation.start(f.uid, project.id, 'split-video-expiry', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, start + 20);
  assert.deepEqual(batch.slots[0]!.charge!.allocations!.map(owner => owner.amount), [2, 2]);
  await f.generation.start(f.uid, waiting.id, 'unrelated-output-reservation', { x_posts: 1, linkedin_posts: 0 }, start + 21);
  const before = await Promise.all([trialLedger, paidLedger].map(async ref => (await ref.get()).data()!));
  assert.deepEqual(before.map(value => value.reserved.creationCredits), [2, 3]);
  const deadline = start + 4 + 60 * day;
  assert.equal((await project.get()).data()!.sourceExpiresAt, deadline);
  await f.imports.remove(f.uid, project.id, deadline - 1, true);
  assert.deepEqual(await Promise.all([trialLedger, paidLedger].map(async ref => (await ref.get()).data()!)), before);
  await f.imports.remove(f.uid, project.id, deadline, true);
  assert.equal((await project.get()).data()!.status, 'source_expired');
  assert.equal((await f.generation.batch(f.uid, project.id))!.slots[0]!.errorCode, 'source_expired');
  const after = await Promise.all([trialLedger, paidLedger].map(async ref => (await ref.get()).data()!));
  assert.deepEqual(after, before.map((value, index) => ({ ...value, reserved: { ...value.reserved, creationCredits: index === 0 ? 0 : 1 } })));
  assert.equal((await f.generation.batch(f.uid, waiting.id))!.slots[0]!.status, 'pending');
  await f.imports.remove(f.uid, project.id, deadline + 1, true);
  assert.deepEqual(await Promise.all([trialLedger, paidLedger].map(async ref => (await ref.get()).data()!)), after);
}));

test('backdated paid startsAt cannot revive an archive expired before the actual transition', local, async () => fixture(async f => {
  const paidEnd = start + day;
  const paid = await f.lifecycle.transition(f.uid, 'original-paid-period', { type: 'activate_paid', expectedRevision: 0, plan: 'lower', periodId: 'original_paid_period', startsAt: iso(start), expiresAt: iso(paidEnd) });
  const project = await f.imported(start);
  const batch = await f.generation.start(f.uid, project.id, 'archived-paid-output', { x_posts: 1, linkedin_posts: 0 }, start + 5);
  const claim = (await f.generation.claim('writer', start + 6, 1000))!;
  assert.equal(await f.generation.saveOutput(claim, result('An archived useful source idea.'), start + 7), true);
  const deadline = paidEnd + 60 * day;
  assert.ok(await f.generation.output(f.uid, project.id, batch.slots[0]!.id, deadline - 1));
  assert.equal(await f.generation.output(f.uid, project.id, batch.slots[0]!.id, deadline), null);
  f.setNow(deadline + 1);
  const renewed = await f.lifecycle.transition(f.uid, 'backdated-paid-renewal', { type: 'renew', expectedRevision: paid.revision, plan: 'lower', periodId: 'backdated_paid_period', startsAt: iso(paidEnd), expiresAt: iso(deadline + 30 * day) });
  assert.notEqual(renewed.retention!.paidTenureId, paid.retention!.paidTenureId);
  assert.equal(await f.generation.output(f.uid, project.id, batch.slots[0]!.id, deadline + 1), null);
  const output = project.collection('outputs').doc(batch.slots[0]!.id);
  assert.equal((await output.get()).data()!.retention.tenureId, paid.retention!.paidTenureId);
  await f.generation.cleanup(deadline + 1);
  assert.equal((await output.get()).exists, false);
}));
