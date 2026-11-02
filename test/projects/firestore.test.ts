import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createIntakeWorker } from '../../src/projects/worker.js';
import { SourceImportError, sourcePath } from '../../src/projects/source.js';
import { createProjectService } from '../../src/projects/service.js';
import { parseSourceInput } from '../../src/sources/source.js';

const emulatorOnly = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-18T12:00:00Z');

async function withStore(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>, allowance = 3600) {
  const context = await setup(allowance);
  try { await run(context); }
  finally {
    const jobs = await context.db.collection('intakeJobs').where('uid', '==', context.uid).get();
    await Promise.all(jobs.docs.map((doc) => doc.ref.delete()));
    const cleanup = await context.db.collection('assetCleanup').where('owner.uid', '==', context.uid).get();
    await Promise.all(cleanup.docs.map(doc => doc.ref.delete()));
    await context.db.recursiveDelete(context.db.collection('accounts').doc(context.uid));
    await context.db.collection('subscriptionGrants').doc(context.uid).delete();
    await context.db.terminate();
    await deleteApp(context.app);
  }
}

async function setup(allowance: number) {
  const uid = `project-test-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const store = createProjectStore(db);
  const grant = { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, key === 'sourceSeconds' ? allowance : 1])) };
  await db.collection('subscriptionGrants').doc(uid).set(grant);
  const create = (key: string = randomUUID(), seconds: number | null = 60, fileId = 'video-id') => store.create({
    uid, id: randomUUID(), key, now, input: { fileId },
    source: { fileId, name: 'video.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: seconds, requiresProbe: true },
  });
  return { app, db, store, uid, create };
}

test('upload checkpoint survives intake retry and settles its original path exactly once', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create, db }) => {
    const project = await create();
    const first = (await store.claim('receipt-worker', now, 60_000))!;
    const result = { bytes: 9, durationSeconds: 42, storagePath: sourcePath(uid, project.id, first.attempt, 'mp4'), sourceSha256: 'a'.repeat(64), mimeType: 'video/mp4' };
    assert.equal(await store.checkpointSource!(first, result, now + 1), true);
    let usage = await store.usage(uid, now + 2);
    assert.equal(usage.consumed.sourceSeconds, 0);
    assert.equal(usage.reserved.sourceSeconds, 60);
    await store.fail(first, { code: 'worker_interrupted', retryable: true, bytes: 9 }, now + 3);
    const retry = (await store.claim('receipt-retry', now + 3000, 60_000))!;
    assert.equal(retry.project.importUpload?.storagePath, result.storagePath);
    assert.equal(retry.attempt, 2);
    assert.equal(await store.complete(retry, result, now + 3001), true);
    assert.equal(await store.complete(retry, result, now + 3002), false);
    usage = await store.usage(uid, now + 3003);
    assert.equal(usage.consumed.sourceSeconds, 42);
    assert.equal(usage.reserved.sourceSeconds, 0);
    const cleanup = await db.collection('assetCleanup').doc(`${project.id}-source-unused`).get();
    assert.ok(!JSON.stringify(cleanup.data()).includes(result.storagePath));
    assert.equal((await store.get(uid, project.id))?.importUpload, undefined);
  });
});

test('terminal source failure removes staged data and preserves provider usage evidence', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create, db }) => {
    const project = await create();
    const claim = (await store.claim('failed-import', now, 60_000))!;
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(project.id);
    const result = { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, claim.attempt, 'mp4'), sourceSha256: 'a'.repeat(64) };
    await store.checkpointSource!(claim, result, now + 1);
    await ref.collection('transcripts').doc('shared').set({ text: 'staged', stagedImport: { operationId: project.importOperationId, sourceSha256: result.sourceSha256, durationSeconds: 60 } });
    const event = db.collection('accounts').doc(uid).collection('usageEvents').doc('paid-evidence');
    await event.set({ providerInvoked: true, status: 'succeeded', cost: { amountMicros: 123 } });
    await store.fail(claim, { code: 'source_changed', retryable: false, bytes: 9 }, now + 2);
    assert.equal((await ref.collection('transcripts').doc('shared').get()).exists, false);
    assert.deepEqual((await event.get()).data(), { providerInvoked: true, status: 'succeeded', cost: { amountMicros: 123 } });
    assert.equal((await store.get(uid, project.id))?.importUpload, undefined);
    assert.equal((await store.usage(uid, now + 3)).reserved.sourceSeconds, 0);
  });
});

test('concurrent repeated submissions create one project and reserve allowance once', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create }) => {
    const repeated = await Promise.all(Array.from({ length: 5 }, () => create('same-request-key')));
    assert.equal(new Set(repeated.map((project) => project.id)).size, 1);
    const usage = await store.usage(uid, now) as any;
    assert.equal(usage.reserved.sourceSeconds, 60);
    assert.equal(usage.consumed.sourceSeconds, 0);
    assert.equal((await store.list(uid)).length, 1);
    await assert.rejects(create('same-request-key', 60, 'another-video'), { code: 'idempotency_conflict' });
    assert.equal(await store.get('another-account', repeated[0]!.id), null);
  });
});

test('existing Drive request keys replay through the explicit source alias without migration', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create }) => {
    const original = await create('legacy-drive-key');
    const normalized = parseSourceInput({ source: 'drive', fileId: 'video-id' });
    const replay = await store.lookup(uid, 'legacy-drive-key', normalized);
    assert.equal(replay!.id, original.id);
    assert.deepEqual(replay!.input, { fileId: 'video-id' });
    assert.equal((await store.usage(uid, now) as any).reserved.sourceSeconds, 60);
  });
});

test('future-source metadata reserves unknown duration and settles actual bytes without Drive fields', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db }) => {
    const project = await store.create({ uid, id: randomUUID(), key: 'future-source-key', now,
      input: { source: 'youtube', videoId: 'abcdefghijk' },
      source: { source: 'youtube', videoId: 'abcdefghijk', name: 'Video', mimeType: 'video/mp4', bytes: null, durationSeconds: null, requiresProbe: true },
    });
    assert.equal((await store.usage(uid, now) as any).reserved.sourceSeconds, 1800);
    let claim = await store.claim('future-source-worker', now, 1000);
    if (!claim) claim = await store.claim('future-source-worker', now, 1000);
    assert.ok(claim);
    const events = db.collection('accounts').doc(uid).collection('usageEvents');
    const started = (await events.get()).docs[0]!.data();
    assert.equal(started.provider, 'youtube');
    assert.equal(started.credentialSource, 'none');
    await store.complete(claim, { bytes: 42, durationSeconds: 20.1, storagePath: sourcePath(uid, project.id, 1, 'mp4'), mimeType: 'video/mp4' }, now + 1);
    const saved = await store.get(uid, project.id);
    assert.equal(saved!.source.bytes, 42);
    assert.equal(saved!.source.durationSeconds, 20.1);
    assert.equal(saved!.source.mimeType, 'video/mp4');
    assert.ok(saved!.storagePath?.endsWith('.mp4'));
    assert.equal(saved!.source.requiresProbe, false);
    assert.ok(!('fileId' in saved!.source));
    assert.equal((await db.collection('assetCleanup').doc(`${project.id}-source-unused`).get()).exists, false);
    assert.equal((await store.usage(uid, now + 1) as any).reserved.sourceSeconds, 0);
    assert.equal((await store.usage(uid, now + 1) as any).consumed.sourceSeconds, 21);
    assert.equal(saved!.sourceAllowanceConsumed, true);
    const completed = (await events.get()).docs[0]!.data();
    assert.equal(completed.provider, 'youtube');
    assert.equal(completed.credentialSource, 'none');
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.units.sourceSeconds, 21);
    assert.equal(completed.period, saved!.period);
  });
});

test('successful import consumes measured allowance once even after deletion', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create }) => {
    const project = await create();
    const claim = (await store.claim('import-worker', now, 1000))!;
    const result = { bytes: 9, durationSeconds: 39.2, storagePath: sourcePath(uid, project.id, claim.attempt) };
    const completions = await Promise.all([store.complete(claim, result, now + 1), store.complete(claim, result, now + 1)]);
    assert.deepEqual(completions.sort(), [false, true]);
    const saved = (await store.get(uid, project.id))!;
    assert.equal(saved.reservedSourceSeconds, 0);
    assert.equal(saved.sourceAllowanceConsumed, true);
    assert.equal((await store.usage(uid, now + 2)).consumed.sourceSeconds, 40);
    await store.remove(uid, project.id, now + 3);
    await store.remove(uid, project.id, now + 4);
    const usage = await store.usage(uid, now + 5);
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 40);
    assert.equal(usage.remaining.sourceSeconds, 3560);
  });
});

test('simultaneous projects cannot exceed quota and deletion releases it once', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create }) => {
    const results = await Promise.allSettled([create(), create()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const project = (await store.list(uid))[0]!;
    await store.remove(uid, project.id, now + 1);
    await store.remove(uid, project.id, now + 2);
    const usage = await store.usage(uid, now + 2) as any;
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 0);
    await create();
  }, 60);
});

test('leases prevent duplicate workers and stale completion after a crash', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create, db }) => {
    const project = await create('lease-request', null);
    const contenders = await Promise.all([store.claim('worker-a', now, 1000), store.claim('worker-b', now, 1000)]);
    assert.equal(contenders.filter(Boolean).length, 1);
    const first = contenders.find(Boolean)!;
    const recovered = await store.claim('worker-c', now + 1001, 1000);
    assert.ok(recovered);
    assert.equal(recovered.attempt, 2);
    assert.equal(await store.renew(first, now + 1001, 1000), false);
    const result = { bytes: 9, durationSeconds: 40.1, storagePath: sourcePath(uid, project.id, recovered.attempt) };
    assert.equal(await store.complete(first, result, now + 1002), false);
    assert.equal(await store.complete(recovered, result, now + 1002), true);
    assert.equal(await store.complete(recovered, result, now + 1003), false);
    const usage = await store.usage(uid, now + 1003) as any;
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 41);
    const saved = await store.get(uid, project.id);
    assert.equal(saved!.status, 'source_ready');
    assert.equal(saved!.source.requiresProbe, false);
    const events = await db.collection('accounts').doc(uid).collection('usageEvents').get();
    assert.equal(events.size, 2);
    assert.deepEqual(events.docs.map((doc) => doc.data().status).sort(), ['interrupted', 'succeeded']);
    for (const event of events.docs) {
      assert.deepEqual(event.data().cost, { status: 'unknown', amountMicros: null, currency: 'USD', rateSnapshot: null });
      assert.equal(event.data().provider, 'google_drive');
      assert.equal(event.data().credentialSource, 'user');
    }
  });
});

test('retrying an import records each attempt and final failure releases its reservation', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create, db }) => {
    await create();
    let clock = now;
    const worker = createIntakeWorker({ store, now: () => clock, importSource: async () => { throw new SourceImportError('temporary_download_failure', true, 7); } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await worker.runOnce(), true);
      clock += 10_000;
    }
    assert.equal(await worker.runOnce(), false);
    const project = (await store.list(uid))[0]!;
    assert.equal(project.status, 'failed');
    assert.equal(project.attempts, 3);
    const usage = await store.usage(uid, clock) as any;
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 0);
    const events = await db.collection('accounts').doc(uid).collection('usageEvents').get();
    assert.equal(events.size, 3);
    assert.ok(events.docs.every((doc) => doc.data().units.sourceBytes === 7));
  });
});

test('retention cleanup preserves consumed source allowance and completed deletions leave future scans', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const claim = await store.claim('worker', now, 1000);
    assert.ok(claim);
    const path = sourcePath(uid, project.id, 1);
    await store.complete(claim, { bytes: 9, durationSeconds: 60, storagePath: path }, now + 1);
    const removed: string[] = [];
    const worker = createIntakeWorker({ store, now: () => now + 8 * 86_400_000, importSource: async () => { throw Error('must not import'); }, deleteSource: async (path) => { removed.push(path); } });
    await worker.cleanup();
    const assets = createGenerationStore(db, { remove: async path => { if (path.startsWith(`accounts/${uid}/`)) removed.push(path); } });
    for (let pass = 0; pass < 3; pass++) await assets.cleanup(now + 8 * 86_400_000);
    assert.ok(removed.includes(path));
    assert.ok(removed.includes(sourcePath(uid, project.id, 1, 'mp4')));
    assert.ok(removed.every(path => path.includes('/source/attempt-1.')));
    const removals = [...removed];
    assert.equal((await store.get(uid, project.id))!.status, 'source_expired');
    assert.ok(!(await store.expiredSources(now + 9 * 86_400_000)).some((source) => source.id === project.id));
    await worker.cleanup();
    assert.deepEqual(removed, removals);
    assert.equal((await store.usage(uid, now) as any).reserved.sourceSeconds, 0);
    assert.equal((await store.usage(uid, now) as any).consumed.sourceSeconds, 60);
  });
});

test('one account keeps one active import and at most two waiting projects', emulatorOnly, async () => {
  await withStore(async ({ store, create, uid }) => {
    await create();
    await create();
    await assert.rejects(create(), { code: 'queue_full' });
    const contenders = await Promise.all([store.claim('worker-a', now, 1000), store.claim('worker-b', now, 1000)]);
    assert.equal(contenders.filter(Boolean).length, 1);
    await create();
    await assert.rejects(create(), { code: 'queue_full' });
    assert.equal((await store.list(uid)).length, 3);
  });
});

test('an actual duration beyond allowance fails and removes imported bytes without charging usage', emulatorOnly, async () => {
  await withStore(async ({ store, create, uid }) => {
    const project = await create();
    const removed: string[] = [];
    const worker = createIntakeWorker({
      store, now: () => now + 1,
      importSource: async (claim) => ({ bytes: 9, durationSeconds: 60.5, storagePath: sourcePath(uid, project.id, claim.attempt) }),
      deleteSource: async (path) => { removed.push(path); },
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal((await store.get(uid, project.id))!.status, 'failed');
    assert.deepEqual(removed, [sourcePath(uid, project.id, 1)]);
    const usage = await store.usage(uid, now + 2) as any;
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 0);
  }, 60);
});

test('blocked accounts on the first queue page do not stop another account importing', emulatorOnly, async () => {
  await withStore(async ({ store, create, uid, db }) => {
    const ready = await create();
    await db.collection('intakeJobs').doc(ready.id).update({ availableAt: now + 1 });
    const blocked = Array.from({ length: 51 }, () => ({ uid: `${uid}-${randomUUID()}`, id: randomUUID() }));
    const batch = db.batch();
    for (const item of blocked) {
      batch.set(db.collection('accounts').doc(item.uid).collection('projects').doc(item.id), { ...ready, id: item.id, uid: item.uid });
      batch.set(db.collection('accounts').doc(item.uid).collection('processing').doc('current'), { active: 'another-project', queued: 1 });
      batch.set(db.collection('intakeJobs').doc(item.id), { uid: item.uid, projectId: item.id, availableAt: now, workerId: null, attempt: 0, startedAt: null });
    }
    await batch.commit();
    try {
      assert.equal((await store.claim('available-worker', now + 2, 1000))!.project.id, ready.id);
    } finally {
      await Promise.all(blocked.flatMap((item) => [db.recursiveDelete(db.collection('accounts').doc(item.uid)), db.collection('intakeJobs').doc(item.id).delete()]));
    }
  });
});

test('revoked subscriptions are rejected again when a worker claims queued work', emulatorOnly, async () => {
  await withStore(async ({ store, create, uid, db }) => {
    const project = await create();
    await db.collection('subscriptionGrants').doc(uid).delete();
    assert.equal(await store.claim('worker', now + 1, 1000), null);
    const saved = await store.get(uid, project.id);
    assert.equal(saved!.status, 'failed');
    assert.equal(saved!.errorCode, 'subscription_required');
    const allowance = (await db.collection('accounts').doc(uid).collection('allowances').get()).docs[0]!.data();
    assert.equal(allowance.reserved.sourceSeconds, 0);
    assert.equal(allowance.consumed.sourceSeconds, 0);
    assert.equal((await db.collection('accounts').doc(uid).collection('usageEvents').get()).size, 0);
  });
});

test('failed heartbeats abort owned imports and queue a bounded retry without spending allowance', { ...emulatorOnly, timeout: 10_000 }, async () => {
  for (const throws of [false, true]) await withStore(async ({ store, create, uid, db }) => {
    const project = await create();
    const removed: string[] = [];
    let sawAbort = false;
    const worker = createIntakeWorker({
      // Neither simulated renewal failure transfers the actual database claim.
      store: { ...store, renew: async () => { if (throws) throw Error('Temporary renewal failure.'); return false; } }, now: () => now, leaseMilliseconds: 30,
      importSource: async (claim, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
        return { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, claim.attempt) };
      },
      deleteSource: async (path) => { removed.push(path); },
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(sawAbort, true);
    assert.deepEqual(removed, [sourcePath(uid, project.id, 1)]);
    const saved = (await store.get(uid, project.id))!;
    assert.equal(saved.status, 'importing');
    assert.equal(saved.errorCode, 'stale_import');
    const usage = await store.usage(uid, now) as any;
    assert.equal(usage.reserved.sourceSeconds, 60);
    assert.equal(usage.consumed.sourceSeconds, 0);
    const retry = (await db.collection('intakeJobs').doc(project.id).get()).data()!;
    assert.equal(retry.workerId, null);
    assert.equal(retry.availableAt, now + 2000);
    assert.deepEqual((await db.collection('accounts').doc(uid).collection('processing').doc('current').get()).data(), { active: project.id, queued: 0 });
  });
});

test('a lost completion reply does not delete a source already saved successfully', emulatorOnly, async () => {
  await withStore(async ({ store, create, uid }) => {
    const project = await create();
    const removed: string[] = [];
    let failures = 0;
    const worker = createIntakeWorker({
      store: {
        ...store,
        complete: async (...args) => {
          assert.equal(await store.complete(...args), true);
          throw Error('Completion reply was lost.');
        },
        fail: async (...args) => { failures++; return store.fail(...args); },
      },
      now: () => now + 1,
      importSource: async (claim) => ({ bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, claim.attempt) }),
      deleteSource: async (path) => { removed.push(path); },
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal((await store.get(uid, project.id))!.status, 'source_ready');
    assert.deepEqual(removed, []);
    assert.equal(failures, 0);
    assert.equal((await store.usage(uid, now + 2) as any).consumed.sourceSeconds, 60);
  });
});

test('manual retry is atomic, preserves attempt history and grants a fresh automatic retry window', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const claim = (await store.claim('original-worker', now, 1000))!;
    await store.fail(claim, { code: 'source_import_failed', retryable: false, bytes: 3 }, now + 1);
    const stale = (await store.expiredSources(now + 2)).find(item => item.id === project.id)!;
    assert.ok(stale);
    const request = { uid, id: project.id, key: 'retry-same-key', source: project.source, attempts: 1, updatedAt: now + 1, now: now + 60_003 };
    const repeated = await Promise.all(Array.from({ length: 5 }, () => store.retry(request)));
    assert.ok(repeated.every(item => item.id === project.id && item.attempts === 1));
    assert.equal((await store.usage(uid, now + 3) as any).reserved.sourceSeconds, 60);
    assert.equal((await db.collection('accounts').doc(uid).collection('processing').doc('current').get()).data()!.queued, 1);
    assert.equal(await store.remove(uid, project.id, now + 4, true, stale), undefined);
    await store.finishCleanup(uid, project.id, now + 4, stale);
    assert.equal((await store.get(uid, project.id))!.status, 'queued');
    await assert.rejects(store.retry({ ...request, key: 'another-retry-key' }), { code: 'import_not_failed' });
    await assert.rejects(store.retry({ ...request, uid: 'someone-else' }), { code: 'project_not_found' });
    let time = now + 60_010;
    for (let attempt = 2; attempt <= 4; attempt++) {
      const next = (await store.claim('retry-worker', time, 1000))!;
      assert.equal(next.attempt, attempt);
      assert.equal(await store.fail(next, { code: 'source_import_failed', retryable: true, bytes: 4 }, time + 1), true);
      if (attempt < 4) assert.equal((await db.collection('intakeJobs').doc(project.id).get()).data()!.availableAt, time + 1 + 1000 * 2 ** (attempt - 1));
      time += 20_000;
    }
    const failed = (await store.get(uid, project.id))!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 4);
    assert.equal((await db.collection('accounts').doc(uid).collection('usageEvents').get()).size, 4);
    assert.equal((await store.usage(uid, time) as any).reserved.sourceSeconds, 0);
    assert.equal((await store.lookupRetry(uid, project.id, request.key))!.attempts, 4);
    await assert.rejects(store.lookupRetry(uid, 'another-project', request.key), { code: 'idempotency_conflict' });
    // Old validation cannot enqueue a newer failed attempt window.
    await assert.rejects(store.retry({ ...request, key: 'stale-check-key', now: time }), { code: 'import_not_failed' });
  });
});

test('manual retry checks current allowance, queue capacity and subscription without reservations on rejection', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const claim = (await store.claim('worker', now, 1000))!;
    await store.fail(claim, { code: 'source_import_failed', retryable: false, bytes: 0 }, now + 1);
    const request = { uid, id: project.id, key: 'retry-policy-key', source: { ...project.source, durationSeconds: 61 }, attempts: 1, updatedAt: now + 1, now: now + 60_002 };
    await assert.rejects(store.retry(request), { code: 'allowance_exceeded' });
    await db.collection('accounts').doc(uid).collection('processing').doc('current').set({ active: null, queued: 2 });
    await assert.rejects(store.retry({ ...request, source: project.source }), { code: 'queue_full' });
    await db.collection('accounts').doc(uid).collection('processing').doc('current').set({ active: null, queued: 0 });
    await db.collection('subscriptionGrants').doc(uid).delete();
    await assert.rejects(store.retry({ ...request, source: project.source }), { code: 'subscription_required' });
    assert.equal((await db.collection('accounts').doc(uid).collection('importRetryKeys').get()).size, 0);
    assert.equal((await store.get(uid, project.id))!.status, 'failed');
  }, 60);
});

test('cleanup already invalidated before manual retry deletes only old paths and cannot clear a newer source', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const first = (await store.claim('worker', now, 1000))!;
    await store.fail(first, { code: 'source_import_failed', retryable: false, bytes: 0 }, now + 1);
    const expired = (await store.expiredSources(now + 2)).find(item => item.id === project.id)!;
    const removed: string[] = [];
    const worker = createIntakeWorker({ store, now: () => now + 3, importSource: async () => { throw Error('Unexpected import'); }, deleteSource: async () => { throw Error('Source worker must queue deletion.'); } });
    const assets = createGenerationStore(db, { remove: async path => {
      if (!path.startsWith(`accounts/${uid}/`)) return;
      removed.push(path);
      if (removed.length > 1) return;
      await store.retry({ uid, id: project.id, key: 'during-cleanup-key', source: project.source, attempts: 1, updatedAt: (await store.get(uid, project.id))!.updatedAt, now: now + 60_004 });
      const next = (await store.claim('new-worker', now + 60_005, 1000))!;
      await store.complete(next, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 2) }, now + 60_006);
    } });
    await worker.cleanup();
    for (let pass = 0; pass < 3; pass++) await assets.cleanup(now + 3);
    assert.ok(removed.includes(sourcePath(uid, project.id, 1)));
    assert.ok(removed.every(path => path.includes('/source/attempt-1.')));
    const ready = (await store.get(uid, project.id))!;
    assert.equal(ready.status, 'source_ready');
    assert.equal(ready.storagePath, sourcePath(uid, project.id, 2));
    assert.notEqual(ready.sourceExpiresAt, expired.sourceExpiresAt);
  });
});


test('rejecting an unstarted manual retry preserves the prior usage event unchanged', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const claim = (await store.claim('original-worker', now, 1000))!;
    await store.fail(claim, { code: 'source_import_failed', retryable: false, bytes: 123 }, now + 1);
    const event = db.collection('accounts').doc(uid).collection('usageEvents').doc(`${project.id}-import-1`);
    const original = (await event.get()).data();
    await store.retry({ uid, id: project.id, key: 'unstarted-retry-key', source: project.source, attempts: 1, updatedAt: now + 1, now: now + 60_002 });
    await db.collection('subscriptionGrants').doc(uid).delete();
    assert.equal(await store.claim('new-worker', now + 60_003, 1000), null);
    assert.equal((await store.get(uid, project.id))!.status, 'failed');
    assert.deepEqual((await event.get()).data(), original);
    assert.equal((await db.collection('accounts').doc(uid).collection('usageEvents').get()).size, 1);
  });
});


test('manual retry cooldown blocks early requests atomically and same-key replay bypasses a later cooldown', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create }) => {
    const project = await create();
    const claim = (await store.claim('worker', now, 1000))!;
    await store.fail(claim, { code: 'source_import_failed', retryable: false, bytes: 0 }, now + 1);
    const request = { uid, id: project.id, key: 'cooldown-retry-key', source: project.source, attempts: 1, updatedAt: now + 1, now: now + 60_000 };
    await assert.rejects(store.retry(request), { code: 'retry_cooldown', retryAfterSeconds: 1 });
    assert.equal((await store.usage(uid, now) as any).reserved.sourceSeconds, 0);
    await store.retry({ ...request, now: now + 60_001 });
    const next = (await store.claim('worker', now + 60_002, 1000))!;
    await store.fail(next, { code: 'source_import_failed', retryable: false, bytes: 0 }, now + 60_003);
    assert.equal((await store.retry({ ...request, now: now + 60_004 })).status, 'failed');
    assert.equal((await store.get(uid, project.id))!.retryAvailableAt, now + 120_003);
  });
});


test('ready replacement consumes allowance without charging the failed import again', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const failed = await create('failed-original-key', 1025);
    const first = (await store.claim('worker', now, 1000))!;
    await store.fail(first, { code: 'youtube_download_failed', retryable: false, bytes: 0 }, now + 1);
    const ready = await create('ready-replacement-key', 1025);
    // A newly created job may sort before the previous claim cursor; the next poll wraps.
    const second = (await store.claim('worker', now + 2, 1000)) ?? (await store.claim('worker', now + 2, 1000))!;
    await store.complete(second, { durationSeconds: 1024.732033, bytes: 100, storagePath: sourcePath(uid, ready.id, second.attempt) }, now + 3);
    const clock = now + 60_002;
    const service = createProjectService({ store, now: () => clock, validateSource: async () => failed.source });
    const before = await store.usage(uid, clock);
    assert.equal(before.reserved.sourceSeconds, 0);
    assert.equal(before.consumed.sourceSeconds, 1025);
    assert.equal(before.remaining.sourceSeconds, 775);
    const detail = await service.get(uid, failed.id);
    assert.equal(detail.importRetry.available, false);
    assert.equal(detail.importRetry.reason, 'allowance_exceeded');
    assert.deepEqual(detail.importRetry.allowance, { requiredSeconds: 1025, remainingSeconds: 775 });
    await assert.rejects(service.retry(uid, failed.id, 'quota-retry-key'), { status: 403, code: 'allowance_exceeded', allowance: { requiredSeconds: 1025, remainingSeconds: 775 } });
    assert.deepEqual(await store.usage(uid, clock), before);
    assert.equal((await db.collection('intakeJobs').doc(failed.id).get()).exists, false);
    assert.equal((await db.collection('accounts').doc(uid).collection('importRetryKeys').get()).empty, true);
    assert.equal((await store.get(uid, ready.id))!.status, 'source_ready');
    const grantRef = db.collection('subscriptionGrants').doc(uid);
    await grantRef.update({ startsAt: '2026-10-18T00:00:00Z', expiresAt: '2026-11-18T00:00:00Z' });
    const refreshed = await service.get(uid, failed.id);
    assert.equal(refreshed.importRetry.available, true);
    assert.deepEqual(refreshed.importRetry.allowance, { requiredSeconds: 1025, remainingSeconds: 1800 });
    await service.retry(uid, failed.id, 'accepted-retry-key');
    await grantRef.update({ 'limits.sourceSeconds': 0 });
    assert.equal((await service.retry(uid, failed.id, 'accepted-retry-key')).status, 'queued');
    await grantRef.delete();
    // Accepted same-key requests remain recoverable after access changes.
    assert.equal((await service.retry(uid, failed.id, 'accepted-retry-key')).status, 'queued');
    const retriedClaim = (await store.claim('retry-worker', clock + 1, 1000));
    // A revoked grant is handled by claim admission; the read must remain safe.
    assert.equal(retriedClaim, null);
    const revoked = await service.get(uid, failed.id);
    assert.equal(revoked.importRetry.available, false);
    assert.equal(revoked.importRetry.reason, 'subscription_required');
  }, 1800);
});

test('accepted source caps follow paid eligibility while trial funds the lower-plan import', emulatorOnly, async () => {
  await withStore(async ({ db, uid, store }) => {
    const { startTrial, transitionLifecycle } = await import('../../src/access/lifecycle.js');
    const { sourcePlanLimits } = await import('../../src/access/source-limits.js');
    const trial = startTrial(null, 'trial-cap-period', now);
    const paid = transitionLifecycle(trial, { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: 'paid-cap-period', startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString() }, now);
    await db.collection('subscriptionGrants').doc(uid).set(paid);
    const project = await store.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'long' }, source: { fileId: 'long', name: 'long.mp4', mimeType: 'video/mp4', bytes: 5000000000, durationSeconds: 2400, requiresProbe: true } });
    assert.deepEqual(project.sourceLimits, sourcePlanLimits.lower);
    assert.equal(project.reservedSourceSeconds, 2400);
    assert.equal(project.sourceFunding!.length, 1);
    assert.equal(project.sourceFunding![0]!.period, 'shared-trial-cap-period');
    await assert.rejects(store.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'oversize' }, source: { fileId: 'oversize', name: 'long.mp4', mimeType: 'video/mp4', bytes: 5000000001, durationSeconds: 60, requiresProbe: true } }), { code: 'source_too_large', status: 422 });
    await assert.rejects(store.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'overtime' }, source: { fileId: 'overtime', name: 'long.mp4', mimeType: 'video/mp4', bytes: 1, durationSeconds: 2700.001, requiresProbe: true } }), { code: 'source_too_long', status: 422 });
  });
});

test('source snapshots survive plan changes and replay while unknown duration reserves the accepted cap', emulatorOnly, async () => {
  await withStore(async ({ db, uid, store }) => {
    const { startTrial, transitionLifecycle } = await import('../../src/access/lifecycle.js');
    const { sourcePlanLimits } = await import('../../src/access/source-limits.js');
    const trial = startTrial(null, 'trial-high-cap', now);
    const paid = transitionLifecycle(trial, { type: 'activate_paid', expectedRevision: 1, plan: 'higher', periodId: 'paid-high-cap', startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString() }, now);
    await db.collection('subscriptionGrants').doc(uid).set(paid);
    const input = { source: 'youtube' as const, videoId: 'abcdefghijk' };
    const project = await store.create({ uid, id: randomUUID(), key: 'durable-high-key', now, input, source: { ...input, name: 'long', mimeType: 'video/mp4', bytes: null, durationSeconds: null, requiresProbe: true } });
    assert.equal(project.reservedSourceSeconds, 3600);
    assert.deepEqual(project.sourceLimits, sourcePlanLimits.higher);
    paid.paid!.plan = 'lower';
    await db.collection('subscriptionGrants').doc(uid).set(paid);
    assert.deepEqual((await store.lookup(uid, 'durable-high-key', input))!.sourceLimits, sourcePlanLimits.higher);
    let claim = await store.claim('cap-worker', now, 60000);
    if (!claim) claim = await store.claim('cap-worker', now, 60000);
    assert.ok(claim);
    await assert.rejects(store.complete(claim, { bytes: 6000000001, durationSeconds: 3600, storagePath: sourcePath(uid, project.id, claim.attempt) }, now + 1), { code: 'invalid_video' });
    assert.equal(await store.complete(claim, { bytes: 6000000000, durationSeconds: 3600, storagePath: sourcePath(uid, project.id, claim.attempt) }, now + 1), true);
    assert.equal((await store.usage(uid, now + 1) as any).consumed.sourceSeconds, 3600);
  });
});

test('transactional admission rejects metadata under the current plan and explicit retry resnapshots caps', emulatorOnly, async () => {
  await withStore(async ({ db, uid, store }) => {
    const { startTrial, transitionLifecycle } = await import('../../src/access/lifecycle.js');
    const { sourcePlanLimits } = await import('../../src/access/source-limits.js');
    const trial = startTrial(null, 'retry-trial-cap', now);
    const paid = transitionLifecycle(trial, { type: 'activate_paid', expectedRevision: 1, plan: 'higher', periodId: 'retry-paid-cap', startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString() }, now);
    await db.collection('subscriptionGrants').doc(uid).set(paid);
    const input = { fileId: 'retry-cap' };
    const source = { ...input, name: 'retry.mp4', mimeType: 'video/mp4', bytes: 6000000000, durationSeconds: 3600, requiresProbe: true };
    const created = await store.create({ uid, id: randomUUID(), key: randomUUID(), now, input, source });
    let claim = await store.claim('retry-cap-worker', now, 60000);
    if (!claim) claim = await store.claim('retry-cap-worker', now, 60000);
    assert.ok(claim);
    await store.fail(claim, { code: 'invalid_video', retryable: false, bytes: 0 }, now + 1);
    const failed = (await store.get(uid, created.id))!;
    paid.paid!.plan = 'lower';
    await db.collection('subscriptionGrants').doc(uid).set(paid);
    const retryNow = now + 60001;
    const request = { uid, id: created.id, key: 'new-retry-cap-key', source, attempts: failed.attempts, updatedAt: failed.updatedAt, now: retryNow };
    await assert.rejects(store.retry(request), { code: 'source_too_large', status: 422 });
    const retried = await store.retry({ ...request, source: { ...source, bytes: 5000000000, durationSeconds: 2700 } });
    assert.deepEqual(retried.sourceLimits, sourcePlanLimits.lower);
    paid.paid!.plan = 'higher';
    await db.collection('subscriptionGrants').doc(uid).set(paid);
    assert.deepEqual((await store.lookupRetry(uid, created.id, request.key))!.sourceLimits, sourcePlanLimits.lower);
  });
});

test('source restoration reuses intake with fresh funding, immutable attempts and retained transcript', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const original = (await store.claim('original', now, 1000))!;
    const hash = 'a'.repeat(64);
    await store.complete(original, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 1), sourceSha256: hash }, now + 1);
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(project.id);
    const transcript = { text: 'Retained words.', words: [{ text: 'Retained words.', start: 0, end: 2 }], sourceSha256: hash, createdAt: now, expiresAt: now + 100000 };
    await ref.collection('transcripts').doc('shared').set(transcript);
    await ref.update({ sourceExpiresAt: now + 2 });
    const expired = (await store.get(uid, project.id))!;
    const request = { intent: 'source_restore' as const, uid, id: project.id, key: 'restore-first', source: expired.source, attempts: expired.attempts, updatedAt: expired.updatedAt, now: now + 3 };
    const accepted = await store.retry(request);
    assert.equal(accepted.sourceSha256, hash);
    assert.equal(accepted.importIntent, 'source_restore');
    assert.equal((await store.retry(request)).importOperationId, accepted.importOperationId);
    assert.equal((await store.lookupRetry(uid, project.id, request.key, 'source_restore'))!.importOperationId, accepted.importOperationId);
    assert.equal(await store.lookupRetry(uid, project.id, request.key), null);
    assert.equal((await store.usage(uid, now + 3)).reserved.sourceSeconds, 60);
    await assert.rejects(createGenerationStore(db).start(uid, project.id, 'generation-during-restore', { x_posts: 1, linkedin_posts: 0 }, now + 3), { code: 'source_not_ready' });
    const restored = (await store.claim('restorer', now + 4, 1000))!;
    assert.equal(restored.attempt, 2);
    assert.equal(await store.complete(original, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 1), sourceSha256: hash }, now + 5), false);
    const restoredResult = { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 2), sourceSha256: hash };
    await assert.rejects(store.complete(restored, { ...restoredResult, sourceSha256: 'b'.repeat(64) }, now + 5), { code: 'source_changed' });
    await ref.collection('transcripts').doc('shared').update({ sourceSha256: 'b'.repeat(64) });
    await assert.rejects(store.complete(restored, restoredResult, now + 5), { code: 'source_identity_unverified' });
    await ref.collection('transcripts').doc('shared').set(transcript);
    await ref.collection('retentionDeletions').doc(`source-${project.id}`).set({ deletedAt: now + 2 });
    await ref.collection('retentionDeletions').doc('output-retained').set({ deletedAt: now + 2 });
    assert.equal(await store.complete(restored, restoredResult, now + 5), true);
    assert.equal((await ref.collection('retentionDeletions').doc(`source-${project.id}`).get()).exists, false);
    assert.equal((await ref.collection('retentionDeletions').doc('output-retained').get()).exists, true);
    assert.equal(await store.remove(uid, project.id, now + 6, true, { uid, id: project.id, storagePath: expired.storagePath, sourceExpiresAt: expired.sourceExpiresAt, attempts: expired.attempts }), undefined);
    assert.equal((await store.usage(uid, now + 5)).consumed.sourceSeconds, 120);
    assert.equal((await store.usage(uid, now + 5)).reserved.sourceSeconds, 0);
    assert.deepEqual((await ref.collection('transcripts').doc('shared').get()).data(), transcript);
    assert.equal((await store.get(uid, project.id))!.storagePath, sourcePath(uid, project.id, 2));
    await assert.rejects(store.retry({ ...request, key: 'restore-live-copy', attempts: 2, updatedAt: now + 5, now: now + 6 }), { code: 'source_restore_not_available' });
  });
});

test('restore rejects unverified live cache and active generation, preserves failure intent and original identity', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const original = (await store.claim('original', now, 1000))!;
    await store.complete(original, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 1) }, now + 1);
    const ref = db.collection('accounts').doc(uid).collection('projects').doc(project.id);
    await ref.update({ sourceExpiresAt: now + 2 });
    const transcript = { text: 'Old text.', words: [{ text: 'Old text.', start: 0, end: 2 }], createdAt: now, expiresAt: now + 100000 };
    await ref.collection('transcripts').doc('shared').set(transcript);
    const expired = (await store.get(uid, project.id))!;
    const request = { intent: 'source_restore' as const, uid, id: project.id, key: 'restore-legacy', source: expired.source, attempts: expired.attempts, updatedAt: expired.updatedAt, now: now + 3 };
    await assert.rejects(store.retry(request), { code: 'source_identity_unverified' });
    assert.equal((await store.usage(uid, now + 3)).reserved.sourceSeconds, 0);
    await ref.collection('transcripts').doc('shared').update({ expiresAt: now + 2 });
    await ref.collection('generation').doc('batch').set({ status: 'queued' });
    await assert.rejects(store.retry(request), { code: 'generation_in_progress' });
    await ref.collection('generation').doc('batch').delete();
    await store.retry(request);
    const claim = (await store.claim('restorer', now + 4, 1000))!;
    await store.fail(claim, { code: 'source_import_failed', retryable: false, bytes: 0 }, now + 5);
    const failed = (await store.get(uid, project.id))!;
    assert.equal(failed.importIntent, 'source_restore');
    assert.equal((await store.usage(uid, now + 5)).reserved.sourceSeconds, 0);
    assert.equal((await store.usage(uid, now + 5)).consumed.sourceSeconds, 60);
    await assert.rejects(store.retry({ ...request, intent: undefined, key: 'bypass-restore', attempts: failed.attempts, updatedAt: failed.updatedAt, now: now + 100000 }), { code: 'import_not_failed' });
    assert.equal((await ref.collection('transcripts').doc('shared').get()).data()!.expiresAt, now + 2);
  });
});

test('project deletion cancels restoration without accepting late source or refunding original import', emulatorOnly, async () => {
  await withStore(async ({ store, uid, db, create }) => {
    const project = await create();
    const hash = 'c'.repeat(64);
    const original = (await store.claim('original', now, 1000))!;
    await store.complete(original, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 1), sourceSha256: hash }, now + 1);
    await db.collection('accounts').doc(uid).collection('projects').doc(project.id).update({ sourceExpiresAt: now + 2 });
    const expired = (await store.get(uid, project.id))!;
    await store.retry({ intent: 'source_restore', uid, id: project.id, key: 'restore-before-delete', source: expired.source, attempts: expired.attempts, updatedAt: expired.updatedAt, now: now + 3 });
    const restoring = (await store.claim('restorer', now + 4, 1000))!;
    await store.remove(uid, project.id, now + 5);
    assert.equal(await store.complete(restoring, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 2), sourceSha256: hash }, now + 6), false);
    assert.equal(await store.get(uid, project.id), null);
    assert.equal((await store.usage(uid, now + 6)).reserved.sourceSeconds, 0);
    assert.equal((await store.usage(uid, now + 6)).consumed.sourceSeconds, 60);
    await assert.rejects(store.retry({ intent: 'source_restore', uid, id: project.id, key: 'restore-deleted-project', source: expired.source, attempts: 2, updatedAt: now + 5, now: now + 6 }), { code: 'project_not_found' });
  });
});

test('progress is canonical, fenced to the live attempt, cleared on retries and terminal states', emulatorOnly, async () => {
  await withStore(async ({ store, uid, create, db }) => {
    const project = await create();
    const first = (await store.claim('progress-worker', now, 1000))!;
    const snapshot = { attempt: first.attempt, stage: 'download' as const, transferredBytes: 4, totalBytes: 9 };
    assert.equal(await store.progress!(first, snapshot, now + 1), true);
    assert.deepEqual((await createProjectService({ store, validateSource: async () => project.source, now: () => now + 2 }).get(uid, project.id)).importProgress, snapshot);
    assert.equal(await store.progress!(first, { ...snapshot, transferredBytes: 3 }, now + 2), false);
    assert.equal(await store.progress!(first, { ...snapshot, totalBytes: 2 }, now + 2), false);
    assert.equal(await store.progress!(first, { ...snapshot, stage: 'prepare', transferredBytes: 0, totalBytes: null }, now + 3), true);
    assert.equal(await store.progress!(first, snapshot, now + 4), false);
    assert.equal(await store.progress!(first, snapshot, now + 1000), false, 'expired lease cannot publish');
    const second = (await store.claim('replacement', now + 1001, 10_000))!;
    assert.deepEqual((await store.get(uid, project.id))!.importProgress, { attempt: second.attempt, stage: 'download', transferredBytes: 0, totalBytes: null });
    assert.equal(await store.progress!(first, snapshot, now + 1002), false);
    assert.equal(await store.progress!(second, { ...snapshot, attempt: second.attempt }, now + 1002), true);
    await store.fail(second, { code: 'temporary', retryable: true, bytes: 4 }, now + 1003);
    assert.equal((await store.get(uid, project.id))!.importProgress, undefined);
    assert.equal(await store.progress!(second, { ...snapshot, attempt: second.attempt }, now + 1004), false);
    const third = (await store.claim('final', now + 6000, 10_000))!;
    await store.complete(third, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, third.attempt) }, now + 6001);
    assert.equal((await store.get(uid, project.id))!.importProgress, undefined);
    assert.equal(await store.progress!(third, { ...snapshot, attempt: third.attempt }, now + 6002), false);
    assert.equal((await store.usage(uid, now + 6002)).consumed.sourceSeconds, 60);
    assert.equal((await db.collection('accounts').doc(uid).collection('usageEvents').get()).size, 3);
  });
});

test('shutdown claim release preserves source reservation and never reuses attempt identity', emulatorOnly, async () => {
  await withStore(async ({ uid, store, create }) => {
    const project = await create();
    const before = await store.usage(uid, now);
    let previous;
    for (let index = 1; index <= 5; index++) {
      const claim = (await store.claim('shutdown-worker', now + index, 1000))!;
      assert.ok(claim);
      assert.equal(claim.attempt, index);
      if (previous) assert.equal(await store.fail(previous, { code: 'worker_shutdown', retryable: true, bytes: 0 }, now + index), false);
      assert.equal(await store.fail(claim, { code: 'worker_shutdown', retryable: true, bytes: 0 }, now + index), true);
      previous = claim;
    }
    const resumed = (await store.claim('replacement', now + 6, 1000))!;
    assert.equal(resumed.attempt, 6);
    assert.deepEqual((await store.usage(uid, now + 6)).reserved, before.reserved);
    assert.equal(await store.complete(resumed, { bytes: 9, durationSeconds: 60, storagePath: sourcePath(uid, project.id, 6) }, now + 7), true);
  });
});
