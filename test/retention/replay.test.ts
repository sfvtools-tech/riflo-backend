import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createProjectService, publicProject } from '../../src/projects/service.js';
import { sourcePath } from '../../src/projects/source.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
for (const mode of ['original', 'retry'] as const) {
  test(`${mode} import replay projects promoted source expiry consistently before cleanup, including transactional replay`, local, async () => {
    const uid = `retention-replay-${randomUUID()}`;
    const app = initializeApp({ projectId: 'demo-riflo' }, uid);
    const db = getFirestore(app);
    const account = db.collection('accounts').doc(uid);
    const store = createProjectStore(db);
    let clock = start;
    const lifecycle = createLifecycleStore(db, { retentionEnabled: true, now: () => clock });
    const input = { fileId: 'fixture-source' };
    const source = { fileId: input.fileId, name: 'Private source', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true };
    const service = createProjectService({ store, now: () => clock, validateSource: async () => source });
    try {
      await lifecycle.startTrial(uid, clock);
      const first = await service.create(uid, input, 'original-import-key');
      let claim = await store.claim('replay-worker', ++clock, 60_000);
      assert.ok(claim);
      assert.equal(claim.project.id, first.id);
      let retrySnapshot;
      if (mode === 'retry') {
        await store.fail(claim, { code: 'fixture-failure', retryable: false, bytes: 0 }, ++clock);
        retrySnapshot = (await store.get(uid, first.id))!;
        clock = retrySnapshot.retryAvailableAt!;
        await service.retry(uid, first.id, 'retry-import-key');
        claim = await store.claim('replay-worker', ++clock, 60_000);
        assert.ok(claim);
      }
      const importedAt = ++clock;
      await store.complete(claim, { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, first.id, claim.attempt) }, importedAt);
      const ref = account.collection('projects').doc(first.id);
      const rawBefore = (await ref.get()).data()!;
      assert.equal(rawBefore.sourceExpiresAt, start + 14 * day);
      clock = start + day;
      await lifecycle.transition(uid, randomUUID(), { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: randomUUID(), startsAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 30 * day).toISOString() });
      const expected = new Date(importedAt + 60 * day).toISOString();
      const get = await service.get(uid, first.id);
      assert.equal(get.sourceExpiresAt, expected);
      assert.equal((await service.list(uid))[0]!.sourceExpiresAt, expected);
      const authorizationMustNotRun = async () => { throw Error('Replay must precede authorization.'); };
      const replayed = mode === 'original'
        ? await service.create(uid, input, 'original-import-key', authorizationMustNotRun)
        : await service.retry(uid, first.id, 'retry-import-key', authorizationMustNotRun);
      assert.equal(replayed.sourceExpiresAt, expected);
      assert.equal(replayed.importOperationId, get.importOperationId);
      const transactional = mode === 'original'
        ? await store.create({ uid, id: randomUUID(), key: 'original-import-key', input, source, now: clock })
        : await store.retry({ uid, id: first.id, key: 'retry-import-key', source, attempts: retrySnapshot!.attempts, updatedAt: retrySnapshot!.updatedAt, now: clock });
      assert.equal(publicProject(transactional, clock).sourceExpiresAt, expected);
      assert.equal((await ref.get()).data()!.sourceExpiresAt, rawBefore.sourceExpiresAt, 'Read projection must not depend on a cleanup rewrite.');
      if (mode === 'retry') await assert.rejects(service.create(uid, input, 'original-import-key'), { code: 'operation_superseded' });
    } finally {
      for (const name of ['intakeJobs', 'generationJobs']) {
        const jobs = await db.collection(name).where('uid', '==', uid).get();
        await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
      }
      await db.recursiveDelete(account);
      await db.collection('subscriptionGrants').doc(uid).delete();
      await db.terminate();
      await deleteApp(app);
    }
  });
}
