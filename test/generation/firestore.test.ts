import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { sourcePath } from '../../src/projects/source.js';
import { createIntakeWorker } from '../../src/projects/worker.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { GenerationError, unknownUsage, type AttemptResult, type Transcript } from '../../src/generation/service.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { createCarouselRenderer } from '../../src/generation/carousel.js';
import { assetPath, videoPath } from '../../src/generation/asset-paths.js';
import { runWorkerLoop } from '../../src/worker-loop.js';
import { runWorkerPass } from '../../src/worker-pass.js';
import { runWorkerStep } from '../../src/worker-step.js';
import { validateShortPost } from '../../src/generation/validation.js';
import { createGenerationService } from '../../src/generation/service.js';
import { createGenerationDefaultsService, createGenerationDefaultsStore, parseGenerationControls, readGenerationDefaults, resolveGenerationControls } from '../../src/generation/controls.js';

const emulatorOnly = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-18T12:00:00Z');
const transcript: Transcript = { text: 'A practical idea from the video.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'practical', start: 1, end: 2 }, { text: 'idea', start: 2, end: 3 }] };
const result = <T>(value: T, provider = 'anthropic'): AttemptResult<T> => ({ value, usage: unknownUsage(), provider, model: 'test-model', rates: null, promptVersion: provider === 'anthropic' ? 'test-version' : null });

test('enabled service resolves durable defaults, preserves legacy replay and exposes failed-read fallback', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const settings = createGenerationDefaultsService(createGenerationDefaultsStore(db));
    let reads = 0;
    let failRead = false;
    const service = createGenerationService({ store, now: () => now + 2, readDefaults: async owner => { reads++; if (failRead) throw Error('private settings failure'); return settings.get(owner); } });
    const legacy = await store.start(uid, id, 'legacy-control-replay', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    await settings.replace(uid, { x_posts: { mode: 'thread', maxPosts: 3, numbering: 'include' } });
    const replay = await service.start(uid, id, { outputs: { x_posts: 1 } }, 'legacy-control-replay');
    assert.equal(replay.id, legacy.id);
    assert.equal(replay.controls, undefined);
    assert.equal(reads, 0);
    const claim = (await store.claim('activation-worker', now + 3, 1000))!;
    await store.fail(claim, { code: 'fixture_failure', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, now + 4);
    const availability = await service.availability(uid, id);
    assert.equal(availability.controls.available, true);
    assert.equal(availability.controls.threadAvailable, false);
    assert.equal(availability.controls.builtins.short_videos!.captions, 'off');
    await assert.rejects(service.start(uid, id, { outputs: { x_posts: 1 } }, 'saved-legacy-thread'), { code: 'generation_threads_unavailable' });
    await settings.replace(uid, { x_posts: { length: 'short' } });
    const accepted = await service.start(uid, id, { outputs: { x_posts: 1 }, brand: { mode: 'none' } }, 'enabled-saved-defaults');
    assert.equal(accepted.controls!.formats.x_posts!.length, 'short');
    assert.equal(accepted.controls!.origins.x_posts!.length, 'saved');
    const beforeReplay = reads;
    failRead = true;
    assert.deepEqual(await service.start(uid, id, { outputs: { x_posts: 1 }, brand: { mode: 'none' } }, 'enabled-saved-defaults'), accepted);
    assert.equal(reads, beforeReplay);
    const next = (await store.claim('activation-worker', now + 5, 1000))!;
    await store.fail(next, { code: 'fixture_failure', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, now + 6);
    const fallback = await service.start(uid, id, { outputs: { short_videos: 1 } }, 'enabled-fallback-video');
    assert.equal(fallback.controls!.status, 'unavailable');
    assert.equal(fallback.controls!.formats.short_videos!.captions, 'off');
    assert.equal(fallback.controls!.origins.short_videos!.captions, 'builtin');
  });
});

test('delivery revalidates continuous mode and accepts a complete shorter clip under its soft target', emulatorOnly, async () => {
  await withStore(async ({ uid, store, readySource }) => {
    const id = await readySource();
    const selection = { x_posts: 0, linkedin_posts: 0, short_videos: 1 };
    const request = { formats: { short_videos: { editing: 'continuous' as const, duration: 30 as const } } };
    await store.start(uid, id, 'continuous-video-key', selection, now + 2, undefined, undefined, { request, snapshot: resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} }) });
    const transcribe = (await store.claim('video-worker', now + 3, 1000))!;
    await store.saveTranscript(transcribe, result({ text: 'A complete spoken idea.', words: [{ text: 'Start', start: 0, end: 1 }, { text: 'end', start: 9, end: 10 }, { text: 'next', start: 15, end: 16 }, { text: 'end', start: 24, end: 25 }] }), now + 4);
    const claim = (await store.claim('video-worker', now + 5, 1000))!;
    await assert.rejects(store.saveOutput(claim, result({ status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 10 }, { startSeconds: 15, endSeconds: 25 }] }), now + 6), (error: any) => error.code === 'invalid_generated_output' && error.validation.limit === 1);
    const output = { ...result({ status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 10 }] }), assets: [{ id: 'clip', storagePath: videoPath(uid, id, claim.slot!.id, claim.attempt), contentType: 'video/mp4' as const, bytes: 10, width: 720, height: 1280, durationSeconds: 10 }] };
    assert.equal(await store.saveOutput(claim, output, now + 7), true);
    assert.equal((await store.outputs(uid, id, now + 8)).length, 1);
  });
});

test('legacy per-format grants reject thread acceptance without reserving or migrating allowances', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const request = { formats: { x_posts: { mode: 'thread' as const, maxPosts: 10, numbering: 'include' as const } } };
    const context = { request, snapshot: resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} }) };
    const account = db.collection('accounts').doc(uid);
    const before = (await account.collection('allowances').get()).docs.map(doc => doc.data());
    await assert.rejects(store.start(uid, id, 'legacy_thread_reject', selection, now + 2, undefined, undefined, context), { code: 'generation_threads_unavailable' });
    assert.deepEqual((await account.collection('allowances').get()).docs.map(doc => doc.data()), before);
    assert.equal((await account.collection('projects').doc(id).collection('generationRequests').get()).size, 0);
    assert.ok(await store.start(uid, id, 'legacy_single_allowed', selection, now + 3));
  });
});

test('controls acceptance rejects out-of-source windows without reservation and preserves snapshots on archived replay', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const account = db.collection('accounts').doc(uid);
    const settings = createGenerationDefaultsService(createGenerationDefaultsStore(db));
    const grantBefore = (await db.collection('subscriptionGrants').doc(uid).get()).data();
    await settings.replace(uid, { x_posts: { length: 'short' } });
    assert.deepEqual((await db.collection('subscriptionGrants').doc(uid).get()).data(), grantBefore);
    assert.equal(await settings.get(`${uid}-other`), null);
    const request = parseGenerationControls({ focus: 'Private topic', sourceWindow: { startSeconds: 0, endSeconds: 1 } }, selection);
    const snapshot = resolveGenerationControls(request, selection, await readGenerationDefaults(uid, settings.get));
    const context = { request, snapshot };
    const ledgerBefore = (await account.collection('allowances').get()).docs.map(doc => doc.data());
    const invalid = { ...request, sourceWindow: { startSeconds: 0, endSeconds: 1_000_000 } };
    await assert.rejects(store.start(uid, id, 'bad-controls-window', selection, now + 2, undefined, undefined, { request: invalid, snapshot: { ...snapshot, sourceWindow: invalid.sourceWindow } }), { code: 'invalid_generation_controls' });
    assert.deepEqual((await account.collection('allowances').get()).docs.map(doc => doc.data()), ledgerBefore);
    assert.equal((await account.collection('projects').doc(id).collection('generationRequests').get()).size, 0);
    const first = await store.start(uid, id, 'controls-snapshot-key', selection, now + 2, undefined, undefined, context);
    await settings.replace(uid, { x_posts: { length: 'standard' } });
    assert.deepEqual((await store.lookup!(uid, id, 'controls-snapshot-key', selection, undefined, undefined, request))!.controls, snapshot);
    const changed = resolveGenerationControls(request, selection, await readGenerationDefaults(uid, settings.get));
    assert.equal(changed.formats.x_posts!.length, 'standard');
    assert.deepEqual((await store.start(uid, id, 'controls-snapshot-key', selection, now + 3, undefined, undefined, { request, snapshot: changed })).controls, snapshot);
    await assert.rejects(store.lookup!(uid, id, 'controls-snapshot-key', selection, undefined, undefined, { ...request, focus: 'Other' }), { code: 'idempotency_conflict' });
    const claim = (await store.claim('controls-worker', now + 4, 1000))!;
    await store.fail(claim, { code: 'fixture_failure', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, now + 5);
    await store.start(uid, id, 'controls-second-key', selection, now + 6, undefined, undefined, { request, snapshot: changed });
    const replay = await store.lookup!(uid, id, 'controls-snapshot-key', selection, undefined, undefined, request);
    assert.equal(replay!.id, first.id);
    assert.deepEqual(replay!.controls, snapshot);
    const generations = account.collection('projects').doc(id).collection('generation');
    for (const doc of (await generations.get()).docs) await doc.ref.update({ snapshotRetention: (await import('firebase-admin/firestore')).FieldValue.delete(), snapshotExpiresAt: now, snapshotCleanupAt: now });
    await store.cleanup(now + 7);
    for (const doc of (await generations.get()).docs) {
      assert.equal(doc.data().controls, undefined);
      assert.equal(doc.data().snapshotCleanupAt, null);
    }
  });
});

test('new batches and slots have independent v7 identities and replay keeps the committed IDs', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const selection = { x_posts: 1, linkedin_posts: 1 };
    const first = await store.start(uid, id, 'v7-first-key', selection, now + 2);
    const uuid7 = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    assert.match(first.id!, uuid7);
    assert.ok(first.slots.every(slot => uuid7.test(slot.id)));
    assert.equal(new Set([first.id, ...first.slots.map(slot => slot.id)]).size, 3);
    assert.deepEqual(first.slots.map(slot => [slot.feature, slot.ordinal]), [['x_posts', 1], ['linkedin_posts', 1]]);
    const replay = await store.start(uid, id, 'v7-first-key', selection, now + 2);
    assert.equal(replay.id, first.id);
    assert.deepEqual(replay.slots, first.slots);
    assert.equal(replay.createdAt, first.createdAt);
    const asr = (await store.claim('first-worker', now + 3, 1000))!;
    assert.match(asr.claimId, uuid7);
    await store.saveTranscript(asr, result(transcript, 'fixture'), now + 4);
    const claim = (await store.claim('first-worker', now + 5, 1000))!;
    assert.match(claim.claimId, uuid7);
    assert.notEqual(claim.claimId, asr.claimId);
    assert.equal(claim.slot!.id, first.slots[0]!.id);
    await store.saveOutput(claim, result('First distinct post.'), now + 6);
    const secondClaim = (await store.claim('first-worker', now + 7, 1000))!;
    await store.saveOutput(secondClaim, result('Second distinct post.'), now + 8);
    assert.deepEqual((await store.outputs(uid, id, now + 9)).map(output => output.id), first.slots.map(slot => slot.id));
    const next = await store.start(uid, id, 'v7-next-key', { x_posts: 1, linkedin_posts: 0 }, now + 10);
    assert.match(next.id!, uuid7);
    assert.match(next.slots[0]!.id, uuid7);
    assert.equal(new Set([first.id, ...first.slots.map(slot => slot.id), next.id, next.slots[0]!.id]).size, 5);
    assert.equal((await store.start(uid, id, 'v7-first-key', selection, now + 11)).id, first.id);
    assert.equal((await db.collection('generationJobs').where('uid', '==', uid).get()).docs[0]!.data().batchId, next.id);
  });
});

test('retained outputs use delivery time then binary opaque ID order across legacy and v7 IDs', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id).collection('outputs');
    const fixture = [
      { id: 'ffffffff-ffff-7fff-8fff-ffffffffffff', createdAt: now + 2 },
      { id: 'x_posts-1', createdAt: now + 1 },
      { id: '00000000-0000-4000-8000-000000000000', createdAt: now + 2 },
      { id: 'Z-legacy', createdAt: now + 2 },
      { id: 'a-legacy', createdAt: now + 2 },
    ];
    await Promise.all(fixture.map(output => ref.doc(output.id).set({ ...output, feature: 'x_posts', text: output.id, model: 'private', promptVersion: 'private', expiresAt: now + 100 })));
    await ref.doc('expired').set({ id: 'expired', feature: 'x_posts', text: 'expired', createdAt: now, expiresAt: now + 3 });
    const outputs = await store.outputs(uid, id, now + 3);
    assert.deepEqual(outputs.map(output => output.id), ['x_posts-1', '00000000-0000-4000-8000-000000000000', 'Z-legacy', 'a-legacy', 'ffffffff-ffff-7fff-8fff-ffffffffffff']);
    assert.equal((await store.output(uid, id, 'x_posts-1', now + 3))!.id, 'x_posts-1');
    assert.equal(await store.output(uid, id, 'expired', now + 3), null);
  });
});

test('saved brand is frozen on acceptance and idempotent replays compare explicit preferences', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    let reads = 0;
    let voice = 'Warm';
    const service = createGenerationService({ store, now: () => now + 2, readBrand: async account => { assert.equal(account, uid); reads++; return { voice }; } });
    const request = { outputs: { x_posts: 1 }, brand: { mode: 'saved', overrides: { audience: 'Teachers' } } };
    const accepted = await service.start(uid, id, request, 'brand-snapshot-key');
    assert.deepEqual(accepted.brand, { status: 'applied' });
    voice = 'Changed';
    assert.deepEqual(await service.start(uid, id, request, 'brand-snapshot-key'), accepted);
    assert.equal(reads, 1);
    const saved = await store.batch(uid, id);
    assert.deepEqual(saved!.brand, { status: 'applied', profile: { audience: 'Teachers', voice: 'Warm' } });
    await assert.rejects(service.start(uid, id, { ...request, brand: { mode: 'none' } }, 'brand-snapshot-key'), { code: 'idempotency_conflict' });
    const document = (await db.collection('accounts').doc(uid).collection('projects').doc(id).collection('generation').doc('batch').get()).data()!;
    assert.equal(document.brand.profile.voice, 'Warm');
  });
});

test('minimal batch responses preserve stored worker history, reservations and archived request replay', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    let clock = now + 2;
    const service = createGenerationService({ store, now: () => clock });
    const request = { outputs: { x_posts: 2 } };
    const accepted = await service.start(uid, id, request, 'minimal-response-key');
    assert.deepEqual(Object.keys(accepted).sort(), ['brand', 'controls', 'errorCode', 'id', 'slots', 'status', 'transcriptReady']);
    assert.deepEqual(accepted.controls, { version: 1, status: 'resolved', formats: { x_posts: { length: 'auto', mode: 'single' } }, origins: { x_posts: { length: 'builtin', mode: 'builtin' } } });
    assert.deepEqual(Object.keys(accepted.slots[0]!).sort(), ['errorCode', 'feature', 'id', 'status']);

    const initial = (await store.claim('worker', ++clock, 1000))!;
    await store.fail(initial, { code: 'transcription_unavailable', retryable: true, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, ++clock);
    clock += 3000;
    await store.saveTranscript((await store.claim('worker', clock++, 1000))!, result(transcript, 'fixture'), clock++);
    await store.saveOutput((await store.claim('worker', clock++, 1000))!, result('A practical idea from the video.'), clock++);
    const failed = (await store.claim('worker', clock++, 1000))!;
    await store.fail(failed, { code: 'invalid_generated_output', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, clock++);

    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id).collection('generation').doc('batch');
    const internal = (await ref.get()).data()!;
    assert.deepEqual(internal.selection, { x_posts: 2, linkedin_posts: 0 });
    assert.deepEqual(internal.slots.map((slot: { ordinal: number; attempts: number }) => [slot.ordinal, slot.attempts]), [[1, 1], [2, 1]]);
    assert.equal(internal.transcriptionAttempts, 2);
    assert.equal(internal.errorCode, 'transcription_unavailable');
    assert.equal(internal.createdAt, now + 2);
    assert.ok(internal.updatedAt > internal.createdAt);
    await ref.update({ slots: internal.slots.map((slot: object) => ({ ...slot, privateWorker: 'stored-only' })) });
    const stored = (await ref.get()).data();
    const progress = await service.get(uid, id);
    assert.equal(progress.status, 'partial');
    assert.equal(progress.errorCode, null);
    assert.equal(progress.slots[1]!.errorCode, 'invalid_generated_output');
    assert.doesNotMatch(JSON.stringify(progress), /stored-only|selection|ordinal|attempts|createdAt|updatedAt/);
    assert.deepEqual((await ref.get()).data(), stored);
    const outputRef = db.collection('accounts').doc(uid).collection('projects').doc(id).collection('outputs').doc(accepted.slots[0]!.id);
    const savedOutput = (await outputRef.get()).data()!;
    assert.equal(savedOutput.model, 'test-model');
    assert.equal(savedOutput.promptVersion, 'test-version');
    const events = db.collection('accounts').doc(uid).collection('usageEvents');
    const savedEvents = (await events.get()).docs.map(doc => doc.data());
    assert.ok(savedEvents.some(event => event.model === 'test-model' && event.promptVersion === 'test-version'));
    const listed = await service.outputs(uid, id);
    const single = await service.output(uid, id, savedOutput.id);
    assert.deepEqual(listed, [single]);
    assert.deepEqual(Object.keys(single).sort(), ['createdAt', 'expiresAt', 'feature', 'id', 'text']);
    assert.deepEqual((await outputRef.get()).data(), savedOutput);
    assert.deepEqual((await events.get()).docs.map(doc => doc.data()), savedEvents);
    const usage = await intake.usage(uid, clock) as { consumed: Record<string, number>; reserved: Record<string, number> };
    assert.equal(usage.consumed.x_posts, 1);
    assert.equal(usage.reserved.x_posts, 0);

    await service.start(uid, id, { outputs: { x_posts: 1 } }, 'next-response-key');
    const afterNext = await intake.usage(uid, clock);
    assert.deepEqual(await service.start(uid, id, request, 'minimal-response-key'), progress);
    assert.deepEqual(await intake.usage(uid, clock), afterNext);
  });
});

test('the continuous worker claims a later batch after a validation failure and a real idle delay', { ...emulatorOnly, timeout: 15_000 }, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const startedAt = Date.now();
    const clock = () => now + 2 + Date.now() - startedAt;
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const first = await store.start(uid, id, 'first-lifecycle-request', selection, clock());
    const shutdown = new AbortController();
    const watchdog = setTimeout(() => shutdown.abort(), 10_000);
    let generated = 0, idle = false, acceptedAt = 0, claimedAt = 0, cleanupPasses = 0;
    let accepted: Promise<unknown> | undefined;
    const worker = createGenerationWorker({
      store, now: clock,
      providers: {
        transcribe: async (_project, _signal, onRequest) => {
          await onRequest({ provider: 'fixture', model: 'fixture', rates: null });
          return result(transcript, 'fixture');
        },
        generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
          await onRequest({ provider: 'fixture', model: 'fixture', rates: null });
          if (++generated === 1) throw new GenerationError(502, 'invalid_generated_output', 'Synthetic invalid post.');
          claimedAt = Date.now();
          return result('A valid post from the later generation request.', 'fixture');
        },
      },
    });
    const intake = {
      sources: { drive: { configured: false }, youtube: { configured: false } },
      runOnce: async () => assert.fail('No intake should run.'),
    };
    try {
      await runWorkerLoop(async () => {
        await runWorkerStep('temporary-file cleanup', async () => { cleanupPasses++; });
        await runWorkerStep('source cleanup', async () => {});
        await runWorkerStep('output cleanup', async () => {});
        const worked = await runWorkerPass(intake, worker, shutdown.signal);
        const batch = (await store.batch(uid, id))!;
        if (!worked && !idle) {
          idle = true;
          assert.equal(batch.id, first.id);
          assert.equal(batch.status, 'failed');
          assert.equal(batch.slots[0]!.errorCode, 'invalid_generated_output');
          // Admit new work after runWorkerLoop has entered its actual one-second idle wait.
          accepted = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              acceptedAt = Date.now();
              store.start(uid, id, 'later-lifecycle-request', selection, clock()).then(() => resolve(), reject);
            }, 50);
          });
        }
        if (batch.status === 'completed') shutdown.abort();
        return worked;
      }, shutdown.signal);
      await accepted;
      const batch = (await store.batch(uid, id))!;
      assert.equal(idle, true);
      assert.equal(generated, 2);
      assert.ok(claimedAt - acceptedAt >= 800, 'The later batch must be claimed after the real idle delay.');
      assert.ok(cleanupPasses >= 4);
      assert.notEqual(batch.id, first.id);
      assert.equal(batch.status, 'completed');
      assert.equal((await store.outputs(uid, id, clock())).length, 1);
      assert.equal((await db.collection('generationJobs').where('uid', '==', uid).get()).empty, true);
      assert.deepEqual((await db.collection('accounts').doc(uid).collection('processing').doc('current').get()).data(), { active: null, queued: 0 });
    } finally { clearTimeout(watchdog); shutdown.abort(); }
  });
});

async function withStore(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try { await run(context); }
  finally {
    for (const collection of ['generationJobs', 'intakeJobs']) {
      const jobs = await context.db.collection(collection).where('uid', '==', context.uid).get();
      await Promise.all(jobs.docs.map((job) => job.ref.delete()));
    }
    const cleanup = await context.db.collection('assetCleanup').where('owner.uid', '==', context.uid).get();
    await Promise.all(cleanup.docs.map(doc => doc.ref.delete()));
    await context.db.recursiveDelete(context.db.collection('accounts').doc(context.uid));
    await context.db.collection('subscriptionGrants').doc(context.uid).delete();
    await context.db.terminate();
    await deleteApp(context.app);
  }
}

test('failed generation stores safe validation details beside measured provider usage', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'validation-diagnostics-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    let clock = now + 3;
    const worker = createGenerationWorker({ store, now: () => clock, providers: {
      transcribe: async () => result(transcript, 'fixture'),
      generate: async (_source, _slot, _selection, _signal, onRequest) => {
        await onRequest({ provider: 'anthropic', model: 'configured-model', rates: null, promptVersion: 'test-prompt-v3' });
        try { validateShortPost({ status: 'ok', text: '界'.repeat(141) }, 'x_posts'); }
        catch (error) {
          assert.ok(error instanceof GenerationError);
          error.usage = { ...unknownUsage(), inputTokens: 100, outputTokens: 20 };
          error.model = 'resolved-model';
          Object.assign(error.validation!, { rawText: 'private-output', source: 'private-transcript' });
          throw error;
        }
        throw Error('The oversized post should not pass.');
      },
    } });
    assert.equal(await worker.runOnce(), true);
    clock++;
    assert.equal(await worker.runOnce(), true);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map(doc => doc.data());
    const failed = events.find(event => event.stage === 'generate')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'invalid_generated_output');
    assert.deepEqual(failed.validation, { reason: 'character_limit', field: 'text', actual: 282, limit: 280 });
    assert.equal(failed.model, 'resolved-model');
    assert.equal(failed.promptVersion, 'test-prompt-v3');
    assert.equal(failed.units.outputTokens, 20);
    assert.doesNotMatch(JSON.stringify(failed), /private-output|private-transcript|界/);
    assert.equal(events.find(event => event.stage === 'transcribe')!.validation, undefined);
    assert.equal((await store.batch(uid, id))!.status, 'failed');
    assert.deepEqual(await store.outputs(uid, id, clock), []);
  });
});

async function setup() {
  const uid = `generation-test-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const intake = createProjectStore(db);
  const store = createGenerationStore(db);
  const grant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, key === 'sourceSeconds' ? 3600 : key === 'x_posts' ? 2 : 1])) };
  await db.collection('subscriptionGrants').doc(uid).set(grant);
  const readySource = async () => {
    const id = randomUUID();
    await intake.create({ uid, id, key: randomUUID(), input: { fileId: 'video-id' }, source: { fileId: 'video-id', name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true }, now });
    const claim = await intake.claim(`intake-${id}`, now, 1000) ?? await intake.claim(`intake-${id}`, now, 1000);
    assert.ok(claim);
    await intake.complete(claim, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, id, claim.attempt) }, now + 1);
    // Legacy source-only fixture: this suite exercises the on-demand transcription lifecycle.
    await db.collection('accounts').doc(uid).collection('projects').doc(id).update({ preparation: FieldValue.delete() });
    return id;
  };
  return { uid, app, db, intake, store, grant, readySource };
}

test('concurrent generation requests reserve output slots once and enforce feature limits', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const id = await readySource();
    const batches = await Promise.all(Array.from({ length: 4 }, () => store.start(uid, id, 'same-generation-key', { x_posts: 2, linkedin_posts: 1 }, now + 2)));
    assert.deepEqual(batches[0]!.slots.map((slot) => slot.id), batches[1]!.slots.map((slot) => slot.id));
    const usage = await intake.usage(uid, now + 2) as any;
    assert.equal(usage.reserved.x_posts, 2);
    assert.equal(usage.reserved.linkedin_posts, 1);
    assert.equal(usage.consumed.sourceSeconds, 60);
    assert.equal(usage.reserved.sourceSeconds, 0);
    await assert.rejects(store.start(uid, id, 'different-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2));
    const other = await readySource();
    await assert.rejects(store.start(uid, other, 'another-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2), { code: 'allowance_exceeded' });
  });
});

test('successful outputs preserve the import charge and partial results after another slot fails', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, db, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'partial-generation-key', { x_posts: 2, linkedin_posts: 1 }, now + 2);
    const transcription = await store.claim('worker-a', now + 3, 1000);
    assert.equal(transcription!.stage, 'transcribe');
    assert.equal(await store.saveTranscript(transcription!, result(transcript, 'deepgram'), now + 4), true);
    for (let slot = 0; slot < 2; slot++) {
      const claim = await store.claim('worker-a', now + 5 + slot * 2, 1000);
      assert.equal(claim!.stage, 'generate');
      assert.equal(await store.saveOutput(claim!, result(`Useful post ${slot + 1}.`), now + 6 + slot * 2), true);
      assert.equal(await store.saveOutput(claim!, result('Duplicate output.'), now + 6 + slot * 2), false);
      assert.equal((await intake.usage(uid, now + 8) as any).consumed.sourceSeconds, 60);
    }
    const failed = await store.claim('worker-a', now + 10, 1000);
    assert.ok(failed);
    assert.equal(await store.fail(failed, { code: 'invalid_generated_output', retryable: false, usage: unknownUsage(), provider: 'anthropic', model: 'test-model', rates: null }, now + 11), true);
    assert.equal((await store.batch(uid, id))!.status, 'partial');
    const outputs = await store.outputs(uid, id, now + 12);
    assert.equal(outputs.length, 2);
    assert.equal(await store.output('another-account', id, outputs[0]!.id, now + 12), null);
    const usage = await intake.usage(uid, now + 12) as any;
    assert.equal(usage.consumed.sourceSeconds, 60);
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.reserved.x_posts + usage.reserved.linkedin_posts, 0);
    assert.equal(usage.consumed.x_posts + usage.consumed.linkedin_posts, 2);
    const events = await db.collection('accounts').doc(uid).collection('usageEvents').get();
    assert.ok(events.docs.every((event) => event.data().cost.status === 'unknown'));
  });
});

test('failed transcription releases output reservations without refunding the successful import', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'failed-generation-key', { x_posts: 1, linkedin_posts: 1 }, now + 2);
    const claim = await store.claim('worker-a', now + 3, 1000);
    assert.ok(claim);
    await store.fail(claim, { code: 'invalid_transcript', retryable: false, usage: unknownUsage(), provider: 'deepgram', model: 'test-model', rates: null }, now + 4);
    assert.equal((await store.batch(uid, id))!.status, 'failed');
    assert.deepEqual(await store.outputs(uid, id, now + 5), []);
    const usage = await intake.usage(uid, now + 5) as any;
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.x_posts + usage.reserved.linkedin_posts, 0);
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.x_posts + usage.consumed.linkedin_posts, 60);
  });
});

test('expired leases cannot save a transcript after another worker takes over', emulatorOnly, async () => {
  await withStore(async ({ uid, store, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'lease-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const contenders = await Promise.all([store.claim('worker-a', now + 3, 1000), store.claim('worker-b', now + 3, 1000)]);
    assert.equal(contenders.filter(Boolean).length, 1);
    const first = contenders.find(Boolean)!;
    const takeover = await store.claim('worker-c', now + 1004, 1000);
    assert.ok(takeover);
    assert.notEqual(takeover.claimId, first.claimId);
    assert.equal(await store.saveTranscript(first, result(transcript, 'deepgram'), now + 1005), false);
    assert.equal(await store.saveTranscript(takeover, result(transcript, 'deepgram'), now + 1005), true);
    assert.deepEqual(await store.transcript(uid, id), transcript);
  });
});

test('different projects cannot reserve the same remaining output allowance concurrently', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const first = await readySource();
    const second = await readySource();
    const attempts = await Promise.allSettled([
      store.start(uid, first, 'first-generation-key', { x_posts: 2, linkedin_posts: 0 }, now + 2),
      store.start(uid, second, 'second-generation-key', { x_posts: 2, linkedin_posts: 0 }, now + 2),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const usage = await intake.usage(uid, now + 2) as any;
    assert.equal(usage.reserved.x_posts, 2);
    assert.equal(usage.consumed.x_posts, 0);
    assert.equal(usage.consumed.sourceSeconds, 120);
  });
});

test('a plan can disable one output format without changing other paid features', emulatorOnly, async () => {
  await withStore(async ({ uid, store, db, grant, readySource }) => {
    const id = await readySource();
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, features: ['x_posts'] });
    await assert.rejects(store.start(uid, id, 'disabled-feature-key', { x_posts: 0, linkedin_posts: 1 }, now + 2), { code: 'feature_not_in_plan' });
    assert.equal((await store.start(uid, id, 'enabled-feature-key', { x_posts: 1, linkedin_posts: 0 }, now + 2)).slots.length, 1);
  });
});

test('the worker reuses one transcript, keeps successful posts and records a failed post attempt', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, db, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'worker-generation-key', { x_posts: 2, linkedin_posts: 1 }, now + 2);
    let clock = now + 3;
    let transcriptions = 0;
    let generations = 0;
    const worker = createGenerationWorker({ store, now: () => clock, providers: {
      transcribe: async (_project, _signal, onRequest) => {
        transcriptions++;
        await onRequest({ provider: 'deepgram', model: 'test-transcription', rates: null });
        return { ...result(transcript, 'deepgram'), usage: { ...unknownUsage(), seconds: 60 } };
      },
      generate: async (_transcript, slot, _selection, _signal, onRequest) => {
        generations++;
        await onRequest({ provider: 'anthropic', model: 'test-text', rates: null });
        if (slot.feature === 'linkedin_posts') throw new GenerationError(502, 'invalid_generated_output', 'The post was invalid.', false, { ...unknownUsage(), inputTokens: 10, outputTokens: 2 });
        return result(`Useful source-based post ${slot.ordinal}.`);
      },
    } });
    for (let stage = 0; stage < 4; stage++) {
      assert.equal(await worker.runOnce(), true);
      clock++;
    }
    assert.equal(await worker.runOnce(), false);
    assert.equal(transcriptions, 1);
    assert.equal(generations, 3);
    assert.equal((await store.batch(uid, id))!.status, 'partial');
    assert.equal((await store.outputs(uid, id, clock)).length, 2);
    assert.equal((await intake.usage(uid, clock) as any).consumed.sourceSeconds, 60);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data()).filter((event) => event.stage !== 'source_import');
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.providerInvoked === true));
    const failed = events.find((event) => event.status === 'failed')!;
    assert.equal(failed.units.outputTokens, 2);
    assert.equal(failed.cost.status, 'unknown');
  });
});

test('batch expiry finalizes crashed preparation attempts without inventing a provider request', emulatorOnly, async () => {
  await withStore(async ({ uid, store, db, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'crash-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.ok(await store.claim(`worker-${attempt}`, now + 3 + attempt * 2, 1));
    }
    const deadline = (await store.batch(uid, id))!.deadline;
    assert.equal(await store.claim('last-worker', deadline, 1), null);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data()).filter((event) => event.stage === 'transcribe');
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => event.providerInvoked === false && event.status !== 'running'));
    assert.equal((await store.batch(uid, id))!.status, 'failed');
    const usage = await intake.usage(uid, now + 10) as any;
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.x_posts, 0);
    assert.equal(usage.consumed.sourceSeconds, 60);
  });
});

test('saved retention deadlines survive grant changes and source expiry never queues another import', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, grant, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'retention-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const transcription = await store.claim('worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(transcript, 'deepgram'), now + 4);
    const generation = await store.claim('worker', now + 5, 1000);
    await store.saveOutput(generation!, result('A post worth keeping.'), now + 6);
    const unprocessedId = await readySource();
    const sourceDeadline = (await intake.get(uid, id))!.sourceExpiresAt;
    const outputDeadline = (await store.outputs(uid, id, now + 7))[0]!.expiresAt;
    assert.equal(sourceDeadline, now + 1 + 7 * 86_400_000);
    assert.equal(outputDeadline, now + 6 + 30 * 86_400_000);
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, expiresAt: '2026-12-01T00:00:00Z', limits: { ...grant.limits, sourceSeconds: 7200 } });
    assert.equal((await intake.get(uid, id))!.sourceExpiresAt, sourceDeadline);
    assert.equal((await store.outputs(uid, id, now + 8))[0]!.expiresAt, outputDeadline);
    const dayEight = now + 8 * 86_400_000;
    await assert.rejects(store.start(uid, unprocessedId, 'expired-generation-key', { x_posts: 1, linkedin_posts: 0 }, dayEight), { code: 'requires_reimport' });
    assert.equal(await store.batch(uid, unprocessedId), null);
    let imports = 0;
    const cleanup = createIntakeWorker({ store: intake, now: () => dayEight, importSource: async () => { imports++; throw Error('must not import'); }, deleteSource: async () => undefined });
    await cleanup.cleanup();
    assert.equal(await cleanup.runOnce(), false);
    assert.equal(imports, 0);
    assert.equal((await db.collection('intakeJobs').where('uid', '==', uid).get()).size, 0);
    assert.equal((await intake.get(uid, id))!.status, 'source_expired');
    assert.equal((await intake.get(uid, unprocessedId))!.status, 'source_expired');
    assert.deepEqual(await store.transcript(uid, id, dayEight), transcript);
    assert.equal((await store.outputs(uid, id, dayEight)).length, 1);
    assert.equal((await store.outputs(uid, id, dayEight))[0]!.expiresAt, outputDeadline);
    assert.equal((await store.outputs(uid, id, outputDeadline - 1)).length, 1);
    assert.deepEqual(await store.outputs(uid, id, outputDeadline), []);
    const dayThirtyOne = now + 31 * 86_400_000;
    await store.cleanup(dayThirtyOne);
    assert.deepEqual(await store.outputs(uid, id, dayThirtyOne), []);
  });
});

test('a provider result arriving after project deletion records its usage without delivering or charging an output', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, db, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'cancel-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const transcription = await store.claim('worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(transcript, 'deepgram'), now + 4);
    const generation = await store.claim('worker', now + 5, 1000);
    await store.markProviderInvoked(generation!, { provider: 'anthropic', model: 'test-model', rates: null, promptVersion: 'test-version' }, now + 6);
    const runningEvent = (await db.collection('accounts').doc(uid).collection('usageEvents').where('stage', '==', 'generate').get()).docs[0]!.data();
    assert.equal(runningEvent.promptVersion, 'test-version');
    assert.equal(runningEvent.providerInvoked, true);
    await intake.remove(uid, id, now + 7);
    assert.equal(await intake.get(uid, id), null);
    assert.equal((await db.collection('generationJobs').where('projectId', '==', id).get()).size, 0);
    const late = { ...result('This must not be delivered.'), usage: { ...unknownUsage(), inputTokens: 10, outputTokens: 2 } };
    assert.equal(await store.saveOutput(generation!, late, now + 8), false);
    assert.equal(await store.saveOutput(generation!, late, now + 9), false);
    await assert.rejects(store.outputs(uid, id, now + 10), { code: 'project_not_found' });
    assert.equal((await db.collection('accounts').doc(uid).collection('projects').doc(id).collection('outputs').get()).empty, true);
    const usage = await intake.usage(uid, now + 10) as any;
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.x_posts, 60);
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.x_posts, 0);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data()).filter((event) => event.stage === 'generate');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, 'discarded');
    assert.equal(events[0]!.units.outputTokens, 2);
    assert.equal(events[0]!.providerInvoked, true);
  });
});

test('known provider usage survives a plan change that prevents saving its completed output', emulatorOnly, async () => {
  await withStore(async ({ uid, store, db, grant, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'plan-change-generation-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    let clock = now + 3;
    const worker = createGenerationWorker({ store, now: () => clock, providers: {
      transcribe: async (_project, _signal, onRequest) => {
        await onRequest({ provider: 'deepgram', model: 'test-transcription', rates: null });
        return result(transcript, 'deepgram');
      },
      generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
        await onRequest({ provider: 'anthropic', model: 'test-text', rates: null });
        await db.collection('subscriptionGrants').doc(uid).set({ ...grant, features: [] });
        return { ...result('A completed post that is no longer allowed.'), usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20 } };
      },
    } });
    assert.equal(await worker.runOnce(), true);
    clock++;
    assert.equal(await worker.runOnce(), true);
    assert.deepEqual(await store.outputs(uid, id, clock), []);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data()).filter((event) => event.stage === 'generate');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.units.outputTokens, 20);
    assert.equal(events[0]!.units.inputTokens, 100);
  });
});

test('mixed short and long outputs honor format grants and quotas while charging the source once', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, db, grant, readySource }) => {
    const id = await readySource();
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, features: grant.features.filter((feature) => feature !== 'blogs') });
    await assert.rejects(store.start(uid, id, 'disabled-blog-key', { x_posts: 0, linkedin_posts: 0, blogs: 1 }, now + 2), { code: 'feature_not_in_plan' });
    await db.collection('subscriptionGrants').doc(uid).set(grant);
    await store.start(uid, id, 'mixed-long-form-key', { x_posts: 1, linkedin_posts: 0, blogs: 1, newsletters: 1 }, now + 2);
    let clock = now + 3;
    const worker = createGenerationWorker({ store, now: () => clock, providers: {
      transcribe: async (_project, _signal, onRequest) => {
        await onRequest({ provider: 'deepgram', model: 'test-transcription', rates: null });
        return result(transcript, 'deepgram');
      },
      generate: async (_transcript, slot, _selection, _signal, onRequest) => {
        await onRequest({ provider: 'anthropic', model: 'test-text', rates: null });
        if (slot.feature === 'newsletters') throw new GenerationError(502, 'insufficient_source', 'There was not enough usable source.', false, { ...unknownUsage(), inputTokens: 100, outputTokens: 20 });
        if (slot.feature === 'blogs') return result({ status: 'ok' as const, title: 'A useful source idea', bodyMarkdown: 'A concise article grounded in the source.' });
        return result('A concise source-based post.');
      },
    } });
    for (let stage = 0; stage < 4; stage++) {
      assert.equal(await worker.runOnce(), true);
      clock++;
      assert.equal((await intake.usage(uid, clock) as any).consumed.sourceSeconds, 60);
    }
    assert.equal((await store.batch(uid, id))!.status, 'partial');
    const outputs = await store.outputs(uid, id, clock);
    assert.equal(outputs.length, 2);
    const blog = outputs.find((output) => output.feature === 'blogs')!;
    assert.deepEqual(blog.data, { status: 'ok', title: 'A useful source idea', bodyMarkdown: 'A concise article grounded in the source.' });
    assert.ok(blog.text.includes('A useful source idea'));
    const usage = await intake.usage(uid, clock) as any;
    assert.equal(usage.consumed.blogs, 1);
    assert.equal(usage.consumed.newsletters, 0);
    assert.equal(usage.reserved.blogs + usage.reserved.newsletters, 0);
    const another = await readySource();
    await assert.rejects(store.start(uid, another, 'another-blog-key', { x_posts: 0, linkedin_posts: 0, blogs: 1 }, clock), { code: 'allowance_exceeded' });
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data());
    assert.equal(events.find((event) => event.errorCode === 'insufficient_source')!.units.outputTokens, 20);
  });
});

test('an insufficient-source newsletter releases its output reservation and preserves the import charge', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'insufficient-newsletter-key', { x_posts: 0, linkedin_posts: 0, newsletters: 1 }, now + 2);
    const transcription = await store.claim('worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(transcript, 'deepgram'), now + 4);
    const output = await store.claim('worker', now + 5, 1000);
    await store.fail(output!, { code: 'insufficient_source', retryable: false, usage: { ...unknownUsage(), outputTokens: 20 }, provider: 'anthropic', model: 'test-model', rates: null }, now + 6);
    assert.equal((await store.batch(uid, id))!.status, 'failed');
    assert.deepEqual(await store.outputs(uid, id, now + 7), []);
    const usage = await intake.usage(uid, now + 7) as any;
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.newsletters, 0);
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.newsletters, 60);
  });
});

const carouselPlan = () => ({ status: 'ok' as const, slides: Array.from({ length: 5 }, (_, index) => ({ title: `Source idea ${index + 1}`, body: 'A practical explanation grounded in the source.' })) });

test('carousel delivery enforces Light density and theme changes cannot bypass whole-copy deduplication', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, grant, readySource }) => {
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, limits: { ...grant.limits, carousels: 2 } });
    const id = await readySource();
    const selection = { x_posts: 0, linkedin_posts: 0, carousels: 1 };
    const context = (theme: 'dark' | 'light') => {
      const request = { formats: { carousels: { density: 'light' as const, theme } } };
      return { request, snapshot: resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} }) };
    };
    await store.start(uid, id, 'light-density-dark-theme', selection, now + 2, undefined, undefined, context('dark'));
    const transcribe = (await store.claim('worker', now + 3, 1000))!;
    await store.saveTranscript(transcribe, result(transcript), now + 4);
    const claim = (await store.claim('worker', now + 5, 1000))!;
    const oversized = carouselPlan(); oversized.slides[0]!.body = 'x'.repeat(161);
    await assert.rejects(store.saveOutput(claim, result(oversized), now + 6), (error: any) => error.code === 'invalid_generated_output' && error.validation.limit === 160);
    const assets = (current: typeof claim) => Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, id, current.slot!.id, current.attempt, index + 1), contentType: 'image/png' as const, bytes: 100, width: 1080, height: 1080 }));
    assert.equal(await store.saveOutput(claim, { ...result(carouselPlan()), assets: assets(claim) }, now + 7), true);
    await store.start(uid, id, 'light-density-light-theme', selection, now + 8, undefined, undefined, context('light'));
    const duplicate = (await store.claim('worker', now + 9, 1000))!;
    assert.equal(await store.saveOutput(duplicate, { ...result(carouselPlan()), assets: assets(duplicate) }, now + 10), false);
    assert.equal((await store.batch(uid, id))!.slots[0]!.errorCode, 'duplicate_generated_output');
    const usage = await intake.usage(uid, now + 11) as any;
    assert.equal(usage.consumed.carousels, 1);
    assert.equal(usage.reserved.carousels, 0);
  });
});

test('a mixed carousel batch consumes one carousel allowance and retains images until output expiry', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    const images = new Map<string, Buffer>();
    const renderer = createCarouselRenderer({ storage: { uploadBytes: async (path, bytes) => { images.set(path, bytes); }, remove: async (path) => { images.delete(path); } } });
    await store.start(uid, id, 'mixed-carousel-key', { x_posts: 1, linkedin_posts: 1, carousels: 1 }, now + 2);
    let clock = now + 3;
    const worker = createGenerationWorker({ store, now: () => clock, renderCarousel: renderer, providers: {
      transcribe: async (_project, _signal, onRequest) => { await onRequest({ provider: 'deepgram', model: 'test-model', rates: null }); return result(transcript, 'deepgram'); },
      generate: async (_transcript, slot, _selection, _signal, onRequest) => {
        await onRequest({ provider: 'anthropic', model: 'test-model', rates: null });
        if (slot.feature === 'linkedin_posts') throw new GenerationError(422, 'insufficient_source', 'Not enough source.');
        return slot.feature === 'carousels' ? result(carouselPlan()) : result('A useful source-based post.');
      },
    } });
    for (let stage = 0; stage < 4; stage++) { assert.equal(await worker.runOnce(), true); clock++; }
    assert.equal((await store.batch(uid, id))!.status, 'partial');
    const output = (await store.outputs(uid, id, clock)).find((item) => item.feature === 'carousels')!;
    assert.equal(output.assets!.length, 5);
    assert.equal(images.size, 5);
    const usage = await intake.usage(uid, clock) as any;
    assert.equal(usage.consumed.sourceSeconds, 60);
    assert.equal(usage.consumed.carousels, 1);
    assert.equal(usage.reserved.carousels, 0);
    assert.equal(await store.asset('other-account', id, output.id, 'slide-1', clock), null);
    const another = await readySource();
    await assert.rejects(store.start(uid, another, 'another-carousel-key', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, clock), { code: 'allowance_exceeded' });
    const cleanup = createGenerationStore(db, { remove: async (path) => { images.delete(path); } });
    const dayEight = now + 8 * 86_400_000;
    await intake.remove(uid, id, dayEight, true);
    await cleanup.cleanup(dayEight);
    assert.equal(images.size, 5);
    assert.equal((await cleanup.output(uid, id, output.id, dayEight))!.assets!.length, 5);
    await cleanup.cleanup(now + 31 * 86_400_000);
    assert.equal(images.size, 0);
    assert.equal(await cleanup.output(uid, id, output.id, now + 31 * 86_400_000), null);
  });
});

test('all five images are required before success and deleting the project revokes access before cleanup', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'complete-carousel-key', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 2);
    const transcription = await store.claim('worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(transcript, 'deepgram'), now + 4);
    const output = await store.claim('worker', now + 5, 1000);
    const assets = Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, id, output!.slot!.id, output!.attempt, index + 1), contentType: 'image/png' as const, bytes: 100, width: 1080, height: 1080 }));
    await assert.rejects(store.saveOutput(output!, { ...result(carouselPlan()), assets: assets.slice(0, 4) }, now + 6), { code: 'carousel_render_failed' });
    assert.equal((await intake.usage(uid, now + 6) as any).consumed.carousels, 0);
    assert.equal(await store.saveOutput(output!, { ...result(carouselPlan()), assets }, now + 7), true);
    assert.ok(await store.asset(uid, id, output!.slot!.id, 'slide-1', now + 8));
    await intake.remove(uid, id, now + 9);
    assert.equal(await store.asset(uid, id, output!.slot!.id, 'slide-1', now + 10), null);
    const removed: string[] = [];
    await createGenerationStore(db, { remove: async (path) => { removed.push(path); } }).cleanup(now + 11);
    assert.ok(assets.every((asset) => removed.includes(asset.storagePath)));
  });
});

test('render failure keeps the completed Claude usage while releasing the unsuccessful carousel allowance', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'failed-carousel-key', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 2);
    let clock = now + 3;
    const worker = createGenerationWorker({ store, now: () => clock, renderCarousel: async () => { throw new GenerationError(502, 'carousel_render_failed', 'Rendering failed.'); }, providers: {
      transcribe: async (_project, _signal, onRequest) => { await onRequest({ provider: 'deepgram', model: 'test-model', rates: null }); return result(transcript, 'deepgram'); },
      generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
        await onRequest({ provider: 'anthropic', model: 'test-model', rates: null });
        return { ...result(carouselPlan()), usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20 } };
      },
    } });
    assert.equal(await worker.runOnce(), true);
    clock++;
    assert.equal(await worker.runOnce(), true);
    const usage = await intake.usage(uid, clock) as any;
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.carousels, 60);
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.carousels, 0);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data());
    assert.equal(events.find((event) => event.errorCode === 'carousel_render_failed')!.units.outputTokens, 20);
  });
});

test('source expiry queues unfinished carousel images for cleanup without charging the cancelled result', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'expired-carousel-key', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 2);
    let clock = now + 3;
    const images = new Set<string>();
    const worker = createGenerationWorker({ store, now: () => clock,
      renderCarousel: async (_plan, claim) => {
        images.add(assetPath(uid, id, claim.slot!.id, claim.attempt, 1));
        images.add(assetPath(uid, id, claim.slot!.id, claim.attempt, 2));
        clock = now + 8 * 86_400_000;
        await intake.remove(uid, id, clock, true);
        throw new GenerationError(502, 'carousel_render_failed', 'The source expired during rendering.');
      },
      providers: {
        transcribe: async (_project, _signal, onRequest) => { await onRequest({ provider: 'deepgram', model: 'test-model', rates: null }); return result(transcript, 'deepgram'); },
        generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
          await onRequest({ provider: 'anthropic', model: 'test-model', rates: null });
          return { ...result(carouselPlan()), usage: { ...unknownUsage(), outputTokens: 20 } };
        },
      },
    });
    assert.equal(await worker.runOnce(), true);
    clock++;
    assert.equal(await worker.runOnce(), true);
    assert.equal(images.size, 2);
    await createGenerationStore(db, { remove: async (path) => { images.delete(path); } }).cleanup(clock + 1);
    assert.equal(images.size, 0);
    const usage = await intake.usage(uid, clock + 1) as any;
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.carousels, 60);
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.carousels, 0);
  });
});

const videoTranscript: Transcript = { text: 'A useful source idea.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'useful', start: 1, end: 2 }, { text: 'idea', start: 9, end: 10 }] };
const videoPlan = () => ({ status: 'ok' as const, startSeconds: 0, endSeconds: 10 });

test('a stitched clip validates its summed duration and consumes one video allowance', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'stitched-video-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 2);
    const transcription = await store.claim('worker', now + 3, 1000);
    const stitchedTranscript: Transcript = { text: 'Problem. Explanation. Qualified takeaway.', words: [
      { text: 'Problem.', start: 0, end: 4 },
      { text: 'Explanation.', start: 20, end: 25 },
      { text: 'Qualified', start: 40, end: 42 },
      { text: 'takeaway.', start: 42, end: 45 },
    ] };
    await store.saveTranscript(transcription!, result(stitchedTranscript, 'deepgram'), now + 4);
    const claim = (await store.claim('worker', now + 5, 1000))!;
    const plan = { status: 'ok' as const, segments: [
      { startSeconds: 0, endSeconds: 4 },
      { startSeconds: 20, endSeconds: 25 },
      { startSeconds: 40, endSeconds: 45 },
    ] };
    const asset = { id: 'clip', storagePath: videoPath(uid, id, claim.slot!.id, claim.attempt), contentType: 'video/mp4' as const, bytes: 123, width: 720, height: 1280, durationSeconds: 14 };
    await assert.rejects(store.saveOutput(claim, { ...result(plan), assets: [{ ...asset, durationSeconds: 45 }] }, now + 6), { code: 'video_render_failed' });
    assert.equal((await intake.usage(uid, now + 6) as any).consumed.short_videos, 0);
    assert.equal(await store.saveOutput(claim, { ...result(plan), assets: [asset] }, now + 7), true);
    const output = (await store.outputs(uid, id, now + 8))[0]!;
    assert.deepEqual(output.data, plan);
    assert.equal(output.assets![0]!.durationSeconds, 14);
    const usage = await intake.usage(uid, now + 8) as any;
    assert.equal(usage.consumed.short_videos, 1);
    assert.equal(usage.reserved.short_videos, 0);
    assert.equal(usage.consumed.sourceSeconds, 60);
  });
});

test('a mixed video batch consumes one video allowance and keeps its private asset for output retention', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, grant, readySource }) => {
    const id = await readySource();
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, features: grant.features.filter((feature) => feature !== 'short_videos') });
    await assert.rejects(store.start(uid, id, 'disabled-video-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 2), { code: 'feature_not_in_plan' });
    await db.collection('subscriptionGrants').doc(uid).set(grant);
    await store.start(uid, id, 'mixed-video-key', { x_posts: 1, linkedin_posts: 0, newsletters: 1, short_videos: 1 }, now + 2);
    let clock = now + 3;
    const files = new Set<string>();
    const worker = createGenerationWorker({ store, now: () => clock,
      renderVideo: async (_plan, claim) => {
        const path = videoPath(uid, id, claim.slot!.id, claim.attempt);
        files.add(path);
        return [{ id: 'clip', storagePath: path, contentType: 'video/mp4', bytes: 123, width: 720, height: 1280, durationSeconds: 10 }];
      },
      providers: {
        transcribe: async (_project, _signal, onRequest) => { await onRequest({ provider: 'deepgram', model: 'test-model', rates: null }); return result(videoTranscript, 'deepgram'); },
        generate: async (_transcript, slot, _selection, _signal, onRequest) => {
          await onRequest({ provider: 'anthropic', model: 'test-model', rates: null });
          if (slot.feature === 'newsletters') throw new GenerationError(422, 'insufficient_source', 'Not enough source.');
          return slot.feature === 'short_videos' ? result(videoPlan()) : result('A useful source-based post.');
        },
      },
    });
    for (let stage = 0; stage < 4; stage++) { assert.equal(await worker.runOnce(), true); clock++; }
    assert.equal((await store.batch(uid, id))!.status, 'partial');
    const output = (await store.outputs(uid, id, clock)).find((item) => item.feature === 'short_videos')!;
    assert.equal(output.assets!.length, 1);
    assert.equal(files.size, 1);
    const usage = await intake.usage(uid, clock) as any;
    assert.equal(usage.consumed.sourceSeconds, 60);
    assert.equal(usage.consumed.short_videos, 1);
    assert.equal(usage.reserved.short_videos, 0);
    const another = await readySource();
    await assert.rejects(store.start(uid, another, 'another-video-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, clock), { code: 'allowance_exceeded' });
    const cleanup = createGenerationStore(db, { remove: async (path) => { files.delete(path); } });
    await intake.remove(uid, id, now + 8 * 86_400_000, true);
    await cleanup.cleanup(now + 8 * 86_400_000);
    assert.equal(files.size, 1);
    await cleanup.cleanup(now + 31 * 86_400_000);
    assert.equal(files.size, 0);
    assert.equal(await cleanup.output(uid, id, output.id, now + 31 * 86_400_000), null);
  });
});

test('a video is not delivered until its validated private asset is ready and deletion revokes access immediately', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'ready-video-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 2);
    const transcription = await store.claim('worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(videoTranscript, 'deepgram'), now + 4);
    const claim = await store.claim('worker', now + 5, 1000);
    const asset = { id: 'clip', storagePath: videoPath(uid, id, claim!.slot!.id, claim!.attempt), contentType: 'video/mp4' as const, bytes: 123, width: 720, height: 1280, durationSeconds: 10 };
    for (const assets of [[], [{ ...asset, width: 1080 }], [{ ...asset, durationSeconds: 11 }], [{ ...asset, storagePath: 'accounts/other/private.mp4' }]]) {
      await assert.rejects(store.saveOutput(claim!, { ...result(videoPlan()), assets }, now + 6), { code: 'video_render_failed' });
    }
    assert.equal((await intake.usage(uid, now + 6) as any).consumed.short_videos, 0);
    assert.equal(await store.saveOutput(claim!, { ...result(videoPlan()), assets: [asset] }, now + 7), true);
    await intake.remove(uid, id, now + 8);
    assert.equal(await store.asset(uid, id, claim!.slot!.id, 'clip', now + 9), null);
    const removed: string[] = [];
    await createGenerationStore(db, { remove: async (path) => { removed.push(path); } }).cleanup(now + 10);
    assert.ok(removed.includes(asset.storagePath));
  });
});

test('a failed video render retains Claude usage and releases unsuccessful source and video allowance', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'failed-video-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 2);
    let clock = now + 3;
    const worker = createGenerationWorker({ store, now: () => clock,
      renderVideo: async () => { throw new GenerationError(502, 'video_render_failed', 'Rendering failed.'); },
      providers: {
        transcribe: async (_project, _signal, onRequest) => { await onRequest({ provider: 'deepgram', model: 'test-model', rates: null }); return result(videoTranscript, 'deepgram'); },
        generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
          await onRequest({ provider: 'anthropic', model: 'test-model', rates: null });
          return { ...result(videoPlan()), usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20 } };
        },
      },
    });
    assert.equal(await worker.runOnce(), true);
    clock++;
    assert.equal(await worker.runOnce(), true);
    const usage = await intake.usage(uid, clock) as any;
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.short_videos, 60);
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.short_videos, 0);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map((event) => event.data());
    assert.equal(events.find((event) => event.errorCode === 'video_render_failed')!.units.outputTokens, 20);
  });
});

test('source expiry removes a video left by interrupted rendering without charging its cancelled output', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'expired-video-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 2);
    let clock = now + 3;
    const files = new Set<string>();
    const worker = createGenerationWorker({ store, now: () => clock,
      renderVideo: async (_plan, claim) => {
        files.add(videoPath(uid, id, claim.slot!.id, claim.attempt));
        clock = now + 8 * 86_400_000;
        await intake.remove(uid, id, clock, true);
        throw new GenerationError(502, 'video_render_failed', 'The source expired.');
      },
      providers: {
        transcribe: async (_project, _signal, onRequest) => { await onRequest({ provider: 'deepgram', model: 'test-model', rates: null }); return result(videoTranscript, 'deepgram'); },
        generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
          await onRequest({ provider: 'anthropic', model: 'test-model', rates: null });
          return { ...result(videoPlan()), usage: { ...unknownUsage(), outputTokens: 20 } };
        },
      },
    });
    assert.equal(await worker.runOnce(), true);
    clock++;
    assert.equal(await worker.runOnce(), true);
    assert.equal(files.size, 1);
    await createGenerationStore(db, { remove: async (path) => { files.delete(path); } }).cleanup(clock + 1);
    assert.equal(files.size, 0);
    const usage = await intake.usage(uid, clock + 1) as any;
    assert.equal(usage.consumed.sourceSeconds + usage.consumed.short_videos, 60);
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.short_videos, 0);
  });
});

test('retention is validated, snapshotted at admission and starts at successful completion', emulatorOnly, async () => {
  await withStore(async ({ uid, db, intake, grant }) => {
    const { isGrant, buildCapabilities } = await import('../../src/access/policy.js');
    for (const days of [1, 7, 30] as const) {
      assert.ok(isGrant({ ...grant, sourceRetentionDays: days }));
      await db.collection('subscriptionGrants').doc(uid).set({ ...grant, sourceRetentionDays: days });
      const id = randomUUID();
      const created = await intake.create({ uid, id, key: randomUUID(), input: { fileId: 'video-id' }, source: { fileId: 'video-id', name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true }, now });
      assert.equal(created.sourceRetentionDays, days);
      await db.collection('subscriptionGrants').doc(uid).update({ sourceRetentionDays: days === 30 ? 1 : 30 });
      const claim = await intake.claim(`retention-${id}`, now + 100, 1000) ?? await intake.claim(`retention-${id}`, now + 100, 1000);
      assert.ok(claim);
      assert.equal(await intake.complete(claim, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, id, claim.attempt) }, now + 200), true);
      assert.equal((await intake.get(uid, id))!.sourceExpiresAt, now + 200 + days * 86_400_000);
    }
    for (const days of [0, 2, 31, '7', null]) assert.equal(isGrant({ ...grant, sourceRetentionDays: days }), false);
    assert.equal(buildCapabilities({ ...grant, sourceRetentionDays: 1 }, new Date(now)).operationalLimits.sourceRetentionDays, 1);
  });
});

test('source cleanup preserves a running transcript-only claim and source accounting while cancelling video', emulatorOnly, async () => {
  await withStore(async ({ uid, db, intake, store, readySource }) => {
    const id = await readySource();
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id);
    await ref.update({ sourceExpiresAt: now + 20, sourceCleanupAt: now + 20 });
    await store.start(uid, id, 'independent-transcript-key', { x_posts: 1, linkedin_posts: 0, short_videos: 1 }, now + 2);
    const transcription = await store.claim('retention-worker', now + 3, 1000);
    assert.ok(transcription);
    await store.saveTranscript(transcription, result(transcript, 'deepgram'), now + 4);
    const saved = (await ref.collection('transcripts').doc('shared').get()).data()!;
    assert.equal(saved.createdAt, now + 4);
    assert.equal(saved.expiresAt, now + 4 + 30 * 86_400_000);
    const text = await store.claim('retention-worker', now + 5, 1000);
    assert.equal(text!.slot!.feature, 'x_posts');
    const paths: string[] = [];
    const cleanup = createIntakeWorker({ store: intake, now: () => now + 20, importSource: async () => { throw Error('No hidden import.'); }, deleteSource: async path => { paths.push(path); } });
    await cleanup.cleanup();
    assert.equal((await intake.get(uid, id))!.status, 'source_expired');
    assert.deepEqual(await store.transcript(uid, id, now + 20), transcript);
    assert.equal(await store.renew(text!, now + 21, 1000), true);
    assert.equal(await store.markProviderInvoked(text!, { provider: 'anthropic', model: 'test', rates: null }, now + 21), true);
    assert.equal(await store.saveOutput(text!, result('Preserved text.'), now + 22), true);
    assert.equal((await store.batch(uid, id))!.status, 'partial');
    assert.equal((await store.batch(uid, id))!.slots.find(slot => slot.feature === 'short_videos')!.errorCode, 'source_expired');
    const usage = await intake.usage(uid, now + 22) as any;
    assert.equal(usage.consumed.sourceSeconds, 60);
    assert.equal(usage.reserved.sourceSeconds + usage.reserved.x_posts + usage.reserved.short_videos, 0);
    await intake.remove(uid, id, now + 23);
    assert.equal(await store.transcript(uid, id, now + 23), null);
    assert.equal((await ref.collection('transcripts').get()).size, 0);
    assert.equal(paths.length, 0, 'Source cleanup only queues physical deletion.');
    await createGenerationStore(db, { remove: async path => { paths.push(path); } }).cleanup(now + 24);
    assert.ok(paths.length);
  });
});

test('timestamp cutoffs block media and transcription before cleanup and retain late costs', emulatorOnly, async () => {
  await withStore(async ({ uid, db, intake, store, readySource }) => {
    const id = await readySource();
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id);
    await ref.update({ sourceExpiresAt: now + 20, sourceCleanupAt: now + 20 });
    await store.start(uid, id, 'cutoff-transcription-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const claim = await store.claim('cutoff-worker', now + 3, 1000);
    assert.ok(claim);
    assert.equal(await store.markProviderInvoked(claim, { provider: 'deepgram', model: 'test', rates: null }, now + 19), true);
    assert.equal(await store.renew(claim, now + 20, 1000), false);
    assert.equal(await store.markProviderInvoked(claim, { provider: 'deepgram', model: 'test', rates: null }, now + 20), false);
    assert.equal(await store.saveTranscript(claim, { ...result(transcript, 'deepgram'), usage: { ...unknownUsage(), seconds: 60 } }, now + 20), false);
    assert.equal(await store.transcript(uid, id, now + 20), null);
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map(doc => doc.data());
    assert.equal(events.find(event => event.stage === 'transcribe')!.status, 'discarded');
    assert.equal(events.find(event => event.stage === 'transcribe')!.units.seconds, 60);
    await store.claim('after-cutoff', now + 1004, 1000);
    assert.equal((await store.batch(uid, id))!.status, 'failed');
    assert.equal((await intake.usage(uid, now + 1004) as any).reserved.x_posts, 0);
  });
});

test('expired transcripts invalidate claims and legacy expiry never slides with read time', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id);
    await store.start(uid, id, 'transcript-expiry-key', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const transcription = await store.claim('transcript-worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(transcript, 'deepgram'), now + 4);
    const claim = await store.claim('transcript-worker', now + 5, 1000);
    const saved = ref.collection('transcripts').doc('shared');
    await saved.update({ expiresAt: now + 20, cleanupAt: now + 20 });
    assert.deepEqual(await store.transcript(uid, id, now + 19), transcript);
    assert.equal(await store.transcript(uid, id, now + 20), null);
    assert.equal(await store.markProviderInvoked(claim!, { provider: 'anthropic', model: 'test', rates: null }, now + 20), false);
    assert.equal(await store.renew(claim!, now + 20, 1000), false);
    assert.equal(await store.saveOutput(claim!, { ...result('A late post.'), usage: { ...unknownUsage(), outputTokens: 20 } }, now + 20), false);
    await store.cleanup(now + 20);
    assert.equal((await saved.get()).exists, false);
    await store.claim('after-transcript-cutoff', now + 1006, 1000);
    assert.equal((await store.batch(uid, id))!.status, 'failed');
    assert.equal((await intake.usage(uid, now + 1006) as any).reserved.x_posts, 0);
    await saved.set(transcript);
    const expiry = now + 2 + 30 * 86_400_000;
    assert.deepEqual(await store.transcript(uid, id, expiry - 1), transcript);
    assert.equal(await store.transcript(uid, id, expiry), null);
    await store.cleanup(expiry - 1);
    assert.equal((await saved.get()).data()!.expiresAt, expiry);
    await store.cleanup(expiry);
    assert.equal((await saved.get()).exists, false);
  });
});

test('live carousel rendering survives source cleanup and keeps its delivered images', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    // Real SDK awaits need headroom; policy time advances explicitly inside renderCarousel.
    const sourceExpiry = now + 60_000;
    await db.collection('accounts').doc(uid).collection('projects').doc(id).update({ sourceExpiresAt: sourceExpiry, sourceCleanupAt: sourceExpiry });
    await store.start(uid, id, 'carousel-source-independent-key', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 2);
    let clock = now + 3;
    const images = new Set<string>();
    let renewals = 0;
    const workerStore = { ...store, renew: async (...args: Parameters<typeof store.renew>) => { renewals++; return store.renew(...args); } };
    const worker = createGenerationWorker({ store: workerStore, now: () => clock,
      providers: {
        transcribe: async (_project, _signal, onRequest) => { await new Promise(resolve => setTimeout(resolve, 30)); await onRequest({ provider: 'deepgram', model: 'test', rates: null }); return result(transcript, 'deepgram'); },
        generate: async (_text, _slot, _selection, _signal, onRequest) => { await onRequest({ provider: 'anthropic', model: 'test', rates: null }); return result(carouselPlan()); },
      },
      renderCarousel: async (_plan, claim) => {
        const assets = Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, id, claim.slot!.id, claim.attempt, index + 1), contentType: 'image/png' as const, width: 1080, height: 1080, bytes: 100 }));
        assets.forEach(asset => images.add(asset.storagePath));
        clock = sourceExpiry;
        await createIntakeWorker({ store: intake, now: () => clock, importSource: async () => { throw Error('No hidden import.'); }, deleteSource: async () => undefined }).cleanup();
        return assets;
      },
    });
    await worker.runOnce();
    assert.equal(renewals, 0, 'static policy time must not cause repeated real-time lease renewal during transcription');
    clock++;
    await worker.runOnce();
    assert.equal((await store.batch(uid, id))!.status, 'completed');
    assert.equal((await store.outputs(uid, id, clock))[0]!.assets!.length, 5);
    await createGenerationStore(db, { remove: async path => { images.delete(path); } }).cleanup(clock + 1);
    assert.equal(images.size, 5);
  });
});

test('video provider admission and result delivery stop exactly at source expiry without cleanup', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    await db.collection('accounts').doc(uid).collection('projects').doc(id).update({ sourceExpiresAt: now + 20, sourceCleanupAt: now + 20 });
    await store.start(uid, id, 'video-timestamp-cutoff-key', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 2);
    const transcription = await store.claim('video-cutoff-worker', now + 3, 1000);
    await store.saveTranscript(transcription!, result(videoTranscript, 'deepgram'), now + 4);
    const claim = await store.claim('video-cutoff-worker', now + 5, 1000);
    assert.equal(await store.markProviderInvoked(claim!, { provider: 'anthropic', model: 'test', rates: null }, now + 19), true);
    assert.equal(await store.markProviderInvoked(claim!, { provider: 'anthropic', model: 'test', rates: null }, now + 20), false);
    assert.equal(await store.renew(claim!, now + 20, 1000), false);
    assert.equal(await store.saveOutput(claim!, { ...result(videoPlan()), assets: [{ id: 'clip', storagePath: videoPath(uid, id, claim!.slot!.id, claim!.attempt), contentType: 'video/mp4', width: 720, height: 1280, bytes: 100, durationSeconds: 10 }], usage: { ...unknownUsage(), outputTokens: 20 } }, now + 20), false);
    assert.deepEqual(await store.outputs(uid, id, now + 20), []);
  });
});

test('repeat batches preserve legacy results, request replay, distinct jobs and current-period accounting', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, grant, readySource }) => {
    const id = await readySource();
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const first = await store.start(uid, id, 'original-batch-key', selection, now + 2);
    const asr = (await store.claim('first-worker', now + 3, 1000))!;
    await store.saveTranscript(asr, result(transcript, 'deepgram'), now + 4);
    const firstClaim = (await store.claim('first-worker', now + 5, 1000))!;
    await store.saveOutput(firstClaim, result('First saved result.'), now + 6);
    // Simulate an existing installation without batch IDs or durable request maps.
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id);
    const legacy = (await ref.collection('generation').doc('batch').get()).data()!;
    delete legacy.id;
    await ref.collection('generation').doc('batch').set(legacy);
    await db.recursiveDelete(ref.collection('generationRequests'));
    const nextGrant = { ...grant, startsAt: '2026-10-18T12:00:00Z', expiresAt: '2026-11-18T12:00:00Z', limits: { ...grant.limits, sourceSeconds: 0 } };
    await db.collection('subscriptionGrants').doc(uid).set(nextGrant);
    assert.deepEqual((await store.availability!(uid, id, now + 7)).access, { active: true, reason: 'active', expiresAt: nextGrant.expiresAt });
    const concurrent = await Promise.allSettled([
      store.start(uid, id, 'next-batch-key-a', selection, now + 7),
      store.start(uid, id, 'next-batch-key-b', selection, now + 7),
    ]);
    assert.equal(concurrent.filter(entry => entry.status === 'fulfilled').length, 1);
    const next = concurrent.find(entry => entry.status === 'fulfilled')!.value;
    assert.notEqual(next.id, first.id);
    assert.notEqual(next.period, first.period);
    assert.notEqual(next.slots[0]!.id, first.slots[0]!.id);
    assert.equal(next.transcriptReady, true);
    const pending = await db.collection('generationJobs').where('uid', '==', uid).get();
    assert.equal(pending.size, 1);
    assert.equal(pending.docs[0]!.data().batchId, next.id);
    assert.equal(await store.renew(firstClaim, now + 8, 1000), false);
    assert.equal(await store.markProviderInvoked(firstClaim, { provider: 'anthropic', model: 'test', rates: null }, now + 8), false);
    assert.equal(await store.saveOutput(firstClaim, result('Stale write.'), now + 8), false);
    const nextClaim = (await store.claim('next-worker', now + 8, 1000))!;
    assert.equal(nextClaim.stage, 'generate');
    await store.saveOutput(nextClaim, result('Second saved result.'), now + 9);
    const before = await intake.usage(uid, now + 10);
    assert.equal((before as any).consumed.sourceSeconds, 0);
    assert.equal((before as any).consumed.x_posts, 1);
    const replay = await store.start(uid, id, 'original-batch-key', selection, now + 40 * 86_400_000);
    assert.equal(replay.createdAt, first.createdAt);
    assert.equal(replay.status, 'completed');
    assert.deepEqual(await intake.usage(uid, now + 10), before);
    assert.equal((await db.collection('generationJobs').where('uid', '==', uid).get()).size, 0);
    await assert.rejects(store.start(uid, id, 'original-batch-key', { x_posts: 2, linkedin_posts: 0 }, now + 10), { code: 'idempotency_conflict' });
    await assert.rejects(store.start('other-user', id, 'original-batch-key', selection, now + 10), { code: 'project_not_found' });
    assert.equal((await store.outputs(uid, id, now + 10)).length, 2);
    assert.equal((await store.output(uid, id, first.slots[0]!.id, now + 10))!.text, 'First saved result.');
    const events = (await db.collection('accounts').doc(uid).collection('usageEvents').get()).docs.map(doc => doc.data());
    assert.equal(events.filter(event => event.stage === 'generate' && event.status === 'succeeded').length, 2);
    assert.notEqual(events.filter(event => event.stage === 'generate' && event.status === 'succeeded')[0]!.outputId, events.filter(event => event.stage === 'generate' && event.status === 'succeeded')[1]!.outputId);
  });
});

test('expired source permits transcript-only repeat generation and refuses clips before any paid work', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, grant, readySource }) => {
    const id = await readySource();
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, limits: { ...grant.limits, x_posts: 5, carousels: 2 } });
    const first = await store.start(uid, id, 'source-expiry-first', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    await store.saveTranscript((await store.claim('worker', now + 3, 1000))!, result(transcript, 'deepgram'), now + 4);
    await store.saveOutput((await store.claim('worker', now + 5, 1000))!, result('Delivered before source expiry.'), now + 6);
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(id);
    await ref.update({ sourceExpiresAt: now + 10 });
    await intake.remove(uid, id, now + 11, true);
    const availability = await store.availability!(uid, id, now + 11);
    assert.deepEqual(availability.access, { active: true, reason: 'active', expiresAt: grant.expiresAt });
    assert.equal(availability.sourceAvailable, false);
    assert.equal(availability.transcriptAvailable, true);
    assert.equal(availability.outputs.x_posts.available, true);
    assert.equal(availability.outputs.carousels.available, true);
    assert.equal(availability.outputs.short_videos.reason, 'requires_reimport');
    const before = await intake.usage(uid, now + 11);
    await assert.rejects(store.start(uid, id, 'reject-expired-video', { x_posts: 0, linkedin_posts: 0, short_videos: 1 }, now + 11), { code: 'requires_reimport' });
    assert.deepEqual(await intake.usage(uid, now + 11), before);
    assert.equal((await db.collection('generationJobs').where('uid', '==', uid).get()).size, 0);
    const second = await store.start(uid, id, 'source-expiry-repeat', { x_posts: 1, linkedin_posts: 0 }, now + 12);
    assert.equal(second.transcriptReady, true);
    let transcriptions = 0;
    let generations = 0;
    const worker = createGenerationWorker({ store, now: () => now + 13, providers: {
      transcribe: async () => { transcriptions++; throw Error('No source download or ASR permitted.'); },
      generate: async (saved, _slot, _selection, _signal, onRequest) => { generations++; assert.deepEqual(saved, transcript); await onRequest({ provider: 'anthropic', model: 'test', rates: null }); return result('New post from cached transcript.'); },
    } });
    assert.equal(await worker.runOnce(), true);
    assert.equal(transcriptions, 0);
    assert.equal(generations, 1);
    assert.equal((await intake.usage(uid, now + 14) as any).consumed.sourceSeconds, 60);
    assert.equal((await store.outputs(uid, id, now + 14)).length, 2);
    assert.equal((await store.output(uid, id, first.slots[0]!.id, now + 14))!.text, 'Delivered before source expiry.');
    assert.equal((await ref.collection('transcripts').doc('shared').get()).data()!.expiresAt, now + 4 + 30 * 86_400_000);
    await ref.collection('transcripts').doc('shared').update({ expiresAt: now + 15 });
    await assert.rejects(store.start(uid, id, 'expired-both-repeat', { x_posts: 1, linkedin_posts: 0 }, now + 16), { code: 'requires_reimport' });
    assert.equal((await store.availability!(uid, id, now + 16)).outputs.carousels.reason, 'requires_reimport');
  });
});

test('repeat carousel files are distinct and source cleanup preserves every delivered batch asset', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, intake, grant, readySource }) => {
    const id = await readySource();
    await db.collection('subscriptionGrants').doc(uid).set({ ...grant, limits: { ...grant.limits, carousels: 2 } });
    const selection = { x_posts: 0, linkedin_posts: 0, carousels: 1 };
    const assets: string[] = [];
    for (let run = 0; run < 2; run++) {
      const content = { status: 'ok' as const, slides: Array.from({ length: 5 }, (_, index) => ({ title: `${run ? 'Apply' : 'Understand'} idea ${index + 1}`, body: run ? 'Apply the practical idea from the video.' : 'Understand the practical idea from the video.' })) };
      const time = now + 2 + run * 10;
      await store.start(uid, id, `carousel-repeat-key-${run}`, selection, time);
      if (!run) await store.saveTranscript((await store.claim('worker', time + 1, 1000))!, result(transcript, 'deepgram'), time + 2);
      const claim = (await store.claim('worker', time + 3, 1000))!;
      const rendered = Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, id, claim.slot!.id, claim.attempt, index + 1), contentType: 'image/png' as const, bytes: 20, width: 1080, height: 1080 }));
      assets.push(...rendered.map(asset => asset.storagePath));
      await store.saveOutput(claim, { ...result(content), assets: rendered }, time + 4);
    }
    assert.equal(new Set(assets).size, 10);
    await intake.remove(uid, id, now + 30, true);
    const output = await store.outputs(uid, id, now + 30);
    assert.equal(output.length, 2);
    for (const saved of output) assert.ok(await store.asset(uid, id, saved.id, 'slide-1', now + 31));
    const cleanup = await db.collection('assetCleanup').get();
    assert.ok(cleanup.docs.every(doc => !(doc.data().paths as string[]).some(path => assets.includes(path))));
    await intake.remove(uid, id, now + 32);
    await intake.remove(uid, id, now + 33);
    assert.equal((await store.outputs(uid, id, now + 32).catch(() => [])).length, 0);
    const deleted = await db.collection('assetCleanup').doc(`${id}-deleted`).get();
    assert.ok(assets.every(path => deleted.data()!.paths.includes(path)));
    const remaining = new Set(assets);
    await createGenerationStore(db, { remove: async path => { remaining.delete(path); } }).cleanup(now + 34);
    assert.equal(remaining.size, 0);
  });
});

test('cleanup retains paths added while deletion is running and retries failed deletions', emulatorOnly, async () => {
  await withStore(async ({ db, uid }) => {
    const job = db.collection('assetCleanup').doc(`000-cleanup-race-${randomUUID()}`);
    const first = sourcePath(uid, job.id, 1, 'mp4'), second = sourcePath(uid, job.id, 2, 'mp4');
    await job.set({ paths: [first], createdAt: now });
    let expanded = false;
    const removed: string[] = [];
    const cleanup = createGenerationStore(db, { remove: async path => {
      if (!path.includes(`/projects/${job.id}/`)) return;
      removed.push(path);
      if (!expanded) {
        expanded = true;
        await job.set({ paths: [first, second], createdAt: now + 1 }, { merge: true });
      }
    } });
    await cleanup.cleanup(now + 2);
    assert.equal((await job.get()).exists, true);
    await cleanup.cleanup(now + 3);
    assert.ok(removed.includes(second));
    assert.equal((await job.get()).exists, false);

    await job.set({ paths: [first, second], createdAt: now + 4 });
    const retry = createGenerationStore(db, { remove: async path => { if (path === second) throw Error('Storage is unavailable'); } });
    await retry.cleanup(now + 5);
    assert.equal((await job.get()).exists, true);
    await cleanup.cleanup(now + 1005);
    assert.equal((await job.get()).exists, false);
  });
});

test('cleanup revisits known abandoned imports after their upload deadline without deleting the delivered source', emulatorOnly, async () => {
  await withStore(async ({ uid, db, intake }) => {
    const id = randomUUID();
    const project = await intake.create({ uid, id, key: randomUUID(), input: { fileId: 'video-id' }, source: { fileId: 'video-id', name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true }, now });
    const old = (await intake.claim('old-worker', now, 1000))!;
    const claim = (await intake.claim('replacement-worker', now + 1001, 1000))!;
    const obsolete = sourcePath(uid, id, old.attempt), delivered = sourcePath(uid, id, claim.attempt);
    assert.equal(await intake.complete(claim, { bytes: 9, durationSeconds: 60, storagePath: delivered }, now + 1002), true);
    const job = db.collection('assetCleanup').doc(`${id}-source-unused`);
    assert.ok((await job.get()).data()!.paths.includes(obsolete));
    assert.ok(!(await job.get()).data()!.paths.includes(delivered));
    const files = new Set([obsolete, delivered]);
    const cleanup = createGenerationStore(db, { remove: async path => { files.delete(path); } });
    await cleanup.cleanup(now + 1003);
    assert.deepEqual(files, new Set([delivered]));
    files.add(obsolete);
    await cleanup.cleanup(now + 1004);
    assert.ok(files.has(obsolete));
    for (let pass = 0; pass < 3; pass++) await cleanup.cleanup(project.deadline + 15_000);
    assert.deepEqual(files, new Set([delivered]));
    assert.equal((await job.get()).exists, false);
  });
});

for (const invalidRetention of [false, true]) {
  test(`restoration cannot resurrect a legacy transcript after batch replacement or ASR failure${invalidRetention ? ' with invalid retention' : ''}`, emulatorOnly, async () => {
    await withStore(async ({ uid, db, intake, store, readySource }) => {
      const id = await readySource();
      const ref = db.collection('accounts').doc(uid).collection('projects').doc(id);
      const priorCreatedAt = now - 31 * 86_400_000;
      const oldTranscript = { ...transcript, ...(invalidRetention ? { retention: { version: 999, kind: 'trial', startsAt: now } } : {}) };
      await ref.collection('transcripts').doc('shared').set(oldTranscript);
      await ref.collection('generation').doc('batch').set({ id: 'old-batch', keyHash: 'old-request', fingerprint: 'old-fingerprint', uid, projectId: id, status: 'failed', slots: [], createdAt: priorCreatedAt, updatedAt: priorCreatedAt, deadline: priorCreatedAt + 1000, transcriptReady: true, transcriptionAttempts: 1 });
      await ref.update({ sourceExpiresAt: now + 2 });
      assert.equal(await store.transcript(uid, id, now + 3), null);
      const expired = (await intake.get(uid, id))!;
      await intake.retry({ intent: 'source_restore', uid, id, key: 'restore-legacy-cache', source: expired.source, attempts: expired.attempts, updatedAt: expired.updatedAt, now: now + 3 });
      const restore = (await intake.claim('restore-worker', now + 4, 1000))!;
      await intake.complete(restore, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, id, restore.attempt), sourceSha256: 'a'.repeat(64) }, now + 5);
      const first = await store.start(uid, id, 'first-after-restore', { x_posts: 1, linkedin_posts: 0 }, now + 6);
      assert.equal(first.transcriptReady, false);
      assert.equal(await store.transcript(uid, id, now + 7), null);
      const saved = (await ref.collection('transcripts').doc('shared').get()).data()!;
      if (invalidRetention) assert.deepEqual(saved, oldTranscript);
      else assert.equal(saved.expiresAt, priorCreatedAt + 30 * 86_400_000);
      const asr = (await store.claim('asr-worker', now + 7, 1000))!;
      assert.equal(asr.stage, 'transcribe');
      await store.fail(asr, { code: 'transcription_failed', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, now + 8);
      assert.equal(await store.transcript(uid, id, now + 9), null);
      const next = await store.start(uid, id, 'second-after-asr-failure', { x_posts: 1, linkedin_posts: 0 }, now + 9);
      assert.equal(next.transcriptReady, false);
      assert.equal((await store.claim('next-asr-worker', now + 10, 1000))!.stage, 'transcribe');
    });
  });
}

test('durable length correction marker stops retries and expired lease recovery without extra credits', emulatorOnly, async () => {
  for (const crash of [true, false]) await withStore(async ({ uid, db, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, `correction-${crash}`, { x_posts: 1, linkedin_posts: 0 }, now + 2);
    await store.saveTranscript((await store.claim('correction', now + 3, 1000))!, result(transcript), now + 4);
    const claim = (await store.claim('correction', now + 5, 1000))!;
    const usage = { ...unknownUsage(), inputTokens: 100, outputTokens: 20, nonCachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    usage.textCalls = [{ purpose: 'create', model: 'fixture', promptVersion: 'fixture', elapsedMilliseconds: 1, usage: { ...usage } }];
    const metadata = { provider: 'anthropic', model: 'fixture', rates: null, promptVersion: 'fixture', lengthCorrection: { usage } };
    assert.equal(await store.markProviderInvoked(claim, metadata, now + 6), true);
    assert.equal(await store.markProviderInvoked(claim, metadata, now + 7), false);
    if (!crash) await store.fail(claim, { ...metadata, code: 'text_generation_failed', retryable: true, usage }, now + 8);
    assert.equal(await store.claim('recovery', now + 2000, 1000), null);
    const batch = (await store.batch(uid, id))!;
    assert.equal(batch.slots[0]!.status, 'failed');
    assert.equal(batch.slots[0]!.attempts, 1);
    assert.equal(batch.slots[0]!.lengthCorrectionStarted, true);
    const events = await db.collection('accounts').doc(uid).collection('usageEvents').where('outputId', '==', claim.slot!.id).get();
    assert.equal(events.size, 1);
    assert.equal(events.docs[0]!.data().units.textCalls[0].usage.inputTokens, 100);
    if (crash) {
      assert.equal(events.docs[0]!.data().units.inputTokens, null);
      assert.equal(events.docs[0]!.data().cost.status, 'unknown');
    }
    const ledger = await intake.usage(uid, now + 2000) as any;
    assert.equal(ledger.reserved.x_posts, 0);
    assert.equal(ledger.consumed.x_posts, 0);
  });
});

test('corrected output settles the original reservation once', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'correction-success', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    await store.saveTranscript((await store.claim('correction', now + 3, 1000))!, result(transcript), now + 4);
    const claim = (await store.claim('correction', now + 5, 1000))!;
    assert.equal(await store.markProviderInvoked(claim, { provider: 'anthropic', model: 'fixture', rates: null, lengthCorrection: { usage: unknownUsage() } }, now + 6), true);
    assert.equal(await store.saveOutput(claim, result('A corrected supported post.'), now + 7), true);
    assert.equal(await store.saveOutput(claim, result('A corrected supported post.'), now + 8), false);
    const ledger = await intake.usage(uid, now + 9) as any;
    assert.equal(ledger.reserved.x_posts, 0);
    assert.equal(ledger.consumed.x_posts, 1);
  });
});

test('pre-dispatch shutdown releases preserve reservations and monotonic attempts across stages', emulatorOnly, async () => {
  await withStore(async ({ uid, store, intake, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'shutdown-budget', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const before = await intake.usage(uid, now + 2);
    let clock = now + 3;
    for (const stage of ['transcribe', 'generate']) {
      let previous;
      for (let ordinal = 1; ordinal <= 5; ordinal++) {
        const claim = (await store.claim('worker', clock++, 1000))!;
        assert.ok(claim);
        assert.equal(claim.stage, stage);
        assert.equal(claim.attempt, ordinal);
        const failure = { code: 'worker_shutdown', retryable: true, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null };
        if (previous) assert.equal(await store.fail(previous, failure, clock++), false);
        assert.equal(await store.fail(claim, failure, clock++), true);
        previous = claim;
      }
      const resumed = (await store.claim('replacement', clock++, 1000))!;
      assert.equal(resumed.attempt, 6);
      assert.deepEqual((await intake.usage(uid, clock)).reserved, before.reserved);
      if (stage === 'transcribe') assert.equal(await store.saveTranscript(resumed, result(transcript, 'deepgram'), clock++), true);
      else assert.equal(await store.saveOutput(resumed, result('A practical idea from the video.'), clock++), true);
    }
    assert.equal((await store.batch(uid, id))!.status, 'completed');
  });
});

for (const lateFailure of [false, true]) test(`proven pre-dispatch lease crashes preserve generation retry budget and unique attempt IDs (late failure: ${lateFailure})`, emulatorOnly, async () => {
  await withStore(async ({ uid, store, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'crash-budget', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    let clock = now + 3;
    for (const stage of ['transcribe', 'generate']) {
      let claim: Awaited<ReturnType<typeof store.claim>> = null;
      const failure = { code: 'worker_shutdown', retryable: true, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null };
      for (let ordinal = 1; ordinal <= 5; ordinal++) {
        const previous: Awaited<ReturnType<typeof store.claim>> = claim;
        claim = (await store.claim('crashed-worker', clock, 1000))!;
        assert.ok(claim);
        assert.equal(claim.stage, stage);
        assert.equal(claim.attempt, ordinal);
        if (lateFailure && previous) {
          const beforeStale = await store.batch(uid, id);
          assert.equal(await store.fail(previous, failure, clock), false);
          assert.deepEqual(await store.batch(uid, id), beforeStale);
          assert.equal(await store.renew(claim, clock, 1000), true);
        }
        if (ordinal < 5) {
          clock += 1001;
          if (lateFailure) assert.equal(await store.fail(claim, failure, clock), false);
        }
      }
      if (stage === 'transcribe') assert.equal(await store.saveTranscript(claim!, result(transcript, 'deepgram'), ++clock), true);
      else assert.equal(await store.saveOutput(claim!, result('A practical idea from the video.'), ++clock), true);
    }
    assert.equal((await store.batch(uid, id))!.status, 'completed');
  });
});

test('legacy lease crashes without dispatch evidence retain the bounded retry budget', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    const batch = await store.start(uid, id, 'legacy-crash-budget', { x_posts: 1, linkedin_posts: 0 }, now + 2);
    const events = db.collection('accounts').doc(uid).collection('usageEvents');
    let clock = now + 3;
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      assert.ok(await store.claim('legacy-worker', clock, 1000));
      const matching = await events.where('batchId', '==', batch.id).where('attempt', '==', ordinal).get();
      assert.equal(matching.size, 1);
      const { providerInvoked: _proof, ...legacyEvent } = matching.docs[0]!.data();
      await matching.docs[0]!.ref.set(legacyEvent);
      clock += 1001;
    }
    assert.equal(await store.claim('last-worker', clock, 1000), null);
    assert.equal((await store.batch(uid, id))!.status, 'failed');
  });
});

test('settlement reads each original allowance ledger once per transaction', emulatorOnly, async () => {
  await withStore(async ({ uid, db, store, readySource }) => {
    const id = await readySource();
    await store.start(uid, id, 'ledger-read-count', { x_posts: 2, linkedin_posts: 0 }, now + 2);
    const original = db.runTransaction.bind(db);
    let reads: string[] = [];
    db.runTransaction = ((callback: any, options: any) => original(async transaction => {
      const get = transaction.get.bind(transaction);
      transaction.get = ((ref: any) => {
        if (ref.path?.includes('/allowances/')) reads.push(ref.path);
        return get(ref);
      }) as typeof transaction.get;
      return callback(transaction);
    }, options)) as typeof db.runTransaction;
    const measured = async (action: () => Promise<unknown>) => {
      reads = [];
      const value = await action();
      assert.equal(reads.length, 1);
      assert.equal(new Set(reads).size, 1);
      return value;
    };
    try {
      const transcription = (await store.claim('read-counter', now + 3, 1000))!;
      assert.equal(await measured(() => store.saveTranscript(transcription, result(transcript), now + 4)), true);
      const delivered = (await store.claim('read-counter', now + 5, 1000))!;
      assert.equal(await measured(() => store.saveOutput(delivered, result('A measured valid output.'), now + 6)), true);
      assert.equal(await measured(() => store.saveOutput(delivered, result('A stale valid output.'), now + 6)), false);
      const failed = (await store.claim('read-counter', now + 7, 1000))!;
      assert.equal(await measured(() => store.fail(failed, { code: 'fixture_failure', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, now + 8)), true);
      const ledger = (await db.doc(reads[0]!).get()).data()!;
      assert.equal(ledger.consumed.x_posts, 1);
      assert.equal(ledger.reserved.x_posts, 0);
      assert.equal(ledger.consumed.sourceSeconds, 60);
      // A fresh transcript-only retry still validates and settles its original ledger once.
      const retryId = await readySource();
      await store.start(uid, retryId, 'ledger-transcript-first', { x_posts: 1, linkedin_posts: 0 }, now + 9);
      const failedTranscript = (await store.claim('read-counter', now + 10, 1000))!;
      await store.fail(failedTranscript, { code: 'transcription_configuration_failed', retryable: false, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null }, now + 11);
      await store.start(uid, retryId, 'ledger-transcript-retry', { x_posts: 0, linkedin_posts: 0 }, now + 12, undefined, 'transcription_retry');
      const retry = (await store.claim('read-counter', now + 13, 1000))!;
      assert.equal(await measured(() => store.saveTranscript(retry, result(transcript), now + 14)), true);
    } finally { db.runTransaction = original; }
  });
});

test('availability reads shared funding ledgers once and retains legacy validation', emulatorOnly, async () => {
  const { planGrant } = await import('../../src/access/plans.js');
  const { emptyCounters } = await import('../../src/access/accounting.js');
  const { grantPeriod } = await import('../../src/access/accepted-work.js');
  await withStore(async ({ uid, db, store, grant, readySource }) => {
    const id = await readySource();
    const trial = planGrant('lower', 'trial-read-count', grant.startsAt, grant.expiresAt);
    const paid = planGrant('higher', 'paid-read-count', grant.startsAt, grant.expiresAt);
    const lifecycle = { kind: 'lifecycle', version: 1, revision: 2, withdrawn: false, trial, paid: { plan: 'higher', grant: paid, cancelAtPeriodEnd: false, nextPlan: null } };
    const original = db.getAll.bind(db);
    let reads: string[] = [];
    db.getAll = ((...refs: any[]) => {
      for (const ref of refs) if (ref.path?.includes('/allowances/')) reads.push(ref.path);
      return original(...refs);
    }) as typeof db.getAll;
    try {
      for (const [access, expected] of [[grant, 1], [trial, 1], [paid, 1], [lifecycle, 2], [{ ...paid, expiresAt: new Date(now).toISOString() }, 0]] as const) {
        await db.collection('subscriptionGrants').doc(uid).set(access);
        reads = [];
        const availability = await store.availability!(uid, id, now + 2);
        assert.equal(reads.length, expected);
        assert.equal(new Set(reads).size, expected);
        assert.equal(availability.outputs.x_posts.available, expected > 0);
      }
      for (const access of [grant, paid]) {
        await db.collection('subscriptionGrants').doc(uid).set(access);
        const counters = emptyCounters();
        counters.reserved.sourceSeconds = -1;
        await db.collection('accounts').doc(uid).collection('allowances').doc(grantPeriod(access as any)).set(counters);
        await assert.rejects(store.availability!(uid, id, now + 2), /Invalid allowance counters/);
      }
    } finally { db.getAll = original; }
  });
});
