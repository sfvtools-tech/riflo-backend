import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys, type LegacyGrant as Grant } from '../../src/access/policy.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { sourcePath } from '../../src/projects/source.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { createGenerationService, unknownUsage, type AttemptResult, type Transcript } from '../../src/generation/service.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { createHandler } from '../../src/http/app.js';
import { firestoreOperations } from '../../src/http/operations.js';
import { rejectsTranscriptionSource, transcriptionAvailability, transcriptionSourceRulesVersion } from '../../src/generation/transcription.js';
import type { Project } from '../../src/projects/service.js';

const now = Date.parse('2026-10-29T12:00:00Z');
const emulatorOnly = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const transcript: Transcript = { text: 'A practical thought.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'practical', start: 1, end: 2 }, { text: 'thought.', start: 2, end: 3 }] };
const result = <T>(value: T): AttemptResult<T> => ({ value, usage: { ...unknownUsage(), seconds: 60 }, provider: 'deepgram', model: 'fixture', rates: { model: 'fixture', capturedAt: new Date(now).toISOString(), inputMicrosPerMillion: null, outputMicrosPerMillion: null, cacheReadMicrosPerMillion: null, cacheWriteMicrosPerMillion: null, transcriptionMicrosPerMinute: 5200 }, promptVersion: null });

test('transcription retry eligibility distinguishes source, failure, access and completed transcript', () => {
  const project = { status: 'source_ready', storagePath: 'stored', sourceExpiresAt: now + 1000 } as Project;
  assert.equal(transcriptionAvailability(project, undefined, false, true, now).reason, 'transcription_not_failed');
  assert.equal(transcriptionAvailability(project, undefined, false, false, now).reason, 'subscription_required');
  assert.equal(transcriptionAvailability(project, undefined, false, true, now + 1000).reason, 'requires_reimport');
  assert.equal(transcriptionAvailability(project, undefined, true, true, now).reason, 'transcript_ready');
  assert.equal(rejectsTranscriptionSource('audio_too_large'), true);
  assert.equal(rejectsTranscriptionSource('invalid_transcript', { reason: 'empty_text', field: 'text' }), true);
  assert.equal(rejectsTranscriptionSource('invalid_transcript', { reason: 'invalid_shape', field: 'transcript' }), false);
  assert.equal(rejectsTranscriptionSource('transcription_failed'), false);
  for (const [code, expected] of [['transcription_configuration_failed', true], ['transcription_failed', true], ['invalid_transcript', false], ['audio_too_large', false]] as const) {
    const batch = { status: 'failed', transcriptionAttempts: 1, transcriptReady: false, errorCode: code, transcriptionFailure: { code, retryable: false } } as Parameters<typeof transcriptionAvailability>[1];
    assert.equal(transcriptionAvailability(project, batch, false, true, now).retryAvailable, expected, code);
  }
  const legacy = { status: 'failed', transcriptionAttempts: 1, transcriptReady: false, errorCode: 'transcription_failed' } as Parameters<typeof transcriptionAvailability>[1];
  assert.equal(transcriptionAvailability(project, legacy, false, true, now).retryAvailable, true);
});

async function withStore(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try { await run(context); }
  finally {
    for (const name of ['intakeJobs', 'generationJobs']) {
      const jobs = await context.db.collection(name).where('uid', '==', context.uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    await context.db.recursiveDelete(context.account);
    await context.grantRef.delete();
    await context.db.terminate();
    await deleteApp(context.app);
  }
}

async function setup() {
  const uid = `retry-transcript-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grantRef = db.collection('subscriptionGrants').doc(uid);
  const grant: Grant = { status: 'active', startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, key === 'sourceSeconds' ? 60 : 2])) as Grant['limits'] };
  await grantRef.set(grant);
  const intake = createProjectStore(db);
  const store = createGenerationStore(db);
  let clock = now;
  const service = createGenerationService({ store, now: () => clock });
  const project = await intake.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'fixture' }, source: { fileId: 'fixture', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true } });
  const imported = await intake.claim('importer', ++clock, 1000);
  assert.ok(imported);
  assert.equal(await intake.complete(imported, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, imported.attempt) }, ++clock), true);
  // Legacy first-generation failures must still support the explicit retry endpoint.
  await account.collection('projects').doc(project.id).update({ preparation: FieldValue.delete() });
  const failedTranscript = async (retryable = true) => {
    await store.start(uid, project.id, randomUUID(), { x_posts: 1, linkedin_posts: 0 }, ++clock);
    for (let index = 0; index < (retryable ? 3 : 1); index++) {
      clock += 10_000;
      const claim = await store.claim('initial-worker', clock, 1000);
      assert.ok(claim);
      await store.markProviderInvoked(claim, { provider: 'deepgram', model: 'fixture', rates: null }, clock);
      assert.equal(await store.fail(claim, { code: retryable ? 'transcription_unavailable' : 'audio_too_large', retryable, usage: unknownUsage(), provider: 'deepgram', model: 'fixture', rates: null }, clock + 1), true);
    }
    clock += 10_000;
    assert.equal((await store.batch(uid, project.id))!.status, 'failed');
  };
  return { uid, app, db, account, grant, grantRef, intake, store, service, project, failedTranscript, clock: () => clock, advance: (milliseconds = 1) => { clock += milliseconds; return clock; } };
}

test('a failed transcription retries only the stored source, without output or source allowance changes', emulatorOnly, async () => {
  await withStore(async ({ uid, db, account, intake, store, service, project, failedTranscript, clock }) => {
    await failedTranscript();
    const before = await intake.usage(uid, clock());
    assert.equal(before.consumed.sourceSeconds, 60);
    assert.equal(before.reserved.sourceSeconds, 0);
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
    const accepted = await Promise.all(Array.from({ length: 4 }, () => service.retryTranscription(uid, project.id, 'manual-retry-key')));
    assert.equal(new Set(accepted.map(batch => batch.id)).size, 1);
    const batch = accepted[0]!;
    assert.equal(batch.intent, 'transcription_retry');
    assert.deepEqual(batch.slots, []);
    assert.deepEqual(await service.retryTranscription(uid, project.id, 'manual-retry-key'), batch);
    await assert.rejects(service.retryTranscription(uid, project.id, 'concurrent-retry-key'), { code: 'generation_in_progress' });
    await assert.rejects(service.start(uid, project.id, { outputs: { x_posts: 1 } }, 'manual-retry-key'), { code: 'idempotency_conflict' });
    let calls = 0;
    const worker = createGenerationWorker({ store, now: clock, providers: {
      transcribe: async (source, _signal, mark) => { calls++; assert.equal(source.storagePath, project.storagePath ?? sourcePath(uid, project.id, 1)); await mark({ provider: 'deepgram', model: 'fixture', rates: result(transcript).rates }); return result(transcript); },
      generate: async () => assert.fail('Retry transcription must not generate an output.'),
    } });
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(calls, 1);
    assert.equal((await store.batch(uid, project.id))!.status, 'completed');
    assert.deepEqual(await store.outputs(uid, project.id, clock()), []);
    assert.deepEqual(await intake.usage(uid, clock()), before);
    const events = (await account.collection('usageEvents').get()).docs.map(doc => doc.data());
    const transcriptions = events.filter(event => event.stage === 'transcribe');
    assert.equal(transcriptions.length, 4);
    assert.equal(transcriptions.filter(event => event.status === 'failed').length, 3);
    assert.equal(transcriptions.find(event => event.status === 'succeeded')!.cost.amountMicros, 5200);
    assert.ok(transcriptions.filter(event => event.status === 'failed').every(event => event.cost.status === 'unknown'));
    const ready = await service.retryTranscription(uid, project.id, 'already-ready-key');
    assert.equal(ready.status, 'completed');
    assert.equal((await db.collection('generationJobs').where('uid', '==', uid).get()).empty, true);
    assert.deepEqual(await intake.usage(uid, clock()), before);
    assert.equal((await account.collection('usageEvents').get()).size, events.length);
  });
});

test('manual retry failures stop after one attempt and retain paid usage without output consumption', emulatorOnly, async () => {
  await withStore(async ({ uid, account, intake, store, service, project, failedTranscript, clock, advance }) => {
    await failedTranscript();
    await service.retryTranscription(uid, project.id, 'one-attempt-retry');
    const worker = createGenerationWorker({ store, now: clock, providers: {
      transcribe: async (_source, _signal, mark) => { await mark({ provider: 'deepgram', model: 'fixture', rates: result(transcript).rates }); const failure = Object.assign(new Error('Synthetic transport failure'), {}); throw failure; },
      generate: async () => assert.fail('No output expected.'),
    } });
    assert.equal(await worker.runOnce(), true);
    advance(100_000);
    assert.equal(await worker.runOnce(), false);
    const batch = (await store.batch(uid, project.id))!;
    assert.equal(batch.status, 'failed');
    assert.equal(batch.transcriptionAttempts, 1);
    assert.equal(batch.transcriptionFailure!.retryable, true);
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
    assert.equal((await intake.usage(uid, clock())).consumed.sourceSeconds, 60);
    assert.equal((await intake.usage(uid, clock())).consumed.x_posts, 0);
    const events = (await account.collection('usageEvents').get()).docs.map(doc => doc.data());
    assert.equal(events.filter(event => event.stage === 'transcribe').length, 4);
    assert.equal(events.filter(event => event.stage === 'transcribe').at(-1)!.cost.status, 'unknown');
  });
});

test('retry requires ownership, active access, a retryable failure and an unexpired source', emulatorOnly, async () => {
  await withStore(async ({ uid, account, store, service, grantRef, project, failedTranscript, clock }) => {
    await assert.rejects(service.retryTranscription(uid, project.id, 'before-first-attempt'), { code: 'transcription_not_failed' });
    await failedTranscript(false);
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.reason, 'transcription_not_retryable');
    assert.equal((await store.availability!(uid, project.id, clock())).outputs.x_posts.reason, 'transcription_not_retryable');
    await assert.rejects(service.retryTranscription(uid, project.id, 'permanent-failure'), { code: 'transcription_not_retryable' });
    await assert.rejects(service.start(uid, project.id, { outputs: { x_posts: 1 } }, 'permanent-create-bypass'), { code: 'transcription_not_retryable' });
    await assert.rejects(service.retryTranscription('different-owner', project.id, 'other-account-key'), { code: 'project_not_found' });
    await account.collection('projects').doc(project.id).collection('generation').doc('batch').update({ transcriptionFailure: { code: 'transcription_unavailable', retryable: true } });
    await grantRef.delete();
    await assert.rejects(service.retryTranscription(uid, project.id, 'no-access-key'), { code: 'subscription_required' });
    await account.collection('projects').doc(project.id).update({ sourceExpiresAt: clock() });
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.reason, 'requires_reimport');
    await assert.rejects(service.retryTranscription(uid, project.id, 'expired-source-key'), { code: 'requires_reimport' });
  });
});

test('an interrupted already-invoked manual retry does not silently call the provider again', emulatorOnly, async () => {
  await withStore(async ({ uid, account, intake, store, service, project, failedTranscript, clock, advance }) => {
    await failedTranscript();
    const before = await intake.usage(uid, clock());
    await service.retryTranscription(uid, project.id, 'interrupted-retry');
    const claim = await store.claim('lost-worker', clock(), 1000);
    assert.ok(claim);
    await store.markProviderInvoked(claim, { provider: 'deepgram', model: 'fixture', rates: result(transcript).rates }, clock());
    advance(1001);
    assert.equal(await store.claim('replacement-worker', clock(), 1000), null);
    assert.equal((await store.batch(uid, project.id))!.errorCode, 'transcription_interrupted');
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
    const interrupted = (await account.collection('usageEvents').get()).docs.map(doc => doc.data()).find(event => event.errorCode === 'transcription_interrupted');
    assert.equal(interrupted!.cost.status, 'unknown');
    assert.equal(await store.saveTranscript(claim, result(transcript), clock()), false);
    assert.deepEqual(await intake.usage(uid, clock()), before);
    const events = (await account.collection('usageEvents').get()).docs.map(doc => doc.data());
    const late = events.find(event => event.batchId === claim.batch.id)!;
    assert.equal(late.status, 'discarded');
    assert.equal(late.cost.amountMicros, 5200);
  });
});

test('retry transcription HTTP supports JSON acceptance, no-work ready response and finite SSE', emulatorOnly, async () => {
  await withStore(async ({ uid, db, grant, store, service, project, failedTranscript, clock }) => {
    await failedTranscript();
    const server = createServer(createHandler({ verifyToken: async token => ({ uid: token }), loadGrant: async () => grant, now: () => new Date(clock()), generation: service, operations: firestoreOperations(db), streamMaxMilliseconds: 1000 }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects/${project.id}/retry-transcription`;
    const headers = { authorization: `Bearer ${uid}`, 'content-type': 'application/json', 'idempotency-key': 'http-retry-key' };
    try {
      assert.equal((await fetch(url, { method: 'POST' })).status, 401);
      assert.equal((await fetch(url, { headers })).status, 405);
      assert.equal((await fetch(url, { method: 'POST', headers, body: '{"outputs":{"x_posts":1}}' })).status, 400);
      assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 202);
      const worker = createGenerationWorker({ store, now: clock, providers: { transcribe: async () => result(transcript), generate: async () => assert.fail('No output expected.') } });
      await worker.runOnce();
      const ready = await fetch(url, { method: 'POST', headers: { ...headers, 'idempotency-key': 'ready-http-retry' }, body: '{}' });
      assert.equal(ready.status, 200);
      const stream = await fetch(url, { method: 'POST', headers: { ...headers, accept: 'text/event-stream', 'idempotency-key': 'ready-sse-retry' }, body: '{}' });
      assert.equal(stream.status, 200);
      assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      const events = await stream.text();
      assert.match(events, /event: accepted/);
      assert.match(events, /event: terminal/);
      assert.match(events, /"outcome":"succeeded"/);
      assert.match(events, /"ready":0,"failed":0/);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});

test('legacy cached transcripts cannot bypass an unconsumed source reservation', emulatorOnly, async () => {
  await withStore(async ({ uid, account, intake, store, grantRef, grant, project, failedTranscript, clock, advance }) => {
    await failedTranscript();
    const saved = (await intake.get(uid, project.id))!;
    const projectRef = account.collection('projects').doc(project.id);
    const usageRef = account.collection('allowances').doc(saved.period);
    await projectRef.update({ sourceAllowanceConsumed: false, reservedSourceSeconds: 0 });
    await usageRef.update({ 'consumed.sourceSeconds': 0, 'reserved.sourceSeconds': 0 });
    await projectRef.collection('transcripts').doc('shared').set({ ...transcript, createdAt: clock(), expiresAt: clock() + 100_000 });
    await grantRef.update({ 'limits.sourceSeconds': 0 });
    assert.equal((await store.availability!(uid, project.id, clock())).outputs.x_posts.reason, 'allowance_exceeded');
    await assert.rejects(store.start(uid, project.id, 'legacy-no-allowance', { x_posts: 1, linkedin_posts: 0 }, clock()), { code: 'allowance_exceeded' });
    assert.equal((await usageRef.get()).data()!.consumed.sourceSeconds, 0, 'Reading or rejecting old records must not charge them.');
    await grantRef.set(grant);
    const batch = await store.start(uid, project.id, 'legacy-cached-recovery', { x_posts: 1, linkedin_posts: 0 }, clock());
    assert.equal(batch.transcriptReady, true);
    assert.equal((await intake.usage(uid, clock())).reserved.sourceSeconds, 60);
    const claim = await store.claim('cached-output-worker', advance(), 1000);
    assert.ok(claim);
    assert.equal(claim.stage, 'generate');
    assert.equal(await store.saveOutput(claim, { ...result('A distinct successful output from the cached transcript.'), provider: 'fixture', usage: unknownUsage() }, advance()), true);
    assert.equal((await intake.usage(uid, clock())).consumed.sourceSeconds, 60);
    assert.equal((await intake.usage(uid, clock())).reserved.sourceSeconds, 0);
  });
});

test('revoked access cancels a queued transcription-only batch without invoking a provider', emulatorOnly, async () => {
  await withStore(async ({ uid, intake, store, service, grantRef, project, failedTranscript, clock }) => {
    await failedTranscript();
    await service.retryTranscription(uid, project.id, 'revoked-manual-retry');
    const before = await intake.usage(uid, clock());
    await grantRef.delete();
    assert.equal(await store.claim('revoked-worker', clock(), 1000), null);
    assert.equal((await store.batch(uid, project.id))!.status, 'failed');
    assert.equal((await store.batch(uid, project.id))!.errorCode, 'subscription_required');
    const saved = (await intake.get(uid, project.id))!;
    assert.equal(saved.sourceAllowanceConsumed, true);
    assert.equal(before.consumed.sourceSeconds, 60);
  });
});

test('ready transcription retry preserves legacy delivery accounting before another generation', emulatorOnly, async () => {
  await withStore(async ({ uid, account, intake, store, service, project, clock, advance }) => {
    await store.start(uid, project.id, 'legacy-delivered-output', { x_posts: 1, linkedin_posts: 0 }, advance());
    const transcription = await store.claim('first-worker', advance(), 1000);
    assert.ok(transcription);
    await store.saveTranscript(transcription, result(transcript), advance());
    const output = await store.claim('first-worker', advance(), 1000);
    assert.ok(output);
    await store.saveOutput(output, { ...result('A valid previously delivered post.'), usage: unknownUsage() }, advance());
    await account.collection('projects').doc(project.id).update({ sourceAllowanceConsumed: FieldValue.delete() });
    const before = await intake.usage(uid, clock());
    const cached = await service.retryTranscription(uid, project.id, 'legacy-ready-retry');
    assert.equal(cached.status, 'completed');
    assert.deepEqual(await intake.usage(uid, clock()), before);
    assert.equal((await intake.get(uid, project.id))!.sourceAllowanceConsumed, true);
    await store.start(uid, project.id, 'post-ready-generation', { x_posts: 1, linkedin_posts: 0 }, advance());
    assert.equal((await intake.usage(uid, clock())).reserved.sourceSeconds, 0);
    assert.equal((await intake.usage(uid, clock())).consumed.sourceSeconds, 60);
    assert.equal((await store.claim('later-worker', advance(), 1000))!.stage, 'generate');
  });
});

test('provider configuration failures do not permanently reject the source and a live transcript remains usable', emulatorOnly, async () => {
  await withStore(async ({ uid, account, store, service, project, failedTranscript, clock, advance }) => {
    await failedTranscript(false);
    const batchRef = account.collection('projects').doc(project.id).collection('generation').doc('batch');
    await batchRef.update({ transcriptionFailure: { code: 'transcription_failed', retryable: false }, errorCode: 'transcription_failed' });
    assert.equal((await store.availability!(uid, project.id, clock())).outputs.x_posts.available, true);
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
    await service.retryTranscription(uid, project.id, 'legacy-provider-repair');
    const retried = await store.claim('legacy-provider-worker', advance(), 1000);
    assert.ok(retried);
    assert.equal(retried.batch.slots.length, 0);
    await store.fail(retried, { code: 'transcription_failed', retryable: false, provider: 'deepgram', model: 'fixture', usage: unknownUsage(), rates: null }, advance());
    assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
    await store.start(uid, project.id, 'after-provider-repair', { x_posts: 1, linkedin_posts: 0 }, advance());
    const claim = await store.claim('repaired-provider-worker', advance(), 1000);
    assert.ok(claim);
    assert.equal(claim.stage, 'transcribe');
    await store.fail(claim, { code: 'audio_too_large', retryable: false, provider: 'fixture', model: 'fixture', usage: unknownUsage(), rates: null }, advance());
    await account.collection('projects').doc(project.id).collection('transcripts').doc('shared').set({ ...transcript, createdAt: clock(), expiresAt: clock() + 100_000 });
    assert.equal((await store.availability!(uid, project.id, clock())).outputs.x_posts.available, true);
    const cached = await store.start(uid, project.id, 'valid-cached-transcript', { x_posts: 1, linkedin_posts: 0 }, advance());
    assert.equal(cached.transcriptReady, true);
    assert.equal((await store.claim('cached-worker', advance(), 1000))!.stage, 'generate');
  });
});

test('a processing-rule change permits explicit recovery of a previously rejected source', emulatorOnly, async () => {
  await withStore(async ({ uid, account, store, service, project, failedTranscript, clock }) => {
    await failedTranscript(false);
    await account.collection('projects').doc(project.id).collection('generation').doc('batch').update({ transcriptionFailure: { code: 'audio_too_large', retryable: false, sourceRejectedVersion: transcriptionSourceRulesVersion - 1 } });
    const state = (await store.availability!(uid, project.id, clock())).transcription!;
    assert.equal(state.retryAvailable, true);
    assert.equal((await service.retryTranscription(uid, project.id, 'updated-processing-rules')).status, 'queued');
  });
});


test('persisted Deepgram authentication and legacy provider failures recover through fresh JSON and SSE retries', emulatorOnly, async () => {
  for (const [status, streaming, legacy] of [[401, false, false], [403, true, false], [401, false, true]] as const) {
    await withStore(async ({ uid, account, db, grant, store, service, project, intake, clock, advance }) => {
      const directory = await mkdtemp(join(tmpdir(), 'riflo-auth-recovery-'));
      const path = join(directory, 'audio.wav');
      await writeFile(path, 'mock audio bytes');
      const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'test-text-key', DEEPGRAM_API_KEY: 'broken-test-key', FFMPEG_PATH: '/test/ffmpeg' })!;
      let calls = 0;
      const providers = createGenerationProviders({ config, now: clock, audio: async () => ({ path, cleanup: async () => undefined }), request: async (_url, options) => {
        calls++;
        await new Response(options!.body).arrayBuffer();
        assert.equal((options!.headers as Record<string, string>).Authorization, calls === 1 ? 'Token broken-test-key' : 'Token repaired-test-key');
        if (calls === 1) return new Response('provider private credential diagnostic', { status });
        return Response.json({ metadata: { duration: 60 }, results: { channels: [{ alternatives: [{ transcript: transcript.text, words: transcript.words.map(word => ({ word: word.text, start: word.start, end: word.end })) }] }] } });
      } });
      const worker = createGenerationWorker({ store, now: clock, providers });
      const server = createServer(createHandler({ verifyToken: async token => ({ uid: token }), loadGrant: async () => grant, now: () => new Date(clock()), generation: service, operations: firestoreOperations(db), streamMaxMilliseconds: 2000 }));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const original = await service.start(uid, project.id, { outputs: { x_posts: 1 } }, 'original-auth-failure');
        assert.equal(await worker.runOnce(), true);
        advance(10_000);
        assert.equal(await worker.runOnce(), false, 'Authentication must not trigger automatic paid retries.');
        const failed = (await store.batch(uid, project.id))!;
        assert.equal(failed.transcriptionAttempts, 1);
        assert.deepEqual(failed.transcriptionFailure, { code: 'transcription_configuration_failed', retryable: false });
        assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
        if (legacy) {
          await account.collection('projects').doc(project.id).collection('generation').doc('batch').update({ transcriptionFailure: { code: 'transcription_failed', retryable: false }, errorCode: 'transcription_failed' });
          assert.equal((await store.availability!(uid, project.id, clock())).transcription!.retryAvailable, true);
        }
        const before = await intake.usage(uid, clock());
        config.deepgramKey = 'repaired-test-key';
        const replay = await service.start(uid, project.id, { outputs: { x_posts: 1 } }, 'original-auth-failure');
        assert.equal(replay.id, original.id);
        assert.equal(replay.status, 'failed');
        assert.equal(calls, 1);
        const headers = { authorization: `Bearer ${uid}`, 'content-type': 'application/json', 'idempotency-key': 'fresh-auth-recovery', ...(streaming ? { accept: 'text/event-stream' } : {}) };
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects/${project.id}/retry-transcription`, { method: 'POST', headers, body: '{}' });
        assert.equal(response.status, streaming ? 200 : 202);
        const accepted = (await store.batch(uid, project.id))!;
        assert.equal(accepted.intent, 'transcription_retry');
        assert.deepEqual(accepted.slots, []);
        assert.deepEqual(accepted.selection, { x_posts: 0, linkedin_posts: 0 });
        assert.deepEqual(await intake.usage(uid, clock()), before);
        assert.equal(await worker.runOnce(), true);
        assert.equal(await worker.runOnce(), false);
        if (streaming) {
          const events = await response.text();
          assert.match(events, /event: accepted/);
          assert.match(events, /event: terminal/);
          assert.match(events, /"outcome":"succeeded"/);
        } else assert.equal((await response.json()).data.intent, 'transcription_retry');
        assert.equal(calls, 2, 'The explicit retry permits exactly one provider call.');
        assert.deepEqual(await store.transcript(uid, project.id, clock()), transcript);
        assert.deepEqual(await store.outputs(uid, project.id, clock()), []);
        assert.deepEqual(await intake.usage(uid, clock()), before);
        assert.equal((await service.retryTranscription(uid, project.id, 'fresh-auth-recovery')).id, accepted.id);
        assert.equal((await service.start(uid, project.id, { outputs: { x_posts: 1 } }, 'original-auth-failure')).status, 'failed');
        assert.equal(calls, 2);
        const events = (await account.collection('usageEvents').get()).docs.map(doc => doc.data());
        assert.equal(events.filter(event => event.stage === 'transcribe').length, 2);
        assert.equal(events.filter(event => event.stage === 'transcribe' && event.status === 'failed').length, 1);
        assert.equal(events.filter(event => event.stage === 'transcribe' && event.status === 'succeeded').length, 1);
        assert.ok(events.every(event => !JSON.stringify(event).includes('private credential')));
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('explicit transcription retry survives pre-dispatch shutdown but remains terminal after provider dispatch', emulatorOnly, async () => {
  await withStore(async ({ uid, store, service, project, failedTranscript, advance }) => {
    await failedTranscript();
    await service.retryTranscription(uid, project.id, 'shutdown-retry');
    const failure = { code: 'worker_shutdown', retryable: true, usage: unknownUsage(), provider: 'deepgram', model: 'fixture', rates: null };
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      const claim = (await store.claim('worker', advance(), 1000))!;
      assert.ok(claim);
      assert.equal(claim.attempt, ordinal);
      assert.equal(await store.fail(claim, failure, advance()), true);
      assert.equal((await store.batch(uid, project.id))!.transcriptionFailure ?? null, null);
    }
    const dispatched = (await store.claim('worker', advance(), 1000))!;
    assert.equal(await store.markProviderInvoked(dispatched, { provider: 'deepgram', model: 'fixture', rates: null }, advance()), true);
    assert.equal(await store.fail(dispatched, failure, advance()), true);
    assert.equal((await store.batch(uid, project.id))!.status, 'failed');
    assert.equal(await store.claim('worker', advance(10000), 1000), null);
  });
});

test('legacy missing dispatch evidence cannot waive an explicit retry on shutdown', emulatorOnly, async () => {
  await withStore(async ({ uid, account, store, service, project, failedTranscript, advance }) => {
    await failedTranscript();
    await service.retryTranscription(uid, project.id, 'legacy-shutdown-retry');
    const claim = (await store.claim('worker', advance(), 1000))!;
    const events = await account.collection('usageEvents').where('batchId', '==', claim.batch.id).get();
    assert.equal(events.size, 1);
    const { providerInvoked: _proof, ...legacyEvent } = events.docs[0]!.data();
    await events.docs[0]!.ref.set(legacyEvent);
    assert.equal(await store.fail(claim, { code: 'worker_shutdown', retryable: true, usage: unknownUsage(), provider: 'deepgram', model: 'fixture', rates: null }, advance()), true);
    assert.equal((await store.batch(uid, project.id))!.status, 'failed');
  });
});

for (const lateFailure of [false, true]) test(`explicit retry survives repeated proven pre-dispatch lease crashes (late failure: ${lateFailure})`, emulatorOnly, async () => {
  await withStore(async ({ uid, store, service, project, failedTranscript, advance }) => {
    await failedTranscript();
    await service.retryTranscription(uid, project.id, 'crash-retry');
    let claim: Awaited<ReturnType<typeof store.claim>> = null;
    const failure = { code: 'worker_shutdown', retryable: true, usage: unknownUsage(), provider: 'deepgram', model: 'fixture', rates: null };
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      const previous: Awaited<ReturnType<typeof store.claim>> = claim;
      const timestamp = advance(1001);
      if (lateFailure && previous) assert.equal(await store.fail(previous, failure, timestamp), false);
      claim = (await store.claim('crashed-worker', timestamp, 1000))!;
      assert.ok(claim);
      assert.equal(claim.attempt, ordinal);
      if (lateFailure && previous) {
        const beforeStale = await store.batch(uid, project.id);
        assert.equal(await store.fail(previous, failure, timestamp), false);
        assert.deepEqual(await store.batch(uid, project.id), beforeStale);
        assert.equal(await store.renew(claim, timestamp, 1000), true);
      }
    }
    assert.equal(await store.saveTranscript(claim!, result(transcript), advance()), true);
    assert.equal((await store.batch(uid, project.id))!.status, 'completed');
  });
});
