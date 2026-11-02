import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { sourcePath } from '../../src/projects/source.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { videoPath } from '../../src/generation/asset-paths.js';
import { assetPath } from '../../src/generation/asset-paths.js';
import { carouselLimits } from '../../src/generation/config.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { unknownUsage, type AttemptResult, type GeneratedOutput, type GenerationValue, type Selection, type Transcript } from '../../src/generation/service.js';

const emulatorOnly = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-29T12:00:00Z');
const transcript: Transcript = { text: 'A practical lesson. Another useful lesson.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'lesson.', start: 1, end: 10 }, { text: 'Another', start: 10, end: 11 }, { text: 'lesson.', start: 11, end: 20 }] };
const result = <T>(value: T): AttemptResult<T> => ({ value, provider: 'anthropic', model: 'fixture', promptVersion: 'fixture+history-v1', usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20, nonCachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, rates: { model: 'fixture', capturedAt: new Date(now).toISOString(), inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 10_000_000, cacheReadMicrosPerMillion: null, cacheWriteMicrosPerMillion: null, transcriptionMicrosPerMinute: null } });

async function fixture() {
  const uid = `distinctness-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grant = db.collection('subscriptionGrants').doc(uid);
  await grant.set({ status: 'active', startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, key === 'sourceSeconds' ? 600 : 30])) });
  const intake = createProjectStore(db);
  const store = createGenerationStore(db);
  let clock = now;
  const project = await intake.create({ uid, id: randomUUID(), key: randomUUID(), now: clock, input: { fileId: 'fixture' }, source: { fileId: 'fixture', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 60, requiresProbe: true } });
  const claim = await intake.claim('importer', ++clock, 1000);
  assert.ok(claim);
  await intake.complete(claim, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, claim.attempt) }, ++clock);
  const projectRef = account.collection('projects').doc(project.id);
  await projectRef.collection('transcripts').doc('shared').set({ ...transcript, createdAt: clock, expiresAt: now + 86_400_000 });
  const start = async (selection: Selection) => store.start(uid, project.id, randomUUID(), selection, ++clock);
  const next = async () => { const claim = await store.claim('worker', ++clock, 1000); assert.ok(claim); assert.equal(claim.stage, 'generate'); return claim; };
  const seed = async (value: Partial<GeneratedOutput>) => projectRef.collection('outputs').doc(value.id ?? randomUUID()).set({ id: 'saved', feature: 'x_posts', text: 'Existing lesson.', createdAt: clock, expiresAt: now + 100_000, model: 'fixture', promptVersion: 'fixture', ...value });
  return { uid, app, db, account, project, projectRef, intake, store, start, next, seed, tick: () => ++clock, clock: () => clock, async close() {
    for (const collection of ['generationJobs', 'intakeJobs']) {
      const docs = await db.collection(collection).where('uid', '==', uid).get();
      await Promise.all(docs.docs.map(document => document.ref.delete()));
    }
    const cleanup = await db.collection('assetCleanup').get();
    await Promise.all(cleanup.docs.filter(document => document.id.startsWith(project.id)).map(document => document.ref.delete()));
    await db.recursiveDelete(account);
    await grant.delete();
    await db.terminate();
    await deleteApp(app);
  } };
}
async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try { await run(value); } finally { await value.close(); }
}

test('same-batch and later-batch repeats fail without output consumption, source refunds or paid retries', emulatorOnly, async () => {
  await withFixture(async ({ uid, account, project, intake, store, start, next, tick, clock }) => {
    await start({ x_posts: 2, linkedin_posts: 0 });
    const first = await next();
    assert.equal(await store.saveOutput(first, result('One supported lesson.'), tick()), true);
    const repeated = await next();
    assert.equal(await store.saveOutput(repeated, result(' One supported lesson. '), tick()), false);
    assert.equal((await store.batch(uid, project.id))!.status, 'partial');
    assert.equal((await store.batch(uid, project.id))!.slots[1]!.errorCode, 'duplicate_generated_output');
    const usage = await intake.usage(uid, clock());
    assert.equal(usage.consumed.x_posts, 1);
    assert.equal(usage.reserved.x_posts, 0);
    assert.equal(usage.consumed.sourceSeconds, 60);
    assert.equal((await store.outputs(uid, project.id, clock())).length, 1);
    const before = (await account.collection('usageEvents').get()).docs.find(document => document.data().errorCode === 'duplicate_generated_output')!.data();
    assert.equal(before.status, 'failed');
    assert.equal(before.units.inputTokens, 100);
    assert.equal(before.cost.status, 'estimated');
    assert.equal(before.cost.amountMicros, 400);
    assert.equal(await store.saveOutput(repeated, result('One supported lesson.'), tick()), false);
    assert.equal(await store.fail(repeated, { code: 'generation_failed', retryable: true, usage: unknownUsage(), provider: 'anthropic', model: 'unknown', rates: null }, tick()), false);
    const after = (await account.collection('usageEvents').get()).docs.find(document => document.data().errorCode === 'duplicate_generated_output')!.data();
    assert.equal(after.status, 'failed');
    await start({ x_posts: 1, linkedin_posts: 0 });
    const later = await next();
    assert.equal(await store.saveOutput(later, result('One supported lesson.'), tick()), false);
    assert.equal((await store.batch(uid, project.id))!.status, 'failed');
    assert.equal(await store.claim('worker', tick(), 1000), null);
    assert.equal((await intake.usage(uid, clock())).consumed.x_posts, 1);
    assert.equal((await intake.usage(uid, clock())).consumed.sourceSeconds, 60);
  });
});

test('same words in another format or expired history do not block delivery; concurrent replay charges once', emulatorOnly, async () => {
  await withFixture(async ({ uid, project, intake, store, start, next, seed, tick, clock }) => {
    await seed({ feature: 'linkedin_posts', text: 'A clear lesson.' });
    await seed({ feature: 'x_posts', text: 'A clear lesson.', expiresAt: now });
    await start({ x_posts: 1, linkedin_posts: 0 });
    const claim = await next();
    const savedAt = tick();
    const saved = await Promise.all([store.saveOutput(claim, result('A clear lesson.'), savedAt), store.saveOutput(claim, result('A clear lesson.'), savedAt)]);
    assert.deepEqual(saved.sort(), [false, true]);
    assert.equal((await intake.usage(uid, clock())).consumed.x_posts, 1);
    assert.equal((await store.outputs(uid, project.id, clock())).filter(output => output.feature === 'x_posts').length, 1);
    await start({ x_posts: 1, linkedin_posts: 0 });
    assert.equal(await store.saveOutput(await next(), result('A clear lesson!'), tick()), true);
  });
});

test('identical final legacy clip ranges reject and durably queue rendered files without source refund', emulatorOnly, async () => {
  await withFixture(async ({ uid, db, project, intake, store, start, next, seed, tick, clock }) => {
    await seed({ feature: 'short_videos', text: 'Old clip display text', data: { status: 'ok', startSeconds: 10, endSeconds: 20 } });
    await start({ x_posts: 1, linkedin_posts: 0, short_videos: 1 });
    assert.equal(await store.saveOutput(await next(), result('One written lesson.'), tick()), true);
    const clip = await next();
    const rendered = { ...result({ status: 'ok' as const, segments: [{ startSeconds: 10, endSeconds: 20 }] }), assets: [{ id: 'clip', storagePath: videoPath(uid, project.id, clip.slot!.id, clip.attempt), contentType: 'video/mp4' as const, durationSeconds: 10, bytes: 50, width: 720, height: 1280 }] };
    assert.equal(await store.saveOutput(clip, rendered, tick()), false);
    assert.equal((await store.batch(uid, project.id))!.status, 'partial');
    assert.equal((await intake.usage(uid, clock())).consumed.short_videos, 0);
    assert.equal((await intake.usage(uid, clock())).consumed.sourceSeconds, 60);
    const pending = await db.collection('assetCleanup').get();
    assert.ok(pending.docs.some(document => document.data().paths.includes(rendered.assets[0]!.storagePath)));
    assert.equal(await store.output(uid, project.id, clip.slot!.id, clock()), null);
  });
});

test('the worker supplies delivered history to one call and does not retry a duplicate', emulatorOnly, async () => {
  await withFixture(async ({ uid, project, store, start, seed, tick, clock }) => {
    await seed({ text: 'Existing lesson.' });
    await start({ x_posts: 1, linkedin_posts: 0 });
    let calls = 0;
    const worker = createGenerationWorker({ store, now: tick, providers: {
      transcribe: async () => assert.fail('A live transcript must be reused.'),
      generate: async (_transcript, _slot, _selection, _signal, mark, options) => {
        calls++;
        assert.ok(options!.previousOutputs!.some(output => output.text === 'Existing lesson.'));
        await mark({ provider: 'anthropic', model: 'fixture', rates: result('').rates });
        return result('Existing lesson.');
      },
    } });
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(calls, 1);
    assert.equal((await store.batch(uid, project.id))!.slots[0]!.errorCode, 'duplicate_generated_output');
    assert.equal((await store.outputs(uid, project.id, clock())).length, 1);
  });
});

test('structured duplicates release only their format allowance and partial carousel cleanup is durable', emulatorOnly, async () => {
  await withFixture(async ({ uid, db, project, intake, store, start, next, seed, tick, clock }) => {
    const values = [
      { feature: 'blogs' as const, data: { status: 'ok' as const, title: 'A lesson', bodyMarkdown: 'One supported explanation.' } },
      { feature: 'newsletters' as const, data: { status: 'ok' as const, subject: 'A lesson', previewText: 'One practical point', bodyMarkdown: 'One supported explanation.' } },
      { feature: 'carousels' as const, data: { status: 'ok' as const, slides: Array.from({ length: 5 }, (_, index) => ({ title: `Point ${index + 1}`, body: 'A source-supported explanation.' })) } },
    ];
    for (const { feature, data } of values) {
      await seed({ feature, text: 'Prior structured content.', data });
      await start({ x_posts: 1, linkedin_posts: 0, [feature]: 1 });
      assert.equal(await store.saveOutput(await next(), result(`A different post for ${feature}.`), tick()), true);
      const claim = await next();
      const assets = feature === 'carousels' ? Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, project.id, claim.slot!.id, claim.attempt, index + 1), contentType: 'image/png' as const, bytes: 50, width: carouselLimits.width, height: carouselLimits.height })) : undefined;
      assert.equal(await store.saveOutput(claim, { ...result(data), ...(assets ? { assets } : {}) }, tick()), false);
      assert.equal((await intake.usage(uid, clock())).consumed[feature], 0);
      assert.equal((await intake.usage(uid, clock())).reserved[feature], 0);
    }
    await start({ x_posts: 0, linkedin_posts: 0, carousels: 1, short_videos: 1 });
    const claim = await next();
    const slides = values[2]!.data;
    const assets = Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, project.id, claim.slot!.id, claim.attempt, index + 1), contentType: 'image/png' as const, bytes: 50, width: carouselLimits.width, height: carouselLimits.height }));
    assert.equal(await store.saveOutput(claim, { ...result(slides), assets }, tick()), false);
    assert.equal((await store.batch(uid, project.id))!.slots[1]!.status, 'pending');
    const cleanup = await db.collection('assetCleanup').get();
    assert.ok(cleanup.docs.some(document => assets.every(asset => document.data().paths.includes(asset.storagePath))));
    const pending = await next();
    await store.fail(pending, { code: 'insufficient_source', retryable: false, ...result('') }, tick());
    assert.equal((await store.batch(uid, project.id))!.status, 'failed');
    assert.equal((await intake.usage(uid, clock())).consumed.sourceSeconds, 60);
  });
});
