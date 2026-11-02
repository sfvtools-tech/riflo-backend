import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys, type LegacyGrant } from '../../src/access/policy.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createSourceImporter, sourcePath } from '../../src/projects/source.js';
import { createIntakeWorker } from '../../src/projects/worker.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { GenerationError, generationEventId, unknownUsage, type GenerationClaim, type GenerationProviders, type GenerationStore, type Transcript } from '../../src/generation/service.js';
import { liveTranscript } from '../../src/generation/retention.js';
import { queueStorageCleanup } from '../../src/storage/cleanup.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const emulatorOnly = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const transcript: Transcript = { text: 'A useful thought.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'useful', start: 1, end: 2 }, { text: 'thought.', start: 2, end: 3 }] };
const metadata = { provider: 'deepgram', model: 'fixture', rates: { model: 'fixture', capturedAt: new Date(now).toISOString(), inputMicrosPerMillion: null, outputMicrosPerMillion: null, cacheReadMicrosPerMillion: null, cacheWriteMicrosPerMillion: null, transcriptionMicrosPerMinute: 5200 }, promptVersion: null };
const result = { ...metadata, value: transcript, usage: { ...unknownUsage(), seconds: 60 } };
const failure = { ...metadata, code: 'transcription_unavailable', retryable: true, usage: unknownUsage() };

async function fixture() {
  const uid = `import-transcript-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grantRef = db.collection('subscriptionGrants').doc(uid);
  const grant: LegacyGrant = { status: 'active', startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, key === 'sourceSeconds' ? 120 : 2])) as LegacyGrant['limits'] };
  await grantRef.set(grant);
  const intake = createProjectStore(db);
  const generation = createGenerationStore(db);
  const project = await intake.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'fixture' }, source: { fileId: 'fixture', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true } });
  const claim = (await intake.claim('importer', now + 1, 1000))!;
  assert.ok(claim);
  const source = { bytes: 9, durationSeconds: 60, sourceSha256: 'a'.repeat(64), storagePath: sourcePath(uid, project.id, claim.attempt, 'mp4'), mimeType: 'video/mp4' };
  const ref = account.collection('projects').doc(project.id);
  return { uid, app, db, account, grantRef, intake, generation, project, claim, source, ref, async cleanup() {
    for (const name of ['intakeJobs', 'generationJobs']) {
      const jobs = await db.collection(name).where('uid', '==', uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    await db.recursiveDelete(account); await grantRef.delete(); await db.terminate(); await deleteApp(app);
  } };
}

test('staged import transcript is hidden until source settlement and follows only the intake lease', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    assert.ok(claim.importOwner);
    assert.equal((await f.ref.get()).data()?.transcriptionStage, 'preparing_audio');
    assert.equal(await f.generation.claim('other-worker', now + 2000, 1000), null);
    assert.equal(await f.intake.renew(f.claim, now + 900, 3000), true);
    assert.equal(await f.generation.markProviderInvoked(claim, metadata, now + 1100), true, 'intake renewal authorizes dispatch after old generation timestamp');
    assert.equal((await f.ref.get()).data()?.transcriptionStage, 'transcribing');
    assert.equal(await f.generation.saveTranscript(claim, result, now + 1101), true);
    assert.equal((await f.ref.get()).data()?.preparation, 'ready');
    assert.equal((await f.ref.get()).data()?.status, 'importing');
    assert.equal(await f.generation.markProviderInvoked(claim, metadata, now + 1102), false);
    const staged = (await f.ref.collection('transcripts').doc('shared').get()).data()!;
    assert.equal(liveTranscript(staged as never, claim.batch, now + 1101), false);
    assert.equal(await f.generation.transcript(f.uid, f.project.id, now + 1101), null);
    assert.equal((await f.generation.availability!(f.uid, f.project.id, now + 1101)).outputs.x_posts.available, false);
    assert.equal((await f.account.collection('processing').doc('current').get()).data()?.active, f.project.id);
    const before = await f.intake.usage(f.uid, now + 1101);
    assert.equal(before.reserved.sourceSeconds, 60);
    assert.equal(before.consumed.sourceSeconds, 0);
    assert.equal(await f.intake.complete(f.claim, f.source, now + 1102), true);
    assert.deepEqual(await f.generation.transcript(f.uid, f.project.id, now + 1102), transcript);
    assert.equal((await f.ref.get()).data()?.preparation, 'ready');
    const after = await f.intake.usage(f.uid, now + 1102);
    assert.equal(after.consumed.sourceSeconds, 60);
    assert.equal(after.reserved.sourceSeconds, 0);
    assert.equal(after.consumed.x_posts, 0);
    const events = await f.account.collection('usageEvents').where('stage', '==', 'transcribe').get();
    assert.equal(events.size, 1);
    assert.equal(events.docs[0]!.data().cost.amountMicros, 5200);
  } finally { await f.cleanup(); }
});

test('paid eager failure keeps source and requires an explicit free-standing transcript retry', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    assert.equal(await f.generation.markProviderInvoked(claim, metadata, now + 3), true);
    assert.equal(await f.generation.fail(claim, failure, now + 4), true);
    assert.equal(await f.intake.complete(f.claim, f.source, now + 5), true);
    assert.equal(await f.generation.claim('worker', now + 10_000, 1000), null);
    const saved = (await f.ref.get()).data()!;
    assert.equal(saved.status, 'source_ready'); assert.equal(saved.storagePath, f.source.storagePath); assert.equal(saved.preparation, 'failed');
    const availability = await f.generation.availability!(f.uid, f.project.id, now + 6);
    assert.equal(availability.outputs.x_posts.reason, 'transcript_not_ready');
    assert.equal(availability.transcription?.retryAvailable, true);
    await assert.rejects(f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 1, linkedin_posts: 0 }, now + 6), { code: 'transcript_not_ready' });
    const before = await f.intake.usage(f.uid, now + 6);
    await f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 0, linkedin_posts: 0 }, now + 7, undefined, 'transcription_retry');
    assert.deepEqual(await f.intake.usage(f.uid, now + 8), before);
    const retry = (await f.generation.claim('retry-worker', now + 8, 1000))!;
    assert.ok(retry); assert.equal(retry.importOwner, undefined);
    assert.equal(await f.generation.saveTranscript(retry, result, now + 9), true);
    assert.equal((await f.ref.get()).data()?.preparation, 'ready');
  } finally { await f.cleanup(); }
});

for (const dispatched of [false, true]) test(`expired intake ownership fences stale results and ${dispatched ? 'stops paid replay' : 'allows bounded undispatched recovery'}`, emulatorOnly, async () => {
  const f = await fixture();
  try {
    const original = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    if (dispatched) await f.generation.markProviderInvoked(original, metadata, now + 3);
    assert.equal(await f.generation.markProviderInvoked(original, metadata, now + 1002), false);
    assert.equal(await f.generation.saveTranscript(original, result, now + 1002), false);
    const next = (await f.intake.claim('replacement', now + 1002, 1000))!;
    assert.ok(next);
    const resumedSource = { ...f.source, storagePath: sourcePath(f.uid, f.project.id, next.attempt, 'mp4') };
    const resumed = await f.generation.claimImport!(next, resumedSource, now + 1003);
    if (dispatched) {
      assert.equal(resumed, null);
      assert.equal((await f.generation.batch(f.uid, f.project.id))?.status, 'failed');
    } else {
      assert.ok(resumed); assert.equal(resumed.attempt, 2);
      assert.equal(await f.generation.markProviderInvoked(original, metadata, now + 1004), false);
      assert.equal(await f.generation.saveTranscript(resumed, result, now + 1004), true);
    }
  } finally { await f.cleanup(); }
});

test('matching staged transcript survives upload retry without another ASR claim', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    await f.generation.markProviderInvoked(claim, metadata, now + 3);
    await f.generation.saveTranscript(claim, result, now + 4);
    await f.intake.fail(f.claim, { code: 'source_import_failed', retryable: true, bytes: 9 }, now + 5);
    const next = (await f.intake.claim('retry-import', now + 3000, 1000))!;
    assert.ok(next);
    const source = { ...f.source, storagePath: sourcePath(f.uid, f.project.id, next.attempt, 'mp4') };
    assert.equal(await f.generation.claimImport!(next, source, now + 3001), null);
    await assert.rejects(f.generation.claimImport!(next, { ...source, sourceSha256: 'b'.repeat(64) }, now + 3001), { code: 'source_changed' });
    assert.equal(await f.intake.complete(next, source, now + 3002), true);
    assert.deepEqual(await f.generation.transcript(f.uid, f.project.id, now + 3002), transcript);
    assert.equal((await f.account.collection('usageEvents').where('stage', '==', 'transcribe').get()).size, 1);
  } finally { await f.cleanup(); }
});

test('actual source allowance is checked before creating a paid attempt', emulatorOnly, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.generation.claimImport!(f.claim, { ...f.source, durationSeconds: 121 }, now + 2), { code: 'allowance_exceeded' });
    assert.equal((await f.account.collection('usageEvents').where('stage', '==', 'transcribe').get()).size, 0);
    assert.equal((await f.ref.collection('generation').get()).size, 0);
  } finally { await f.cleanup(); }
});

test('cleanup preserves a prior-attempt upload receipt still owned by the current import', emulatorOnly, async () => {
  const f = await fixture();
  const cleanupRef = f.db.collection('assetCleanup').doc(`${f.project.id}-receipt-test`);
  try {
    assert.equal(await f.intake.checkpointSource!(f.claim, f.source, now + 2), true);
    await f.intake.fail(f.claim, { code: 'source_import_failed', retryable: true, bytes: 9 }, now + 3);
    const next = (await f.intake.claim('replacement', now + 3000, 1000))!;
    assert.ok(next); assert.equal(next.attempt, 2);
    await f.db.runTransaction(async transaction => { queueStorageCleanup(transaction, cleanupRef, [f.source.storagePath], now + 3001); });
    const removed: string[] = [];
    await createGenerationStore(f.db, { remove: async path => { removed.push(path); } }).cleanup(now + 3002);
    assert.ok(!removed.includes(f.source.storagePath), 'The exact retained receipt must survive unrelated queued cleanup.');
    assert.equal((await f.ref.get()).data()?.importUpload.storagePath, f.source.storagePath);
  } finally { await cleanupRef.delete(); await f.cleanup(); }
});

test('missing dispatch evidence stops recovery instead of assuming the ASR request was free', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    await f.account.collection('usageEvents').doc(generationEventId(f.project.id, claim.batch.id, 'transcribe', null, claim.attempt)).delete();
    const next = (await f.intake.claim('replacement', now + 1002, 1000))!;
    assert.equal(await f.generation.claimImport!(next, { ...f.source, storagePath: sourcePath(f.uid, f.project.id, next.attempt, 'mp4') }, now + 1003), null);
    assert.equal((await f.generation.batch(f.uid, f.project.id))?.transcriptionFailure?.code, 'transcription_interrupted');
  } finally { await f.cleanup(); }
});

test('proven pre-dispatch failure resumes against the saved source with the normal worker', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    await f.generation.fail(claim, { ...failure, code: 'audio_extraction_failed' }, now + 3);
    await f.intake.complete(f.claim, f.source, now + 4);
    const resumed = (await f.generation.claim('normal-worker', now + 3000, 1000))!;
    assert.ok(resumed); assert.equal(resumed.importOwner, undefined); assert.equal(resumed.attempt, 2);
    assert.equal(resumed.project.storagePath, f.source.storagePath);
    await f.generation.markProviderInvoked(resumed, metadata, now + 3001);
    await f.generation.saveTranscript(resumed, result, now + 3002);
    assert.equal((await f.ref.get()).data()?.preparation, 'ready');
  } finally { await f.cleanup(); }
});

for (const exhausted of [false, true]) test(`an eager undispatched retry that ${exhausted ? 'exhausts its attempt budget' : 'expires'} offers explicit recovery`, emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    await f.generation.fail(claim, { ...failure, code: 'audio_extraction_failed' }, now + 3);
    await f.intake.complete(f.claim, f.source, now + 4);
    await f.ref.collection('generation').doc('batch').update(exhausted ? { transcriptionAttempts: 3 } : { deadline: now + 100 });
    assert.equal(await f.generation.claim('normal-worker', now + 3000, 1000), null);
    const batch = (await f.generation.batch(f.uid, f.project.id))!;
    assert.equal(batch.status, 'failed');
    assert.equal(batch.transcriptionFailure?.code, exhausted ? 'transcription_attempts_exhausted' : 'transcription_expired');
    assert.equal((await f.ref.get()).data()?.preparation, 'failed');
    assert.equal((await f.generation.availability!(f.uid, f.project.id, now + 3001)).transcription?.retryAvailable, true);
    const before = await f.intake.usage(f.uid, now + 3001);
    await f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 0, linkedin_posts: 0 }, now + 3002, undefined, 'transcription_retry');
    assert.deepEqual(await f.intake.usage(f.uid, now + 3002), before);
  } finally { await f.cleanup(); }
});

test('revoked eager preparation permits explicit retry after access returns without silently dispatching', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    await f.generation.fail(claim, { ...failure, code: 'audio_extraction_failed' }, now + 3);
    await f.intake.complete(f.claim, f.source, now + 4);
    const grant = (await f.grantRef.get()).data()!;
    await f.grantRef.delete();
    assert.equal(await f.generation.claim('normal-worker', now + 3000, 1000), null);
    const batch = (await f.generation.batch(f.uid, f.project.id))!;
    assert.equal(batch.status, 'failed');
    assert.deepEqual(batch.transcriptionFailure, { code: 'subscription_required', retryable: true });
    assert.equal((await f.ref.get()).data()?.preparation, 'failed');
    const unavailable = await f.generation.availability!(f.uid, f.project.id, now + 3001);
    assert.equal(unavailable.transcription?.retryAvailable, false);
    assert.equal(unavailable.transcription?.reason, 'subscription_required');
    await f.grantRef.set(grant);
    assert.equal((await f.generation.availability!(f.uid, f.project.id, now + 3002)).transcription?.retryAvailable, true);
    assert.equal(await f.generation.claim('normal-worker', now + 3003, 1000), null, 'restoring access must not enqueue another paid request');
    const before = await f.intake.usage(f.uid, now + 3003);
    const retry = await f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 0, linkedin_posts: 0 }, now + 3004, undefined, 'transcription_retry');
    assert.equal(retry.intent, 'transcription_retry');
    assert.deepEqual(await f.intake.usage(f.uid, now + 3004), before);
    const events = await f.account.collection('usageEvents').where('stage', '==', 'transcribe').get();
    assert.ok(events.docs.every(doc => doc.data().providerInvoked === false));
  } finally { await f.cleanup(); }
});

test('configuration failure leaves a retryable transcript and a retained source', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    const unavailable = async (): Promise<never> => { throw new GenerationError(503, 'transcription_configuration_failed', 'Not configured.'); };
    await createGenerationWorker({ store: f.generation, providers: { transcribe: unavailable, generate: unavailable }, now: () => now + 3 }).runClaim(claim);
    await f.intake.complete(f.claim, f.source, now + 4);
    assert.equal((await f.generation.availability!(f.uid, f.project.id, now + 5)).transcription?.retryAvailable, true);
    const before = await f.intake.usage(f.uid, now + 5);
    await f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 0, linkedin_posts: 0 }, now + 6, undefined, 'transcription_retry');
    assert.deepEqual(await f.intake.usage(f.uid, now + 6), before);
    assert.equal((await f.ref.get()).data()?.storagePath, f.source.storagePath);
  } finally { await f.cleanup(); }
});

test('a lost transcript commit reply preserves succeeded usage and never reissues ASR', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    let calls = 0;
    const providers = { transcribe: async (_project, _signal, onRequest) => { calls++; await onRequest(metadata); return result; } } as GenerationProviders;
    const store = { ...f.generation, saveTranscript: async (...args: Parameters<GenerationStore['saveTranscript']>) => { await f.generation.saveTranscript(...args); throw new Error('Lost commit reply.'); } };
    await createGenerationWorker({ store, providers, now: () => now + 3 }).runClaim(claim);
    assert.equal(await f.generation.claimImport!(f.claim, f.source, now + 4), null);
    await f.intake.complete(f.claim, f.source, now + 5);
    assert.equal(calls, 1);
    const event = (await f.account.collection('usageEvents').doc(generationEventId(f.project.id, claim.batch.id, 'transcribe', null, claim.attempt)).get()).data()!;
    assert.equal(event.status, 'succeeded'); assert.equal(event.cost.amountMicros, 5200);
    assert.deepEqual(await f.generation.transcript(f.uid, f.project.id, now + 6), transcript);
  } finally { await f.cleanup(); }
});

test('eager projects offer explicit recovery after their saved transcript expires or is cleaned', emulatorOnly, async () => {
  const f = await fixture();
  try {
    const claim = (await f.generation.claimImport!(f.claim, f.source, now + 2))!;
    await f.generation.saveTranscript(claim, result, now + 3);
    await f.intake.complete(f.claim, f.source, now + 4);
    await f.ref.collection('transcripts').doc('shared').delete();
    const state = await f.generation.availability!(f.uid, f.project.id, now + 5);
    assert.equal(state.outputs.x_posts.reason, 'transcript_not_ready');
    assert.equal(state.transcription?.retryAvailable, true);
    await f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 0, linkedin_posts: 0 }, now + 6, undefined, 'transcription_retry');
  } finally { await f.cleanup(); }
});

test('fresh import completes local ASR and upload before first Create, which claims generation directly', { ...emulatorOnly, timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    let downloads = 0, uploads = 0, asr = 0;
    const transcription = createGenerationWorker({ store: f.generation, now: () => now + 3, providers: { transcribe: async (_project, _signal, onRequest, local) => {
      asr++; assert.ok(local); assert.equal(await readFile(local, 'utf8'), 'sourcevid'); await onRequest(metadata); return result;
    } } as GenerationProviders });
    const importer = createSourceImporter({
      files: { download: async () => { downloads++; return { body: new Response('sourcevid').body!, totalBytes: 9, finished: Promise.resolve(), cleanup: async () => undefined }; } },
      storage: { upload: async () => { uploads++; }, remove: async () => assert.fail('Successful upload must remain.') },
      prepare: async path => ({ path, durationSeconds: 60, extension: 'mp4' }),
      checkpoint: async (claim, source) => { assert.equal(await f.intake.checkpointSource!(claim, source, now + 3), true); },
      transcribe: async (claim, source, signal, local) => { const work = await f.generation.claimImport!(claim, source, now + 2); if (work) await transcription.runClaim(work, signal, local); },
    });
    const progressWrites: Promise<unknown>[] = [];
    const worker = createIntakeWorker({ store: { ...f.intake, claim: async () => f.claim, progress: (...args) => { const write = f.intake.progress!(...args); progressWrites.push(write); return write; } }, importSource: importer, now: () => now + 4 });
    assert.equal(await worker.runOnce(), true);
    // Advisory writes can finish after runOnce; retire this test-owned SDK only after they settle.
    await Promise.all(progressWrites);
    assert.equal((await f.ref.get()).data()?.preparation, 'ready');
    assert.deepEqual(await f.generation.transcript(f.uid, f.project.id, now + 5), transcript);
    await f.generation.start(f.uid, f.project.id, randomUUID(), { x_posts: 1, linkedin_posts: 0 }, now + 6);
    const created = (await f.generation.claim('content-worker', now + 7, 1000))!;
    assert.ok(created); assert.equal(created.stage, 'generate');
    assert.deepEqual({ downloads, uploads, asr }, { downloads: 1, uploads: 1, asr: 1 });
  } finally { await f.cleanup(); }
});

test('local import worker shares cancellation and never renews a second lease', async () => {
  let renewed = 0, path: string | undefined, saved = false;
  const claim = { project: { id: 'project', uid: 'alice', source: { durationSeconds: 60 } }, batch: { deadline: now + 60_000 }, importOwner: { workerId: 'intake', attempt: 1, operationId: 'operation' }, stage: 'transcribe' } as GenerationClaim;
  const store = { renew: async () => { renewed++; return true; }, markProviderInvoked: async () => true, saveTranscript: async () => { saved = true; return true; }, fail: async () => assert.fail('Unexpected failure') } as unknown as GenerationStore;
  const providers = { transcribe: async (_project, signal, onRequest, local) => {
    path = local; assert.equal(signal.aborted, false); await onRequest(metadata);
    await new Promise(resolve => setTimeout(resolve, 30)); return result;
  } } as GenerationProviders;
  await createGenerationWorker({ store, providers, now: () => now, leaseMilliseconds: 15 }).runClaim(claim, undefined, '/private/import/prepared.mp4');
  assert.equal(path, '/private/import/prepared.mp4'); assert.equal(renewed, 0); assert.equal(saved, true);
});
