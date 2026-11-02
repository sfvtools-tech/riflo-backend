import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { sourcePath } from '../../src/projects/source.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { assetPath } from '../../src/generation/asset-paths.js';
import { createGenerationService, unknownUsage, type AttemptResult } from '../../src/generation/service.js';
import { createHandler } from '../../src/http/app.js';

const day = 86_400_000;
const result = <T>(value: T): AttemptResult<T> => ({ value, provider: 'fixture', model: 'private-model', promptVersion: 'private-prompt', usage: unknownUsage(), rates: null });

test('actual paid output producers expose finite private HTTP contracts through inactive retention and exact expiry', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const uid = `retention-api-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const paidEnd = clock + 30 * day;
  const expiry = paidEnd + 60 * day;
  const lifecycle = createLifecycleStore(db, { retentionEnabled: true, now: () => clock });
  const projects = createProjectStore(db);
  const store = createGenerationStore(db);
  const assets = new Map<string, string>();
  let assetReads = 0;
  const server = createServer(createHandler({
    verifyToken: async token => ({ uid: token }),
    loadGrant: async owner => (await db.collection('subscriptionGrants').doc(owner).get()).data(),
    generation: createGenerationService({ store, now: () => clock }),
    now: () => new Date(clock),
    readOutputAsset: async path => { assetReads++; assert.ok(assets.has(path)); return { body: new Response(assets.get(path)).body!, contentType: 'image/png' }; },
  }));
  try {
    await lifecycle.transition(uid, randomUUID(), { type: 'activate_paid', expectedRevision: 0, plan: 'lower', periodId: randomUUID(), startsAt: new Date(clock).toISOString(), expiresAt: new Date(paidEnd).toISOString() });
    const id = randomUUID();
    await projects.create({ uid, id, key: randomUUID(), now: ++clock, input: { fileId: 'fixture-source' }, source: { fileId: 'fixture-source', name: 'Private source', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true } });
    const intake = (await projects.claim('api-importer', ++clock, 60_000))!;
    const source = { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, id, intake.attempt), sourceSha256: 'a'.repeat(64) };
    const transcription = (await store.claimImport!(intake, source, ++clock))!;
    assert.equal(await store.saveTranscript(transcription, result({ text: 'Private source supported lesson.', words: [{ text: 'Lesson.', start: 0, end: 10 }] }), ++clock), true);
    assert.equal(await projects.complete(intake, source, ++clock), true);
    await store.start(uid, id, randomUUID(), { x_posts: 1, linkedin_posts: 0, carousels: 1 }, ++clock);
    let textId = '', mediaId = '';
    for (let index = 0; index < 2; index++) {
      const claim = (await store.claim('api-generator', ++clock, 60_000))!;
      if (claim.slot!.feature === 'x_posts') {
        textId = claim.slot!.id;
        assert.equal(await store.saveOutput(claim, result('A source supported public response.'), ++clock), true);
      } else {
        mediaId = claim.slot!.id;
        const images = Array.from({ length: 5 }, (_, slide) => ({ id: `slide-${slide + 1}`, storagePath: assetPath(uid, id, mediaId, claim.attempt, slide + 1), contentType: 'image/png' as const, bytes: 13, width: 1080, height: 1080 }));
        for (const image of images) assets.set(image.storagePath, 'private-image');
        assert.equal(await store.saveOutput(claim, { ...result({ status: 'ok' as const, slides: images.map(() => ({ title: 'Supported lesson', body: 'A practical source explanation.' })) }), assets: images }, ++clock), true);
      }
    }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects/${id}`;
    const request = (suffix: string, owner = uid) => fetch(base + suffix, { headers: { authorization: `Bearer ${owner}` } });
    for (const active of [true, false]) {
      if (!active) clock = paidEnd;
      const response = await request('/outputs');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const raw = await response.text();
      assert.doesNotMatch(raw, /"retention"|"uid"|"funding"|tenureId|promisedUntil|contentFingerprint|storagePath|private-model|private-prompt|accounts\//);
      const outputs = JSON.parse(raw).data;
      assert.equal(outputs.length, 2);
      for (const output of outputs) {
        assert.equal(output.expiresAt, new Date(expiry).toISOString());
        assert.equal(output.retentionMode, active ? 'while_paid' : 'fixed');
        assert.ok(Number.isFinite(Date.parse(output.expiresAt)));
      }
      assert.equal((await (await request(`/outputs/${textId}`)).json()).data.retentionMode, active ? 'while_paid' : 'fixed');
      assert.equal(await (await request(`/outputs/${textId}/download`)).text(), 'A source supported public response.');
      const suffix = `/outputs/${mediaId}/assets/slide-1/download`;
      assert.equal(await (await request(suffix)).text(), 'private-image');
      const reads = assetReads;
      for (const path of ['/outputs', `/outputs/${textId}`, `/outputs/${textId}/download`, suffix]) assert.equal((await request(path, 'other-owner')).status, 404);
      assert.equal(assetReads, reads, 'Another UID must never reach the private asset reader.');
    }
    clock = expiry;
    assert.deepEqual((await (await request('/outputs')).json()).data, []);
    const reads = assetReads;
    for (const suffix of [`/outputs/${textId}`, `/outputs/${textId}/download`, `/outputs/${mediaId}/assets/slide-1/download`]) assert.equal((await request(suffix)).status, 404);
    assert.equal(assetReads, reads, 'Exact expiry must stop private asset I/O before physical cleanup.');
    await projects.remove(uid, id, ++clock);
    assert.equal(await projects.get(uid, id), null);
    assert.equal((await request('/outputs')).status, 404);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const name of ['intakeJobs', 'generationJobs']) {
      const jobs = await db.collection(name).where('uid', '==', uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    const cleanup = await db.collection('assetCleanup').where('owner.uid', '==', uid).get();
    await Promise.all(cleanup.docs.map(doc => doc.ref.delete()));
    await db.recursiveDelete(account);
    await db.collection('subscriptionGrants').doc(uid).delete();
    await db.terminate();
    await deleteApp(app);
  }
});
