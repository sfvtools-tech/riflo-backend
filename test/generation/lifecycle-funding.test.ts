import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { emptyCounters } from '../../src/access/accounting.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { unknownUsage, type AttemptResult, type GenerationClaim } from '../../src/generation/service.js';
import { assetPath } from '../../src/generation/asset-paths.js';
import { resolveGenerationControls } from '../../src/generation/controls.js';
import { validateXThread } from '../../src/generation/validation.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-29T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const result = <T>(value: T): AttemptResult<T> => ({ value, usage: unknownUsage(), provider: 'fixture', model: 'fixture', promptVersion: 'fixture', rates: null });
const carouselResult = (claim: GenerationClaim) => ({
  ...result({ status: 'ok' as const, slides: Array.from({ length: 5 }, (_, index) => ({ title: `Source idea ${index + 1}`, body: 'A useful explanation grounded in the source.' })) }),
  assets: Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(claim.project.uid, claim.project.id, claim.slot!.id, claim.attempt, index + 1), contentType: 'image/png' as const, bytes: 10, width: 1080, height: 1080 })),
});

test('threads reserve N across original owners, settle actual M after expiry, replay once and reject whole duplicates across numbering', local, async () => {
  await withAccount(async ({ uid, generations, account, ref, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 2, 18000, 30);
    await ref.update({ 'trial.startsAt': iso(now - 7 * 86_400_000 + 7), 'trial.expiresAt': iso(now + 7) });
    const id = await ready();
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const settings = { mode: 'thread' as const, maxPosts: 10, numbering: 'include' as const };
    const request = { formats: { x_posts: settings } };
    const context = { request, snapshot: resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} }) };
    const batch = await generations.start(uid, id, 'thread_split_first', selection, now + 4, undefined, undefined, context);
    assert.equal(batch.slots[0]!.charge!.credits, 10);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 2);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 8);
    const transcribe = (await generations.claim('transcriber', now + 5, 1000))!;
    await generations.saveTranscript(transcribe, result({ text: 'A practical source idea.', words: [{ text: 'Idea.', start: 0, end: 5 }] }), now + 6);
    const posts = Array.from({ length: 6 }, (_, index) => `Supported point ${index + 1}.`);
    const historical = account.collection('projects').doc(id).collection('outputs').doc('historical-single');
    await historical.set({ id: 'historical-single', feature: 'x_posts', text: posts[0], createdAt: now, expiresAt: now + 1000, model: 'fixture', promptVersion: 'fixture' });
    const claim = (await generations.claim('thread-worker', now + 7, 1000))!;
    const output = { ...result(validateXThread({ status: 'ok', posts }, settings).content), usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20 } };
    assert.equal(await generations.saveOutput(claim, output, now + 8), true);
    assert.equal(await generations.saveOutput(claim, output, now + 9), false);
    assert.equal((await trialRef.get()).data()!.consumed.creationCredits, 15);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 94);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    const completed = (await generations.batch(uid, id))!;
    assert.equal(completed.slots[0]!.charge!.credits, 10);
    assert.deepEqual(completed.slots[0]!.charge!.allocations, batch.slots[0]!.charge!.allocations);
    assert.equal(completed.slots[0]!.deliveredCredits, 6);
    assert.equal(completed.slots[0]!.deliveredPosts, 6);
    assert.equal((await generations.start(uid, id, 'thread_split_first', selection, now + 10, undefined, undefined, context)).id, batch.id);
    const stored = (await generations.output(uid, id, batch.slots[0]!.id, now + 10))!;
    assert.equal(stored.text.split('\n\n').length, 6);
    assert.match(stored.text, /^1\/6 Supported point 1/);
    assert.equal(stored.credits, 6);
    const without = { ...settings, numbering: 'exclude' as const };
    const secondRequest = { formats: { x_posts: without } };
    const secondContext = { request: secondRequest, snapshot: resolveGenerationControls(secondRequest, selection, { status: 'resolved', defaults: {} }) };
    await generations.start(uid, id, 'thread_split_duplicate', selection, now + 11, undefined, undefined, secondContext);
    const duplicateClaim = (await generations.claim('thread-worker', now + 12, 1000))!;
    assert.equal(await generations.saveOutput(duplicateClaim, { ...output, value: validateXThread({ status: 'ok', posts }, without).content }, now + 13), false);
    assert.equal((await generations.batch(uid, id))!.slots[0]!.errorCode, 'duplicate_generated_output');
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 94);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    const events = (await account.collection('usageEvents').get()).docs.map(doc => doc.data());
    assert.equal(events.filter(event => event.stage === 'generate' && event.status === 'succeeded').length, 1);
    assert.ok(events.some(event => event.errorCode === 'duplicate_generated_output' && event.units.inputTokens === 100));
    const replay = await generations.lookup!(uid, id, 'thread_split_first', selection, undefined, undefined, request);
    assert.equal(replay!.slots[0]!.deliveredCredits, 6);
    await generations.start(uid, id, 'thread_reuses_member', selection, now + 14, undefined, undefined, secondContext);
    const reusedClaim = (await generations.claim('thread-worker', now + 15, 1000))!;
    assert.equal(await generations.saveOutput(reusedClaim, result(validateXThread({ status: 'ok', posts: [posts[0]!, 'A different supported next point.'] }, without).content), now + 16), true);
    assert.equal((await generations.batch(uid, id))!.slots[0]!.deliveredPosts, 2);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 96);
  });
});

test('thread affordability uses maximum N and technical failure releases N without charging surviving posts', local, async () => {
  await withAccount(async ({ uid, generations, account, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 2, 18000, 7);
    const id = await ready();
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const settings = { mode: 'thread' as const, maxPosts: 10, numbering: 'exclude' as const };
    const request = { formats: { x_posts: settings } };
    const context = { request, snapshot: resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} }) };
    await assert.rejects(generations.start(uid, id, 'thread_unaffordable', selection, now + 4, undefined, undefined, context), { code: 'allowance_exceeded' });
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    const smaller = { formats: { x_posts: { ...settings, maxPosts: 8 } } };
    const smallerContext = { request: smaller, snapshot: resolveGenerationControls(smaller, selection, { status: 'resolved', defaults: {} }) };
    await assert.rejects(generations.start(uid, id, 'two_threads_unaffordable', { ...selection, x_posts: 2 }, now + 4, undefined, undefined, smallerContext), { code: 'allowance_exceeded' });
    await generations.start(uid, id, 'thread_failure', selection, now + 4, undefined, undefined, smallerContext);
    const transcribe = (await generations.claim('transcriber', now + 5, 1000))!;
    await generations.saveTranscript(transcribe, result({ text: 'A practical source idea.', words: [{ text: 'Idea.', start: 0, end: 5 }] }), now + 6);
    const claim = (await generations.claim('thread-worker', now + 7, 1000))!;
    await assert.rejects(generations.saveOutput(claim, result({ status: 'ok' as const, kind: 'thread' as const, posts: ['A surviving post.', ''], numbering: 'exclude' as const }), now + 8), { code: 'invalid_generated_output' });
    await generations.fail(claim, { code: 'invalid_generated_output', retryable: false, usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20 }, provider: 'fixture', model: 'fixture', rates: null }, now + 9);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await trialRef.get()).data()!.consumed.creationCredits, 13);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 113);
    assert.equal((await generations.outputs(uid, id, now + 10)).length, 0);
    assert.ok((await account.collection('usageEvents').get()).docs.some(doc => doc.data().errorCode === 'invalid_generated_output' && doc.data().units.outputTokens === 20));
  });
});

test('accepted threads settle only original funding after renewal, and pending deletion releases the entire maximum', local, async () => {
  await withAccount(async ({ uid, generations, imports, lifecycle, ref, account, trialRef, paidRef, seedRemainders, ready, setNow }) => {
    await seedRemainders(2700, 2, 18000, 30);
    await ref.update({ 'paid.grant.expiresAt': iso(now + 10) });
    const id = await ready();
    const selection = { x_posts: 1, linkedin_posts: 0 };
    const settings = { mode: 'thread' as const, maxPosts: 10, numbering: 'exclude' as const };
    const request = { formats: { x_posts: settings } };
    const context = { request, snapshot: resolveGenerationControls(request, selection, { status: 'resolved', defaults: {} }) };
    await generations.start(uid, id, 'thread_before_renewal', selection, now + 4, undefined, undefined, context);
    const transcribe = (await generations.claim('transcriber', now + 5, 1000))!;
    await generations.saveTranscript(transcribe, result({ text: 'A practical source idea.', words: [{ text: 'Idea.', start: 0, end: 5 }] }), now + 6);
    const current = (await ref.get()).data()!;
    setNow(now + 10);
    await lifecycle.transition(uid, 'renew_thread_0001', { type: 'renew', expectedRevision: current.revision, plan: 'higher', periodId: 'paid_period_0002', startsAt: iso(now + 10), expiresAt: iso(now + 31 * 86_400_000) });
    const claim = (await generations.claim('thread-worker', now + 11, 1000))!;
    assert.ok(claim);
    assert.equal(await generations.saveOutput(claim, result(validateXThread({ status: 'ok', posts: ['One.', 'Two.', 'Three.'] }, settings).content), now + 12), true);
    assert.equal((await trialRef.get()).data()!.consumed.creationCredits, 15);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 91);
    const renewed = account.collection('allowances').doc('shared-paid_period_0002');
    const fresh = (await renewed.get()).data();
    assert.ok(!fresh || fresh.consumed.creationCredits === 0 && fresh.reserved.creationCredits === 0);
    await generations.start(uid, id, 'thread_pending_delete', selection, now + 13, undefined, undefined, context);
    assert.equal((await renewed.get()).data()!.reserved.creationCredits, 10);
    await imports.remove(uid, id, now + 14);
    assert.equal((await renewed.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await renewed.get()).data()!.consumed.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 91);
  });
});

async function withAccount(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try { await run(context); }
  finally {
    for (const name of ['intakeJobs', 'generationJobs']) {
      const jobs = await context.db.collection(name).where('uid', '==', context.uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    await context.db.recursiveDelete(context.account);
    await context.db.recursiveDelete(context.ref);
    await context.db.terminate();
    await deleteApp(context.app);
  }
}

async function setup() {
  const uid = `dual-funding-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const ref = db.collection('subscriptionGrants').doc(uid);
  let clock = now;
  const setNow = (value: number) => { clock = value; };
  const lifecycle = createLifecycleStore(db, { now: () => clock });
  const trial = await lifecycle.startTrial(uid, now);
  await lifecycle.transition(uid, 'activate_paid_001', { type: 'activate_paid', expectedRevision: trial.revision, plan: 'lower', periodId: 'paid_period_0001', startsAt: iso(now), expiresAt: iso(now + 31 * 86_400_000) });
  const trialRef = account.collection('allowances').doc(`shared-${trial.trial!.allowancePeriodId}`);
  const paidRef = account.collection('allowances').doc('shared-paid_period_0001');
  const imports = createProjectStore(db);
  const generations = createGenerationStore(db);
  const create = (key: string = randomUUID(), seconds = 50) => imports.create({ uid, id: randomUUID(), key, now: now + 1, input: { fileId: 'source-file' }, source: { fileId: 'source-file', name: 'source.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: seconds, requiresProbe: true } });
  const seedRemainders = async (trialSeconds: number, trialCredits: number, paidSeconds = 18000, paidCredits = 120) => {
    const trialUsage = emptyCounters(), paidUsage = emptyCounters();
    trialUsage.consumed.sourceSeconds = 2700 - trialSeconds;
    trialUsage.consumed.creationCredits = 15 - trialCredits;
    paidUsage.consumed.sourceSeconds = 18000 - paidSeconds;
    paidUsage.consumed.creationCredits = 120 - paidCredits;
    await trialRef.set(trialUsage);
    await paidRef.set(paidUsage);
  };
  const ready = async () => {
    const project = await create(randomUUID(), 30);
    // Fixed fixture timestamps can put a second random ID behind the queue cursor.
    const claim = (await imports.claim('importer', now + 2, 1000)) ?? (await imports.claim('importer', now + 2, 1000));
    assert.ok(claim);
    assert.equal(claim.project.id, project.id);
    await imports.complete(claim, { bytes: 9, durationSeconds: 30, storagePath: `accounts/${uid}/projects/${project.id}/source/attempt-${claim.attempt}.video` }, now + 3);
    // Legacy source-only fixture retains first-generation ASR across funding transitions.
    await account.collection('projects').doc(project.id).update({ preparation: FieldValue.delete() });
    return project.id;
  };
  return { uid, app, db, account, ref, lifecycle, trialRef, paidRef, imports, generations, create, seedRemainders, ready, setNow };
}

test('split source settlement consumes measured trial seconds first and releases excess paid reservation exactly once', local, async () => {
  await withAccount(async ({ uid, imports, trialRef, paidRef, create, seedRemainders }) => {
    await seedRemainders(20, 15, 40);
    const project = await create('split_source_001');
    assert.equal((await trialRef.get()).data()!.reserved.sourceSeconds, 20);
    assert.equal((await paidRef.get()).data()!.reserved.sourceSeconds, 30);
    const replay = await create('split_source_001');
    assert.equal(replay.id, project.id);
    const claim = (await imports.claim('importer', now + 2, 1000))!;
    const completion = { bytes: 9, durationSeconds: 24.1, storagePath: `accounts/${uid}/projects/${project.id}/source/attempt-${claim.attempt}.video` };
    assert.equal(await imports.complete(claim, completion, now + 3), true);
    assert.equal(await imports.complete(claim, completion, now + 4), false);
    const trial = (await trialRef.get()).data()!, paid = (await paidRef.get()).data()!;
    assert.equal(trial.consumed.sourceSeconds, 2700);
    assert.equal(paid.consumed.sourceSeconds, 18000 - 40 + 5);
    assert.equal(trial.reserved.sourceSeconds, 0);
    assert.equal(paid.reserved.sourceSeconds, 0);
  });
});

test('concurrent split imports cannot overbook aggregate funding and rejection changes no counters', local, async () => {
  await withAccount(async ({ trialRef, paidRef, create, seedRemainders }) => {
    await seedRemainders(20, 15, 40);
    const outcomes = await Promise.allSettled([create('concurrent_split_01'), create('concurrent_split_02')]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    const rejected = outcomes.filter(value => value.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason.code, 'allowance_exceeded');
    assert.equal((await trialRef.get()).data()!.reserved.sourceSeconds, 20);
    assert.equal((await paidRef.get()).data()!.reserved.sourceSeconds, 30);
  });
});

test('actual source growth cannot borrow from renewal and failed imports release both original owners', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, account, imports, trialRef, paidRef, create, seedRemainders, setNow }) => {
    await seedRemainders(20, 15, 40);
    const project = await create();
    const claim = (await imports.claim('importer', now + 2, 1000))!;
    const current = (await ref.get()).data()!;
    setNow(Date.parse(current.paid.grant.expiresAt));
    await lifecycle.transition(uid, 'renew_source_0001', { type: 'renew', expectedRevision: current.revision, plan: 'higher', periodId: 'paid_period_0002', startsAt: current.paid.grant.expiresAt, expiresAt: iso(now + 62 * 86_400_000) });
    await assert.rejects(imports.complete(claim, { bytes: 9, durationSeconds: 61, storagePath: `accounts/${uid}/projects/${project.id}/source/attempt-${claim.attempt}.video` }, now + 3), { code: 'allowance_exceeded' });
    assert.equal(await imports.fail(claim, { code: 'source_too_long', retryable: false, bytes: 9 }, now + 4), true);
    assert.equal((await trialRef.get()).data()!.reserved.sourceSeconds, 0);
    assert.equal((await paidRef.get()).data()!.reserved.sourceSeconds, 0);
    const next = (await account.collection('allowances').doc('shared-paid_period_0002').get()).data();
    assert.ok(!next || next.reserved.sourceSeconds === 0 && next.consumed.sourceSeconds === 0);
  });
});

test('split output reservations survive ordinary trial expiry and consume original owners only once', local, async () => {
  await withAccount(async ({ uid, generations, ref, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 1, 18000, 2);
    await ref.update({ 'trial.startsAt': iso(now - 7 * 86_400_000 + 7), 'trial.expiresAt': iso(now + 7) });
    const id = await ready();
    const selection = { x_posts: 0, linkedin_posts: 0, carousels: 1 };
    const batch = await generations.start(uid, id, 'split_carousel_01', selection, now + 4);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 1);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 1);
    const transcription = (await generations.claim('transcriber', now + 5, 1000))!;
    await generations.saveTranscript(transcription, result({ text: 'A practical source idea.', words: [{ text: 'A practical source idea.', start: 0, end: 5 }] }), now + 6);
    const claim = (await generations.claim('carousel', now + 7, 1000))!;
    assert.ok(claim);
    const output = carouselResult(claim);
    assert.equal(await generations.saveOutput(claim, output, now + 8), true);
    assert.equal(await generations.saveOutput(claim, output, now + 9), false);
    assert.equal((await trialRef.get()).data()!.consumed.creationCredits, 15);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 119);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await generations.start(uid, id, 'split_carousel_01', selection, now + 10)).id, batch.id);
    assert.equal((await generations.outputs(uid, id, now + 10)).length, 1);
  });
});

test('deletion releases pending funding across source and renewed batch owners without refunding delivered source', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, account, imports, generations, trialRef, paidRef, seedRemainders, ready, setNow }) => {
    await seedRemainders(20, 1, 40, 2);
    const id = await ready();
    await ref.update({ 'paid.grant.expiresAt': iso(now + 10) });
    const current = (await ref.get()).data()!;
    setNow(now + 10);
    await lifecycle.transition(uid, 'renew_deletion_01', { type: 'renew', expectedRevision: current.revision, plan: 'lower', periodId: 'paid_period_0002', startsAt: iso(now + 10), expiresAt: iso(now + 31 * 86_400_000) });
    await generations.start(uid, id, 'delete_split_batch', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 11);
    const nextRef = account.collection('allowances').doc('shared-paid_period_0002');
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 1);
    assert.equal((await nextRef.get()).data()!.reserved.creationCredits, 1);
    const sourceBefore = (await paidRef.get()).data()!;
    await imports.remove(uid, id, now + 12);
    await imports.remove(uid, id, now + 13);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await nextRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await nextRef.get()).data()!.consumed.creationCredits, 0);
    assert.deepEqual((await paidRef.get()).data(), sourceBefore);
    assert.equal((await trialRef.get()).data()!.consumed.sourceSeconds, 2700);
    assert.equal(await generations.claim('deleted-work', now + 14, 1000), null);
  });
});

test('explicit withdrawal rejects pending split output and releases both owners once', local, async () => {
  await withAccount(async ({ uid, lifecycle, ref, generations, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 1, 18000, 2);
    const id = await ready();
    await generations.start(uid, id, 'withdraw_split_01', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 4);
    const current = (await ref.get()).data()!;
    await lifecycle.transition(uid, 'withdraw_access_01', { type: 'withdraw', expectedRevision: current.revision });
    assert.equal(await generations.claim('withdrawn-worker', now + 5, 1000), null);
    assert.equal(await generations.claim('withdrawn-worker', now + 6, 1000), null);
    assert.equal((await trialRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await trialRef.get()).data()!.consumed.creationCredits, 14);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 118);
    assert.deepEqual(await generations.outputs(uid, id, now + 6), []);
  });
});

test('split source retry and lease recovery retain both owners and reject every stale settlement', local, async () => {
  await withAccount(async ({ uid, imports, trialRef, paidRef, create, seedRemainders }) => {
    await seedRemainders(20, 15, 40);
    const project = await create();
    const first = (await imports.claim('first-importer', now + 2, 1000))!;
    assert.ok(first);
    assert.equal(await imports.fail(first, { code: 'source_unavailable', retryable: true, bytes: 3 }, now + 3), true);
    const before = [(await trialRef.get()).data(), (await paidRef.get()).data()];
    assert.deepEqual(before.map(value => value!.reserved.sourceSeconds), [20, 30]);
    const retry = (await imports.claim('retry-importer', now + 2004, 1000))!;
    assert.ok(retry);
    const recovered = (await imports.claim('recovered-importer', now + 3005, 1000))!;
    assert.ok(recovered);
    const completion = { bytes: 9, durationSeconds: 6.1, storagePath: `accounts/${uid}/projects/${project.id}/source/attempt-${recovered.attempt}.video` };
    for (const stale of [first, retry]) {
      assert.equal(await imports.complete(stale, completion, now + 3006), false);
      assert.equal(await imports.fail(stale, { code: 'late_failure', retryable: false, bytes: 3 }, now + 3006), false);
    }
    assert.deepEqual([(await trialRef.get()).data(), (await paidRef.get()).data()], before);
    assert.equal(await imports.complete(recovered, completion, now + 3007), true);
    assert.equal((await trialRef.get()).data()!.consumed.sourceSeconds, 2687);
    assert.equal((await paidRef.get()).data()!.consumed.sourceSeconds, 17960);
    assert.deepEqual([(await trialRef.get()).data()!.reserved.sourceSeconds, (await paidRef.get()).data()!.reserved.sourceSeconds], [0, 0]);
  });
});

test('racing terminal import failure and deletion releases split funds without touching another reservation', local, async () => {
  await withAccount(async ({ imports, trialRef, paidRef, create, seedRemainders, uid }) => {
    await seedRemainders(20, 15, 40);
    const project = await create();
    const claim = (await imports.claim('importer', now + 2, 1000))!;
    assert.equal(claim.project.id, project.id);
    const waiting = await create('other_source_reservation', 10);
    await Promise.all([
      imports.fail(claim, { code: 'invalid_video', retryable: false, bytes: 9 }, now + 3),
      imports.remove(uid, project.id, now + 3),
    ]);
    assert.equal((await trialRef.get()).data()!.reserved.sourceSeconds, 0);
    assert.equal((await paidRef.get()).data()!.reserved.sourceSeconds, 10);
    assert.equal((await trialRef.get()).data()!.consumed.sourceSeconds, 2680);
    assert.equal((await paidRef.get()).data()!.consumed.sourceSeconds, 17960);
    assert.equal(await imports.complete(claim, { bytes: 9, durationSeconds: 50, storagePath: 'fixture/stale' }, now + 4), false);
    await imports.remove(uid, waiting.id, now + 5);
    assert.equal((await paidRef.get()).data()!.reserved.sourceSeconds, 0);
  });
});

test('reclaimed split generation ignores stale success and failure then settles its replacement exactly once', local, async () => {
  await withAccount(async ({ uid, account, generations, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 1, 18000, 2);
    const id = await ready();
    await generations.start(uid, id, 'lease_split_generation', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 4);
    const transcription = (await generations.claim('transcriber', now + 5, 1000))!;
    assert.equal(await generations.saveTranscript(transcription, result({ text: 'A useful source idea.', words: [{ text: 'A useful source idea.', start: 0, end: 5 }] }), now + 6), true);
    const original = (await generations.claim('original-renderer', now + 7, 1000))!;
    assert.equal(original.project.id, id);
    assert.equal(original.slot!.feature, 'carousels');
    const replacement = (await generations.claim('replacement-renderer', now + 1008, 1000))!;
    assert.ok(replacement);
    assert.equal(replacement.slot!.id, original.slot!.id);
    assert.equal(replacement.attempt, original.attempt + 1);
    const before = [(await trialRef.get()).data(), (await paidRef.get()).data()];
    assert.equal(await generations.saveOutput(original, carouselResult(original), now + 1009), false);
    assert.equal(await generations.fail(original, { ...result(null), code: 'late_render_failure', retryable: false }, now + 1010), false);
    assert.deepEqual([(await trialRef.get()).data(), (await paidRef.get()).data()], before);
    assert.deepEqual(await generations.outputs(uid, id, now + 1010), []);
    assert.equal(await generations.saveOutput(replacement, carouselResult(replacement), now + 1011), true);
    assert.equal(await generations.saveOutput(replacement, carouselResult(replacement), now + 1012), false);
    assert.deepEqual([(await trialRef.get()).data()!.reserved.creationCredits, (await paidRef.get()).data()!.reserved.creationCredits], [0, 0]);
    assert.deepEqual([(await trialRef.get()).data()!.consumed.creationCredits, (await paidRef.get()).data()!.consumed.creationCredits], [15, 119]);
    assert.equal((await generations.outputs(uid, id, now + 1012)).length, 1);
    assert.equal((await generations.batch(uid, id))!.status, 'completed');
    assert.deepEqual((await account.collection('processing').doc('current').get()).data(), { active: null, queued: 0 });
    assert.equal(await generations.claim('finished-renderer', now + 1013, 1000), null);
  });
});

test('partial split generation preserves delivered charges and another project reservation through terminal failure', local, async () => {
  await withAccount(async ({ uid, account, generations, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 1, 18000, 5);
    const first = await ready(), waiting = await ready();
    await generations.start(uid, first, 'partial_split_generation', { carousels: 1, x_posts: 1, linkedin_posts: 0 }, now + 4);
    await generations.start(uid, waiting, 'waiting_split_generation', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 5);
    const transcription = (await generations.claim('transcriber', now + 6, 1000))!;
    assert.equal(transcription.project.id, first);
    assert.equal(await generations.saveTranscript(transcription, result({ text: 'A useful source idea.', words: [{ text: 'A useful source idea.', start: 0, end: 5 }] }), now + 7), true);
    const delivered = (await generations.claim('renderer', now + 8, 1000))!;
    assert.equal(delivered.slot!.feature, 'carousels');
    assert.equal(await generations.saveOutput(delivered, carouselResult(delivered), now + 9), true);
    const failed = (await generations.claim('writer', now + 10, 1000))!;
    assert.equal(failed.slot!.feature, 'x_posts');
    assert.equal(await generations.fail(failed, { ...result(null), code: 'invalid_generated_output', retryable: false }, now + 11), true);
    assert.equal(await generations.fail(failed, { ...result(null), code: 'invalid_generated_output', retryable: false }, now + 12), false);
    assert.deepEqual([(await trialRef.get()).data()!.reserved.creationCredits, (await paidRef.get()).data()!.reserved.creationCredits], [0, 2]);
    assert.deepEqual([(await trialRef.get()).data()!.consumed.creationCredits, (await paidRef.get()).data()!.consumed.creationCredits], [15, 116]);
    assert.equal((await generations.batch(uid, first))!.status, 'partial');
    assert.equal((await generations.outputs(uid, first, now + 12)).length, 1);
    // A busy account's earlier job is reached when the bounded scan wraps.
    const next = (await generations.claim('waiting-transcriber', now + 13, 1000)) ?? (await generations.claim('waiting-transcriber', now + 13, 1000));
    assert.ok(next);
    assert.equal(next.project.id, waiting);
    assert.equal(await generations.fail(next, { ...result(null), code: 'transcription_failed', retryable: false }, now + 14), true);
    assert.equal((await paidRef.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await paidRef.get()).data()!.consumed.creationCredits, 116);
    assert.deepEqual((await account.collection('processing').doc('current').get()).data(), { active: null, queued: 0 });
  });
});

test('racing generation admissions cannot spend the same combined trial and paid credits', local, async () => {
  await withAccount(async ({ uid, account, generations, trialRef, paidRef, seedRemainders, ready }) => {
    await seedRemainders(2700, 1, 18000, 2);
    const ids = [await ready(), await ready()];
    const before = [(await trialRef.get()).data()!, (await paidRef.get()).data()!];
    const outcomes = await Promise.allSettled(ids.map((id, index) => generations.start(uid, id, `competing_generation_${index}`, { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 4)));
    const accepted = outcomes.filter(value => value.status === 'fulfilled');
    const rejected = outcomes.filter(value => value.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason.code, 'allowance_exceeded');
    const after = [(await trialRef.get()).data()!, (await paidRef.get()).data()!];
    assert.deepEqual(after.map(value => value.reserved.creationCredits), [1, 1]);
    assert.deepEqual(after.map(value => value.consumed), before.map(value => value.consumed));
    assert.deepEqual(after.map(value => value.reserved.sourceSeconds), before.map(value => value.reserved.sourceSeconds));
    assert.deepEqual((await account.collection('processing').doc('current').get()).data(), { active: null, queued: 1 });
    assert.equal((await account.firestore.collection('generationJobs').where('uid', '==', uid).get()).size, 1);
    assert.equal((await generations.batch(uid, ids[outcomes.findIndex(value => value.status === 'rejected')]!)), null);
  });
});

for (const succeeds of [true, false]) {
  test(`claim releases expired split video funding before surviving text ${succeeds ? 'delivery' : 'failure'}`, local, async () => {
    await withAccount(async ({ uid, account, imports, generations, trialRef, paidRef, seedRemainders, ready }) => {
      await seedRemainders(2700, 3, 18000, 20);
      const id = await ready(), waiting = await ready();
      const project = account.collection('projects').doc(id);
      await project.update({ sourceExpiresAt: now + 10 });
      await project.collection('transcripts').doc('shared').set({ text: 'A useful source idea.', words: [{ text: 'A useful source idea.', start: 0, end: 5 }], createdAt: now + 3, expiresAt: now + 86_400_000 });
      const batch = await generations.start(uid, id, `expire_video_${succeeds}`, { x_posts: 1, linkedin_posts: 0, short_videos: 1 }, now + 4);
      const video = batch.slots.find(slot => slot.feature === 'short_videos')!;
      assert.deepEqual(video.charge!.allocations!.map(owner => owner.amount), [2, 2]);
      await generations.start(uid, waiting, 'unrelated_carousel', { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 5);
      const counts = async () => [(await trialRef.get()).data()!, (await paidRef.get()).data()!];
      const before = await counts();
      assert.deepEqual(before.map(value => value.reserved.creationCredits), [3, 4]);

      // Expiry occurs between cleanup passes; claim must persist its own release.
      const text = (await generations.claim('writer', now + 11, 1000))!;
      assert.equal(text.project.id, id);
      assert.equal(text.slot!.feature, 'x_posts');
      assert.equal((await imports.get(uid, id))!.status, 'source_ready');
      assert.equal((await generations.batch(uid, id))!.slots.find(slot => slot.id === video.id)!.errorCode, 'source_expired');
      assert.deepEqual((await counts()).map(value => value.reserved.creationCredits), [1, 2]);
      assert.deepEqual((await counts()).map(value => value.consumed), before.map(value => value.consumed));

      const failure = { ...result(null), code: 'invalid_generated_output', retryable: false };
      if (succeeds) {
        assert.equal(await generations.saveOutput(text, result('A useful post grounded in the source.'), now + 12), true);
        assert.equal(await generations.saveOutput(text, result('A useful post grounded in the source.'), now + 13), false);
      } else {
        assert.equal(await generations.fail(text, failure, now + 12), true);
        assert.equal(await generations.fail(text, failure, now + 13), false);
      }
      const after = await counts();
      assert.deepEqual(after.map(value => value.reserved.creationCredits), [0, 2]);
      assert.deepEqual(after.map(value => value.consumed.creationCredits), [12 + Number(succeeds), 100]);
      assert.deepEqual(after.map(value => value.consumed.sourceSeconds), before.map(value => value.consumed.sourceSeconds));
      assert.equal((await generations.batch(uid, id))!.status, succeeds ? 'partial' : 'failed');
      await imports.remove(uid, id, now + 14);
      await imports.remove(uid, id, now + 15);
      assert.deepEqual(await counts(), after);
      await imports.remove(uid, waiting, now + 16);
      assert.deepEqual((await counts()).map(value => value.reserved.creationCredits), [0, 0]);
    });
  });
}
