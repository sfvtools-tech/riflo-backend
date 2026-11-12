import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createDevelopmentAccess } from '../../src/access/development-access.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createIntakeWorker } from '../../src/projects/worker.js';
import { sourcePath } from '../../src/projects/source.js';
import type { Project } from '../../src/projects/service.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const emulator = { skip: !process.env.FIRESTORE_EMULATOR_HOST };

async function withDatabase(run: (context: { db: ReturnType<typeof getFirestore>; uid: string }) => Promise<void>) {
  const uid = `retention-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo-retention' }, uid);
  const db = getFirestore(app);
  try { await run({ db, uid }); }
  finally {
    const cleanup = await db.collection('assetCleanup').where('ownerFixture', '==', uid).get();
    await Promise.all(cleanup.docs.map((doc) => doc.ref.delete()));
    const owned = await db.collection('assetCleanup').where('owner.uid', '==', uid).get();
    await Promise.all(owned.docs.map(doc => doc.ref.delete()));
    const jobs = await db.collection('intakeJobs').where('uid', '==', uid).get();
    await Promise.all(jobs.docs.map((doc) => doc.ref.delete()));
    await db.recursiveDelete(db.collection('accounts').doc(uid));
    await db.collection('subscriptionGrants').doc(uid).delete();
    await db.terminate();
    await deleteApp(app);
  }
}

test('the worker runs output retention even when generation credentials are absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-worker-retention-test-'));
  const loader = join(directory, 'fixtures.mjs');
  const events = join(directory, 'events.json');
  const firebase = `import{writeFileSync}from'node:fs';const events=[];process.on('exit',()=>writeFileSync(${JSON.stringify(events)},JSON.stringify(events)));export function createFirebaseIntakeWorker(){return{sources:{drive:{configured:true}},cleanup:async()=>events.push('source-cleanup'),runOnce:async()=>{process.kill(process.pid,'SIGTERM');await new Promise(resolve=>setImmediate(resolve));return true}}}export function createFirebaseGenerationWorker(){return{cleanup:async()=>events.push('output-cleanup'),runOnce:async()=>false}}export function createFirebaseGenerationCleanup(){return{cleanup:async()=>events.push('output-cleanup')}}`;
  await writeFile(loader, `import{registerHooks}from'node:module';const modules=${JSON.stringify({ './firebase.js': firebase, './projects/adapters.js': 'export async function verifyVideoProbe(){}', './projects/source.js': 'export async function cleanupAbandonedSources(){}' })};registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/src/worker.ts')&&modules[specifier])return{url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};return next(specifier,context)}});`);
  const env = { ...process.env, NODE_ENV: 'test', FIREBASE_PROJECT_ID: 'demo-riflo-retention', FIREBASE_STORAGE_BUCKET: 'demo-riflo-retention.appspot.com', FFPROBE_PATH: '/not-invoked' };
  for (const name of ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'YT_DLP_PATH', 'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REDIRECT_URI', 'DRIVE_TOKEN_ENCRYPTION_KEY']) delete env[name as keyof typeof env];
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', loader, 'src/worker.ts'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const called = JSON.parse(await readFile(events, 'utf8'));
    assert.ok(called.includes('source-cleanup'));
    assert.ok(called.includes('output-cleanup'), 'Disabling new generation must not disable existing output cleanup.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fifty failing asset deletions do not starve a later deletable entry across cleanup passes', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    const write = db.batch();
    for (let index = 0; index <= 50; index++) write.set(db.collection('assetCleanup').doc(`${uid}-${String(index).padStart(3, '0')}`), { ownerFixture: uid, paths: [sourcePath(uid, index === 50 ? 'deletable' : `blocked-${index}`, 1, 'mp4')], createdAt: now });
    await write.commit();
    const removed: string[] = [];
    const store = createGenerationStore(db, { remove: async (path) => { if (path.includes('/projects/blocked-')) throw Error('Persistent fixture deletion failure.'); removed.push(path); } });
    for (let pass = 0; pass < 3; pass++) await store.cleanup(now);
    assert.ok(removed.some(path => path.includes('/projects/deletable/')), 'A later healthy entry must make progress despite an earlier failed page.');
    const remaining = await db.collection('assetCleanup').where('ownerFixture', '==', uid).get();
    assert.equal(remaining.size, 50, 'Failed deletions must remain queued for later retries.');
  });
});

test('fifty failing source deletions do not starve a later expired source across cleanup passes', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    await createLifecycleStore(db).startTrial(uid, now - 15 * 86_400_000);
    const write = db.batch();
    for (let index = 0; index <= 50; index++) {
      const id = index === 50 ? 'deletable' : `blocked-${index}`;
      const project: Project = { id, uid, input: { fileId: 'fixture-video' }, source: { fileId: 'fixture-video', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 10, requiresProbe: false }, status: 'source_ready', attempts: 0, storagePath: sourcePath(uid, index === 50 ? 'deletable' : `blocked-${index}`, 1, 'mp4'), createdAt: now - 1000, updatedAt: now - 1000, deadline: now, sourceExpiresAt: index === 50 ? now - 1 : now - 2, sourceCleanupAt: now - 1, sourceRetention: { version: 1, kind: 'trial', startsAt: now - 15 * 86_400_000, promisedUntil: index === 50 ? now - 1 : now - 2 }, errorCode: null, period: 'fixture-period', reservedSourceSeconds: 0 };
      write.set(db.collection('accounts').doc(uid).collection('projects').doc(id), project);
    }
    await write.commit();
    const removed: string[] = [];
    const worker = createIntakeWorker({ store: createProjectStore(db), now: () => now, importSource: async () => { throw Error('Cleanup must not import.'); }, deleteSource: async (path) => { if (path.includes('/projects/blocked-')) throw Error('Persistent fixture deletion failure.'); removed.push(path); } });
    const assets = createGenerationStore(db, { remove: async (path) => { if (path.includes('/projects/blocked-')) throw Error('Persistent fixture deletion failure.'); removed.push(path); } });
    for (let pass = 0; pass < 3; pass++) { await worker.cleanup(); await assets.cleanup(now); }
    assert.ok(removed.some(path => path.includes('/projects/deletable/')), 'A later expired source must make progress despite an earlier failed page.');
    const remaining = await db.collection('accounts').doc(uid).collection('projects').where('sourceExpiresAt', '<=', now).get();
    assert.equal(remaining.size, 51, 'Original finite source deadlines remain as history.');
    assert.ok(remaining.docs.every(doc => doc.data().storagePath === null), 'Logical expiry removes every canonical payload reference.');
    for (let pass = 0; pass < 3; pass++) await assets.cleanup(now + 15_000);
    const pending = await db.collection('assetCleanup').where('owner.uid', '==', uid).get();
    assert.equal(pending.size, 50, 'Failed physical deletions retain durable manifests.');
  });
});

test('newly discovered expired sources behind the cursor are reached while failed cleanup keeps retrying', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    let clock = now;
    await createLifecycleStore(db).startTrial(uid, now - 15 * 86_400_000);
    const projects = db.collection('accounts').doc(uid).collection('projects');
    const expired = (id: string, storagePath: string, sourceExpiresAt: number): Project => ({ id, uid, input: { fileId: 'fixture-video' }, source: { fileId: 'fixture-video', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 10, requiresProbe: false }, status: 'source_ready', attempts: 0, storagePath, createdAt: now - 1000, updatedAt: now - 1000, deadline: now, sourceExpiresAt, sourceCleanupAt: sourceExpiresAt, sourceRetention: { version: 1, kind: 'trial', startsAt: now - 15 * 86_400_000, promisedUntil: sourceExpiresAt }, errorCode: null, period: 'fixture-period', reservedSourceSeconds: 0 });
    const write = db.batch();
    for (let index = 0; index < 50; index++) write.set(projects.doc(`blocked-${index}`), expired(`blocked-${index}`, sourcePath(uid, `blocked-${index}`, 1, 'mp4'), now - 100));
    await write.commit();
    const removed: string[] = [];
    const worker = createIntakeWorker({ store: createProjectStore(db), now: () => clock, importSource: async () => { throw Error('Cleanup must not import.'); }, deleteSource: async (path) => { if (path.includes('/projects/blocked-')) throw Error('Persistent fixture deletion failure.'); removed.push(path); } });
    const assets = createGenerationStore(db, { remove: async path => { if (path.includes('/projects/blocked-')) throw Error('Persistent fixture deletion failure.'); removed.push(path); } });
    await worker.cleanup(); await assets.cleanup(clock);
    assert.equal((await projects.doc('blocked-0').get()).data()!.sourceExpiresAt, now - 100, 'Retrying deletion must not extend the source expiry.');
    // A later discovery can have an earlier expiry than the already scanned page.
    await projects.doc('newly-discovered').set(expired('newly-discovered', sourcePath(uid, 'deletable', 1, 'mp4'), now - 200));
    for (let pass = 0; pass < 3; pass++) { clock++; await worker.cleanup(); await assets.cleanup(clock); }
    assert.ok(removed.some(path => path.includes('/projects/deletable/')), 'Failed retries must not move the pagination boundary forever ahead of new cleanup work.');
    assert.equal((await projects.where('sourceExpiresAt', '<=', clock).get()).size, 51);
    assert.equal((await projects.doc('newly-discovered').get()).data()!.storagePath, null);
  });
});

test('cleanup preserves a permanent import failure while removing abandoned source files', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    await createDevelopmentAccess(db, uid, { status: 'active', startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, 1800])) }, now);
    const store = createProjectStore(db);
    const project = await store.create({ uid, id: randomUUID(), key: 'failed-import-key', now, input: { fileId: 'fixture-video' }, source: { fileId: 'fixture-video', name: 'Video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 10, requiresProbe: true } });
    const claim = await store.claim('fixture-worker', now, 1000);
    assert.ok(claim);
    await store.fail(claim, { code: 'youtube_video_restricted', retryable: false, bytes: 0 }, now + 1);
    assert.equal((await store.get(uid, project.id))!.status, 'failed');
    const removed: string[] = [];
    const worker = createIntakeWorker({ store, now: () => now + 2, importSource: async () => { throw Error('Cleanup must not import.'); }, deleteSource: async (path) => { removed.push(path); } });
    await worker.cleanup();
    const assets = createGenerationStore(db, { remove: async path => { removed.push(path); } });
    for (let pass = 0; pass < 3; pass++) await assets.cleanup(now + 2);
    const saved = (await store.get(uid, project.id))!;
    assert.equal(saved.status, 'failed', 'Retention must preserve the reason the import never succeeded.');
    assert.equal(saved.errorCode, 'youtube_video_restricted');
    assert.equal(saved.sourceExpiresAt, now + 1);
    assert.equal(saved.storagePath, null);
    assert.ok(removed.includes(sourcePath(uid, project.id, 1)));
    assert.ok(removed.includes(sourcePath(uid, project.id, 1, 'mp4')));
    const firstPass = [...removed];
    await worker.cleanup();
    assert.deepEqual(removed, firstPass, 'Completed cleanup must not requeue a failed import.');
    assert.equal((await store.usage(uid, now + 2) as any).reserved.sourceSeconds, 0);
  });
});


test('user deletion purges more than one page of every private child collection before removing the parent', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    const ref = db.collection('accounts').doc(uid).collection('projects').doc('bounded-purge');
    await ref.set({ uid, id: ref.id, status: 'deleted', payloadCleanupPending: true, input: { fileId: 'private-source-id' } });
    const kinds = ['outputs', 'transcripts', 'generation', 'generationRequests'];
    const write = db.batch();
    for (const kind of kinds) for (let index = 0; index < 61; index++) write.set(ref.collection(kind).doc(String(index)), { privatePayload: 'must be removed', cleanupAt: null, snapshotCleanupAt: null });
    await write.commit();
    const store = createGenerationStore(db);
    await store.cleanup(now);
    assert.equal((await ref.get()).exists, true, 'Parent must remain until all private child pages are gone.');
    for (const kind of kinds) assert.equal((await ref.collection(kind).get()).size, 11);
    await store.cleanup(now + 1);
    for (const kind of kinds) assert.equal((await ref.collection(kind).get()).empty, true);
    await store.cleanup(now + 2);
    assert.equal((await ref.get()).exists, false);
  });
});


test('failed logical cleanup advances past a full page and still runs other cleanup stages', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    const day = 86_400_000;
    await createLifecycleStore(db).startTrial(uid, now - 31 * day);
    const project = db.collection('accounts').doc(uid).collection('projects').doc('logical-cleanup');
    await project.set({ uid, id: project.id, status: 'source_expired' });
    const outputs = project.collection('outputs');
    const retention = { version: 1, kind: 'trial', startsAt: now - 31 * day, promisedUntil: now - day };
    const write = db.batch();
    for (let index = 0; index < 50; index++) write.set(outputs.doc(`blocked-${index}`), { retention, expiresAt: now - day, cleanupAt: now - 2, assets: {} });
    write.set(outputs.doc('healthy'), { retention, expiresAt: now - day, cleanupAt: now - 1, assets: [] });
    write.set(project.collection('generation').doc('batch'), { snapshotRetention: retention, snapshotCleanupAt: now - 1, brand: { private: 'remove' } });
    const deleted = project.parent.doc('deleted-project');
    write.set(deleted, { uid, id: deleted.id, status: 'deleted', payloadCleanupPending: true });
    const path = sourcePath(uid, 'abandoned', 1, 'mp4');
    write.set(db.collection('assetCleanup').doc(`${uid}-abandoned`), { paths: [path], nextCheckAt: now, ownerFixture: uid });
    await write.commit();
    const removed: string[] = [];
    const store = createGenerationStore(db, { remove: async value => { removed.push(value); } });
    await store.cleanup(now);
    assert.equal((await outputs.doc('healthy').get()).exists, true, 'The first pass remains bounded to fifty outputs.');
    assert.equal((await project.collection('generation').doc('batch').get()).data()!.brand, undefined);
    assert.equal((await deleted.get()).exists, false);
    assert.deepEqual(removed, [path], 'Logical failures must not block physical cleanup.');
    await store.cleanup(now);
    assert.equal((await outputs.doc('healthy').get()).exists, false, 'The cursor must reach work behind the failing page.');
    assert.equal((await outputs.get()).size, 50, 'Failed transactions must leave their payloads intact.');
    await outputs.doc('blocked-0').update({ assets: [] });
    await store.cleanup(now);
    assert.equal((await outputs.doc('blocked-0').get()).exists, false, 'Wrapping retries earlier failures after they recover.');
  });
});

test('failed source cleanup advances past a full page and retries after wrapping', emulator, async () => {
  await withDatabase(async ({ db, uid }) => {
    const projects = db.collection('accounts').doc(uid).collection('projects');
    const write = db.batch();
    for (let index = 0; index < 51; index++) {
      const id = index === 50 ? 'healthy' : `blocked-${index}`;
      write.set(projects.doc(id), { uid, id, sourceCleanupAt: index === 50 ? now - 1 : now - 2, attempts: 1, sourceExpiresAt: now - 1 });
    }
    await write.commit();
    const store = createProjectStore(db);
    const seen: string[] = [];
    let recovered = false;
    store.remove = async (_uid, id) => {
      seen.push(id);
      if (id.startsWith('blocked') && !recovered) throw new Error('Injected transaction failure');
      await projects.doc(id).update({ sourceCleanupAt: null });
      return null;
    };
    const worker = createIntakeWorker({ store, now: () => now, importSource: async () => { throw new Error('Not importing'); } });
    await worker.cleanup();
    assert.equal(seen.includes('healthy'), false);
    await worker.cleanup();
    assert.equal(seen.includes('healthy'), true);
    recovered = true;
    await worker.cleanup();
    assert.equal((await projects.where('sourceCleanupAt', '<=', now).get()).size, 0);
    assert.equal(seen.filter(id => id === 'blocked-0').length, 2);
  });
});
