import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys, type LegacyGrant as Grant } from '../../src/access/policy.js';
import { grantPeriod } from '../../src/access/accepted-work.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { createIntakeWorker } from '../../src/projects/worker.js';
import { sourcePath } from '../../src/projects/source.js';
import { unknownUsage, type AttemptResult, type Transcript } from '../../src/generation/service.js';

const emulatorOnly = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-18T12:00:00Z');
const transcript: Transcript = { text: 'One clear source thought.', words: [{ text: 'One', start: 0, end: 1 }, { text: 'thought.', start: 1, end: 2 }] };
const result = <T>(value: T): AttemptResult<T> => ({ value, usage: unknownUsage(), provider: 'fixture', model: 'fixture', promptVersion: 'fixture-v1', rates: null });

async function withAccount(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
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
  const uid = `accepted-work-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grantRef = db.collection('subscriptionGrants').doc(uid);
  const grant: Grant = { status: 'active', startsAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 50).toISOString(), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, key === 'sourceSeconds' ? 120 : 2])) as Grant['limits'] };
  await grantRef.set(grant);
  const imports = createProjectStore(db);
  const generations = createGenerationStore(db);
  const oldUsage = account.collection('allowances').doc(grantPeriod(grant));
  const create = () => imports.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'source-file' }, source: { fileId: 'source-file', name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true } });
  const imported = async (durationSeconds = 30) => {
    const project = await create();
    const claim = await imports.claim('import-worker', now + 1, 1000);
    assert.ok(claim);
    assert.equal(await imports.complete(claim, { bytes: 9, durationSeconds, storagePath: sourcePath(uid, project.id, claim.attempt) }, now + 2), true);
    // Legacy source-only fixture: accepted first-generation ASR remains supported.
    await account.collection('projects').doc(project.id).update({ preparation: FieldValue.delete() });
    return project.id;
  };
  const accepted = async (count = 1) => {
    const id = await imported();
    const batch = await generations.start(uid, id, 'accepted-generation-key', { x_posts: count, linkedin_posts: 0 }, now + 3);
    const claim = await generations.claim('transcription-worker', now + 4, 1000);
    assert.ok(claim);
    assert.equal(await generations.saveTranscript(claim, result(transcript), now + 5), true);
    return { id, batch };
  };
  return { uid, app, db, account, grantRef, grant, imports, generations, oldUsage, create, imported, accepted };
}

test('an accepted import can be claimed and completed after ordinary access expiry', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, imports, oldUsage, create }) => {
    const project = await create();
    const claim = await imports.claim('late-worker', now + 60, 1000);
    assert.ok(claim);
    assert.equal(await imports.renew(claim, now + 61, 1000), true);
    assert.equal(await imports.complete(claim, { bytes: 9, durationSeconds: 40, storagePath: sourcePath(uid, project.id, 1) }, now + 62), true);
    assert.equal((await imports.get(uid, project.id))!.status, 'source_ready');
    const usage = (await oldUsage.get()).data()!;
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 40);
    assert.equal((await account.collection('allowances').get()).size, 1);
    await assert.rejects(imports.create({ ...project, id: randomUUID(), key: randomUUID(), now: now + 63 }), { code: 'subscription_required' });
  });
});

test('accepted generation settles its original reservations after expiry and cannot be delivered twice', emulatorOnly, async () => {
  await withAccount(async ({ uid, generations, oldUsage, accepted }) => {
    const { id } = await accepted();
    const claim = await generations.claim('late-worker', now + 60, 1000);
    assert.ok(claim);
    assert.equal(await generations.markProviderInvoked(claim, { provider: 'fixture', model: 'fixture', rates: null }, now + 61), true);
    assert.equal(await generations.renew(claim, now + 62, 1000), true);
    assert.equal(await generations.saveOutput(claim, result('A useful post from the original source.'), now + 63), true);
    assert.equal(await generations.saveOutput(claim, result('A duplicate must not be delivered.'), now + 64), false);
    const usage = (await oldUsage.get()).data()!;
    assert.equal(usage.reserved.x_posts, 0);
    assert.equal(usage.consumed.x_posts, 1);
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 30);
    assert.equal((await generations.outputs(uid, id, now + 64)).length, 1);
    await assert.rejects(generations.start(uid, id, 'new-request-after-expiry', { x_posts: 1, linkedin_posts: 0 }, now + 65), { code: 'subscription_required' });
  });
});

test('renewal does not charge a new period or retract an already accepted format', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, grant, grantRef, generations, imports, oldUsage, accepted }) => {
    const { id } = await accepted();
    const renewed: Grant = { ...grant, startsAt: new Date(now + 50).toISOString(), expiresAt: new Date(now + 100_000).toISOString(), features: [], limits: Object.fromEntries(quotaKeys.map(key => [key, 0])) as Grant['limits'] };
    await grantRef.set(renewed);
    const newUsage = account.collection('allowances').doc(grantPeriod(renewed));
    const untouched = { reserved: Object.fromEntries(quotaKeys.map(key => [key, 0])), consumed: Object.fromEntries(quotaKeys.map(key => [key, 0])) };
    await newUsage.set(untouched);
    const claim = await generations.claim('renewed-worker', now + 60, 1000);
    assert.ok(claim);
    assert.equal(await generations.saveOutput(claim, result('The accepted post keeps its original allowance.'), now + 61), true);
    assert.deepEqual((await newUsage.get()).data(), untouched);
    assert.equal((await oldUsage.get()).data()!.consumed.x_posts, 1);
    assert.equal((await oldUsage.get()).data()!.consumed.sourceSeconds, 30);
    assert.equal((await imports.get(uid, id))!.sourceAllowanceConsumed, true);
    await assert.rejects(generations.start(uid, id, 'new-excluded-format-request', { x_posts: 1, linkedin_posts: 0 }, now + 62), { code: 'feature_not_in_plan' });
  });
});

test('an import measured above its estimate uses only its original admission budget after renewal', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, grant, grantRef, imports, oldUsage, create }) => {
    const project = await create();
    const claim = await imports.claim('import-worker', now + 1, 1000);
    assert.ok(claim);
    const renewed = { ...grant, startsAt: new Date(now + 50).toISOString(), expiresAt: new Date(now + 100_000).toISOString(), limits: { ...grant.limits, sourceSeconds: 0 } };
    await grantRef.set(renewed);
    assert.equal(await imports.complete(claim, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 1) }, now + 60), true);
    assert.equal((await oldUsage.get()).data()!.reserved.sourceSeconds, 0);
    assert.equal((await oldUsage.get()).data()!.consumed.sourceSeconds, 60);
    assert.equal((await account.collection('allowances').doc(grantPeriod(renewed)).get()).exists, false);
  });
  await withAccount(async ({ uid, grant, grantRef, imports, create }) => {
    const project = await create();
    const claim = await imports.claim('import-worker', now + 1, 1000);
    assert.ok(claim);
    await grantRef.set({ ...grant, startsAt: new Date(now + 50).toISOString(), expiresAt: new Date(now + 100_000).toISOString(), limits: { ...grant.limits, sourceSeconds: 1000 } });
    await assert.rejects(imports.complete(claim, { bytes: 9, durationSeconds: 121, storagePath: sourcePath(uid, project.id, 1) }, now + 60), { code: 'allowance_exceeded' });
  });
});

test('legacy imports without an admission limit cannot expand an expired reservation', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, imports, create }) => {
    const project = await create();
    const { FieldValue } = await import('firebase-admin/firestore');
    await account.collection('projects').doc(project.id).update({ sourceAllowanceLimit: FieldValue.delete() });
    const claim = await imports.claim('legacy-worker', now + 60, 1000);
    assert.ok(claim);
    await assert.rejects(imports.complete(claim, { bytes: 9, durationSeconds: 31, storagePath: sourcePath(uid, project.id, 1) }, now + 61), { code: 'allowance_exceeded' });
    assert.equal(await imports.complete(claim, { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, 1) }, now + 62), true);
  });
});

test('revoked or missing access blocks queued work and releases the old reservation once', emulatorOnly, async () => {
  for (const revoked of [null, { status: 'revoked' }]) {
    await withAccount(async ({ account, grantRef, generations, oldUsage, accepted }) => {
      await accepted();
      if (revoked) await grantRef.set(revoked); else await grantRef.delete();
      assert.equal(await generations.claim('blocked-worker', now + 60, 1000), null);
      assert.equal(await generations.claim('blocked-worker', now + 61, 1000), null);
      const usage = (await oldUsage.get()).data()!;
      assert.equal(usage.reserved.x_posts, 0);
      assert.equal(usage.reserved.sourceSeconds, 0);
      assert.equal(usage.consumed.x_posts, 0);
      assert.equal(usage.consumed.sourceSeconds, 30);
      assert.deepEqual((await account.collection('processing').doc('current').get()).data(), { active: null, queued: 0 });
    });
  }
});

test('withdrawal during a provider call retains usage and immediately releases every pending output', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, grantRef, generations, oldUsage, accepted }) => {
    const { id } = await accepted(2);
    const worker = createGenerationWorker({ store: generations, now: () => now + 60, providers: {
      transcribe: async () => assert.fail('The transcript is already saved.'),
      generate: async (_transcript, _slot, _selection, _signal, mark) => {
        await mark({ provider: 'fixture', model: 'fixture', rates: null });
        await grantRef.delete();
        return { ...result('This output must not be delivered after access removal.'), usage: { ...unknownUsage(), inputTokens: 100, outputTokens: 20 } };
      },
    } });
    assert.equal(await worker.runOnce(), true);
    assert.equal((await generations.batch(uid, id))!.status, 'failed');
    assert.deepEqual(await generations.outputs(uid, id, now + 61), []);
    const usage = (await oldUsage.get()).data()!;
    assert.equal(usage.reserved.x_posts, 0);
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.x_posts, 0);
    assert.equal(usage.consumed.sourceSeconds, 30);
    assert.deepEqual((await account.collection('processing').doc('current').get()).data(), { active: null, queued: 0 });
    assert.ok((await generations.batch(uid, id))!.slots.every(slot => slot.status === 'failed'));
  });
});

test('fractional source durations consume whole seconds at import and remain claimable', emulatorOnly, async () => {
  await withAccount(async ({ uid, grant, grantRef, generations, oldUsage, imported }) => {
    await grantRef.set({ ...grant, limits: { ...grant.limits, sourceSeconds: 1000 } });
    const id = await imported(355.19);
    await generations.start(uid, id, 'fractional-duration-key', { x_posts: 1, linkedin_posts: 0 }, now + 3);
    assert.equal((await oldUsage.get()).data()!.reserved.sourceSeconds, 0);
    assert.equal((await oldUsage.get()).data()!.consumed.sourceSeconds, 356);
    const first = await generations.claim('fractional-worker', now + 4, 1000);
    assert.ok(first);
    assert.equal(await generations.saveTranscript(first, result(transcript), now + 5), true);
    const next = await generations.claim('fractional-worker', now + 6, 1000);
    assert.ok(next);
    assert.equal(await generations.saveOutput(next, result('A valid post from a fractional-duration video.'), now + 7), true);
    const usage = (await oldUsage.get()).data()!;
    assert.equal(usage.consumed.sourceSeconds, 356);
    assert.equal(usage.reserved.sourceSeconds, 0);
  });
});

test('previously accepted fractional reservations remain deliverable without being rounded up again', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, grant, grantRef, generations, oldUsage, imported }) => {
    await grantRef.set({ ...grant, limits: { ...grant.limits, sourceSeconds: 1000 } });
    const id = await imported(355.19);
    await generations.start(uid, id, 'legacy-fractional-key', { x_posts: 1, linkedin_posts: 0 }, now + 3);
    await account.collection('projects').doc(id).update({ reservedSourceSeconds: 355.19, sourceAllowanceConsumed: false });
    await oldUsage.update({ 'reserved.sourceSeconds': 355.19, 'consumed.sourceSeconds': 0 });
    const first = await generations.claim('legacy-worker', now + 4, 1000);
    assert.ok(first);
    assert.equal(await generations.saveTranscript(first, result(transcript), now + 5), true);
    const next = await generations.claim('legacy-worker', now + 60, 1000);
    assert.ok(next);
    assert.equal(await generations.saveOutput(next, result('A valid legacy output.'), now + 61), true);
    const usage = (await oldUsage.get()).data()!;
    assert.equal(usage.consumed.sourceSeconds, 355.19);
    assert.equal(usage.reserved.sourceSeconds, 0);
  });
});

test('a whole-second import reservation can coexist with older fractional generation reservations', emulatorOnly, async () => {
  await withAccount(async ({ uid, account, grant, grantRef, imports, generations, oldUsage, imported, create }) => {
    await grantRef.set({ ...grant, limits: { ...grant.limits, sourceSeconds: 1000 } });
    const id = await imported(355.19);
    await generations.start(uid, id, 'aggregate-fractional-key', { x_posts: 1, linkedin_posts: 0 }, now + 3);
    await account.collection('projects').doc(id).update({ reservedSourceSeconds: 355.19, sourceAllowanceConsumed: false });
    await oldUsage.update({ 'reserved.sourceSeconds': 355.19, 'consumed.sourceSeconds': 0 });
    const next = await create();
    const claim = await imports.claim('new-import-worker', now + 4, 1000) ?? await imports.claim('new-import-worker', now + 4, 1000);
    assert.ok(claim);
    assert.equal(claim.project.id, next.id);
    assert.equal(await imports.complete(claim, { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, next.id, 1) }, now + 5), true);
    assert.equal((await oldUsage.get()).data()!.reserved.sourceSeconds, 355.19);
    assert.equal((await oldUsage.get()).data()!.consumed.sourceSeconds, 30);
  });
});

test('an import revoked during upload fails without retrying or retaining its source reservation', emulatorOnly, async () => {
  await withAccount(async ({ uid, grantRef, imports, oldUsage, create }) => {
    const project = await create();
    const removed: string[] = [];
    const worker = createIntakeWorker({ store: imports, now: () => now + 1, importSource: async claim => {
      await grantRef.delete();
      return { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, claim.attempt) };
    }, deleteSource: async path => { removed.push(path); } });
    assert.equal(await worker.runOnce(), true);
    const saved = (await imports.get(uid, project.id))!;
    assert.equal(saved.status, 'failed');
    assert.equal(saved.errorCode, 'subscription_required');
    assert.equal((await oldUsage.get()).data()!.reserved.sourceSeconds, 0);
    assert.deepEqual(removed, [sourcePath(uid, project.id, 1)]);
    assert.equal(await imports.claim('another-worker', now + 2, 1000), null);
  });
});

test('revocation detected by heartbeat releases an import even when its upload ignores abort', { ...emulatorOnly, timeout: 5000 }, async () => {
  await withAccount(async ({ uid, account, grantRef, imports, oldUsage, create }) => {
    const project = await create();
    let observed!: () => void;
    const lost = new Promise<void>(resolve => { observed = resolve; });
    const store = { ...imports, renew: async (...args: Parameters<typeof imports.renew>) => {
      const renewed = await imports.renew(...args);
      if (!renewed) observed();
      return renewed;
    } };
    const worker = createIntakeWorker({ store, now: () => now + 1, leaseMilliseconds: 30, importSource: async claim => {
      await grantRef.delete();
      await lost;
      await new Promise<void>(resolve => setImmediate(resolve));
      return { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, claim.attempt) };
    }, deleteSource: async () => {} });
    assert.equal(await worker.runOnce(), true);
    assert.equal((await imports.get(uid, project.id))!.status, 'failed');
    assert.equal((await oldUsage.get()).data()!.reserved.sourceSeconds, 0);
    assert.deepEqual((await account.collection('processing').doc('current').get()).data(), { active: null, queued: 0 });
  });
});

test('settling an old worker after genuine ownership loss leaves the replacement claim intact', { ...emulatorOnly, timeout: 5000 }, async context => {
  await withAccount(async ({ uid, db, imports, oldUsage, create }) => {
    const project = await create();
    context.mock.timers.enable({ apis: ['setInterval'] });
    let entered!: () => void, release!: () => void, observed!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finishImport = new Promise<void>(resolve => { release = resolve; });
    const lost = new Promise<void>(resolve => { observed = resolve; });
    const store = { ...imports, renew: async (...args: Parameters<typeof imports.renew>) => {
      const renewed = await imports.renew(...args);
      if (!renewed) observed();
      return renewed;
    } };
    const worker = createIntakeWorker({ store, now: () => now + 1, leaseMilliseconds: 30, importSource: async claim => {
      entered();
      await finishImport;
      return { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, claim.attempt) };
    }, deleteSource: async () => {} });
    const running = worker.runOnce();
    try {
      await started;
      const replacement = await imports.claim('replacement-worker', now + 32, 1000) ?? await imports.claim('replacement-worker', now + 32, 1000);
      assert.ok(replacement);
      context.mock.timers.tick(10);
      await lost;
      await new Promise<void>(resolve => setImmediate(resolve));
      release();
      assert.equal(await running, true);
      assert.equal((await db.collection('intakeJobs').doc(project.id).get()).data()!.workerId, 'replacement-worker');
      assert.equal((await oldUsage.get()).data()!.reserved.sourceSeconds, 30);
      assert.equal((await imports.get(uid, project.id))!.attempts, 2);
      assert.equal(await imports.complete(replacement, { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, 2) }, now + 33), true);
    } finally { release(); await running; }
  });
});

test('missing original reservations never borrow capacity from a renewed plan', emulatorOnly, async () => {
  await withAccount(async ({ grant, grantRef, generations, oldUsage, accepted }) => {
    await accepted();
    await oldUsage.update({ 'reserved.x_posts': 0 });
    await grantRef.set({ ...grant, startsAt: new Date(now + 50).toISOString(), expiresAt: new Date(now + 100_000).toISOString() });
    assert.equal(await generations.claim('unfunded-worker', now + 60, 1000), null);
    assert.equal((await oldUsage.get()).data()!.consumed.x_posts, 0);
  });
});
