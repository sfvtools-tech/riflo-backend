import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { priorOutputContext } from '../../src/generation/history.js';
import { sourcePath } from '../../src/projects/source.js';
import { videoPath } from '../../src/generation/asset-paths.js';
import { unknownUsage, type AttemptResult, type GenerationValue, type Selection, type Transcript } from '../../src/generation/service.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const transcript: Transcript = { text: 'A source supported practical lesson.', words: [{ text: 'A lesson.', start: 0, end: 20 }] };
const result = <T>(value: T): AttemptResult<T> => ({ value, provider: 'fixture', model: 'fixture', promptVersion: 'fixture', usage: unknownUsage(), rates: null });

async function fixture() {
  const uid = `retention-integration-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grant = db.collection('subscriptionGrants').doc(uid);
  let clock = start;
  const lifecycle = createLifecycleStore(db, { retentionEnabled: true, now: () => clock });
  const projects = createProjectStore(db);
  const removed: string[] = [];
  const generation = createGenerationStore(db, { remove: async path => { removed.push(path); } });
  const tick = () => ++clock;
  const activate = async (type: 'activate_paid' | 'renew', endsAt: number) => {
    const current = await lifecycle.get(uid) as { revision: number } | null;
    return lifecycle.transition(uid, randomUUID(), { type, expectedRevision: current?.revision ?? 0, plan: 'lower', periodId: randomUUID(), startsAt: iso(clock), expiresAt: iso(endsAt) });
  };
  const imported = async () => {
    const project = await projects.create({ uid, id: randomUUID(), key: randomUUID(), now: tick(), input: { fileId: 'fixture-source' }, source: { fileId: 'fixture-source', name: 'Private original', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true } });
    const claim = await projects.claim('retention-importer', tick(), 60_000);
    assert.ok(claim);
    assert.equal(claim.project.id, project.id);
    const source = { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, claim.attempt), sourceSha256: 'a'.repeat(64) };
    const preparation = (await generation.claimImport!(claim, source, tick()))!;
    assert.equal(await generation.saveTranscript(preparation, result(transcript), tick()), true);
    const importedAt = tick();
    assert.equal(await projects.complete(claim, source, importedAt), true);
    return { project: (await projects.get(uid, project.id))!, importedAt, ref: account.collection('projects').doc(project.id) };
  };
  const accepted = async (projectId: string, selection: Selection = { x_posts: 1, linkedin_posts: 0 }) => {
    await generation.start(uid, projectId, randomUUID(), selection, tick());
    let claim = await generation.claim('retention-generator', tick(), 60_000);
    assert.ok(claim);
    if (claim.stage === 'transcribe') {
      assert.equal(await generation.saveTranscript(claim, result(transcript), tick()), true);
      claim = await generation.claim('retention-generator', tick(), 60_000);
      assert.ok(claim);
    }
    assert.equal(claim.stage, 'generate');
    return claim;
  };
  const delivered = async (projectId: string, value: GenerationValue = 'A source supported practical lesson.') => {
    const claim = await accepted(projectId);
    assert.equal(await generation.saveOutput(claim, result(value), tick()), true);
    return claim.slot!.id;
  };
  return { uid, db, account, grant, lifecycle, projects, generation, removed, imported, accepted, delivered, activate, tick, now: () => clock, setNow: (value: number) => { clock = value; }, async close() {
    for (const name of ['intakeJobs', 'generationJobs']) {
      const jobs = await db.collection(name).where('uid', '==', uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    const cleanup = await db.collection('assetCleanup').get();
    await Promise.all(cleanup.docs.filter(doc => doc.data().uid === uid || doc.data().paths?.some((path: string) => path.startsWith(`accounts/${uid}/`))).map(doc => doc.ref.delete()));
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

test('later trial imports and deliveries retain the first initiation day fourteen and thirty clocks', local, async () => {
  await withFixture(async ({ uid, lifecycle, imported, delivered, generation, setNow }) => {
    await lifecycle.startTrial(uid, start);
    const first = await imported();
    setNow(start + 6 * day);
    const later = await imported();
    assert.equal(first.project.sourceExpiresAt, start + 14 * day);
    assert.equal(later.project.sourceExpiresAt, start + 14 * day);
    const outputId = await delivered(later.project.id);
    const saved = (await later.ref.collection('outputs').doc(outputId).get()).data()!;
    const savedTranscript = (await later.ref.collection('transcripts').doc('shared').get()).data()!;
    assert.equal(saved.expiresAt, start + 30 * day);
    assert.equal(savedTranscript.expiresAt, start + 30 * day);
    assert.equal((await generation.availability!(uid, later.project.id, start + 14 * day)).sourceAvailable, false);
    assert.ok(await generation.output(uid, later.project.id, outputId, start + 30 * day - 1));
    assert.equal(await generation.output(uid, later.project.id, outputId, start + 30 * day), null);
  });
});

test('paid source uses successful import plus sixty days while renewed transcripts permit fresh text work', local, async () => {
  await withFixture(async ({ uid, activate, imported, delivered, generation, setNow, now }) => {
    await activate('activate_paid', start + 30 * day);
    const { project, importedAt } = await imported();
    const outputId = await delivered(project.id);
    assert.equal(project.importedAt, importedAt);
    assert.equal(project.sourceExpiresAt, importedAt + 60 * day);
    setNow(start + 30 * day);
    await activate('renew', start + 100 * day);
    setNow(importedAt + 60 * day);
    const availability = await generation.availability!(uid, project.id, now());
    assert.equal(availability.sourceAvailable, false);
    assert.equal(availability.transcriptAvailable, true);
    assert.equal(availability.outputs.x_posts.available, true);
    assert.equal(availability.outputs.short_videos.available, false);
    assert.equal((await generation.output(uid, project.id, outputId, now()))!.expiresAt, start + 160 * day);
    await delivered(project.id, 'Another independently supported lesson.');
  });
});

test('source-only expiry preserves accepted text work and source metadata while releasing source-dependent slots once', local, async () => {
  await withFixture(async ({ uid, activate, imported, delivered, accepted, projects, generation, setNow, tick, now }) => {
    await activate('activate_paid', start + 100 * day);
    const { project, importedAt } = await imported();
    await delivered(project.id);
    const expiresAt = importedAt + 60 * day;
    setNow(expiresAt - 100);
    const claim = await accepted(project.id, { x_posts: 1, linkedin_posts: 0, short_videos: 1 });
    assert.equal(claim.slot!.feature, 'x_posts');
    setNow(expiresAt);
    await projects.remove(uid, project.id, now(), true);
    const saved = (await projects.get(uid, project.id))!;
    assert.equal(saved.status, 'source_expired');
    assert.equal(saved.storagePath, null);
    assert.deepEqual(saved.input, project.input, 'Original source identity survives source-only expiry.');
    assert.equal(await generation.saveOutput(claim, result('Another retained transcript lesson.'), tick()), true);
    const batch = (await generation.batch(uid, project.id))!;
    assert.equal(batch.status, 'partial');
    assert.equal(batch.slots.find(slot => slot.feature === 'short_videos')!.errorCode, 'source_expired');
    assert.equal(batch.slots.find(slot => slot.feature === 'x_posts')!.status, 'ready');
    const usage = await projects.usage(uid, now());
    assert.equal(usage.reserved.creationCredits, 0);
    assert.equal(usage.consumed.creationCredits, 2);
    assert.equal(usage.consumed.sourceSeconds, 30);
    await projects.remove(uid, project.id, tick(), true);
    assert.deepEqual(await projects.usage(uid, now()), usage);
  });
});

test('promotion and renewal agree across saved reads, assets, history and transactional duplicate detection after raw expiry', local, async () => {
  await withFixture(async ({ uid, lifecycle, imported, accepted, generation, removed, activate, setNow, tick, now }) => {
    await lifecycle.startTrial(uid, start);
    const { project, ref } = await imported();
    const clip = await accepted(project.id, { x_posts: 0, linkedin_posts: 0, short_videos: 1 });
    const path = videoPath(uid, project.id, clip.slot!.id, clip.attempt);
    assert.equal(await generation.saveOutput(clip, { ...result({ status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 20 }] }), assets: [{ id: 'clip', storagePath: path, contentType: 'video/mp4', bytes: 9, durationSeconds: 20, width: 720, height: 1280 }] }, tick()), true);
    const outputId = clip.slot!.id;
    const raw = (await ref.collection('outputs').doc(outputId).get()).data()!;
    assert.equal(raw.expiresAt, start + 30 * day);
    setNow(start + 5 * day);
    await activate('activate_paid', start + 35 * day);
    setNow(start + 35 * day);
    await activate('renew', start + 65 * day);
    setNow(start + 40 * day);
    const listed = await generation.outputs(uid, project.id, now());
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.expiresAt, start + 125 * day);
    assert.ok(await generation.output(uid, project.id, outputId, now()));
    assert.equal((await generation.asset(uid, project.id, outputId, 'clip', now()))!.storagePath, path);
    assert.ok(await generation.transcript(uid, project.id, now()));
    assert.deepEqual(priorOutputContext(listed, 'short_videos', now()).previous_outputs, [{ segments: [{ startSeconds: 0, endSeconds: 20 }] }]);
    const duplicate = await accepted(project.id, { x_posts: 0, linkedin_posts: 0, short_videos: 1 });
    assert.equal(await generation.saveOutput(duplicate, { ...result({ status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 20 }] }), assets: [{ id: 'clip', storagePath: videoPath(uid, project.id, duplicate.slot!.id, duplicate.attempt), contentType: 'video/mp4', bytes: 9, durationSeconds: 20, width: 720, height: 1280 }] }, tick()), false);
    assert.equal((await generation.batch(uid, project.id))!.slots[0]!.errorCode, 'duplicate_generated_output');
    assert.equal((await ref.collection('outputs').doc(outputId).get()).data()!.expiresAt, raw.expiresAt, 'Renewal must not rewrite stored output deadlines.');
  });
});

test('promotion racing an expiry pass never leaves a readable asset scheduled or physically deleted', local, async () => {
  await withFixture(async ({ uid, db, lifecycle, imported, accepted, generation, removed, activate, setNow, tick }) => {
    await lifecycle.startTrial(uid, start);
    const { project } = await imported();
    const claim = await accepted(project.id, { x_posts: 0, linkedin_posts: 0, short_videos: 1 });
    const path = videoPath(uid, project.id, claim.slot!.id, claim.attempt);
    assert.equal(await generation.saveOutput(claim, { ...result({ status: 'ok' as const, segments: [{ startSeconds: 0, endSeconds: 20 }] }), assets: [{ id: 'clip', storagePath: path, contentType: 'video/mp4', bytes: 9, durationSeconds: 20, width: 720, height: 1280 }] }, tick()), true);
    setNow(start + 30 * day - 1);
    await Promise.all([activate('activate_paid', start + 60 * day), generation.cleanup(start + 30 * day)]);
    // Cleanup has the exact-expiry observation; activation was accepted just before it.
    // Either transaction can win, but physical deletion must agree with visibility.
    await generation.cleanup(start + 30 * day + 1);
    const visible = await generation.output(uid, project.id, claim.slot!.id, start + 30 * day + 1);
    if (visible) {
      assert.equal(removed.includes(path), false);
      const manifests = await db.collection('assetCleanup').get();
      assert.equal(manifests.docs.some(doc => doc.data().paths?.includes(path)), false, 'A surviving asset cannot have an irreversible deletion manifest.');
    }
    else {
      assert.equal(await generation.asset(uid, project.id, claim.slot!.id, 'clip', start + 30 * day + 1), null);
    }
  });
});

test('cleanup preserves promoted content selected by its older raw trial deadline', local, async () => {
  await withFixture(async ({ uid, lifecycle, imported, delivered, generation, activate, setNow, now }) => {
    await lifecycle.startTrial(uid, start);
    const { project } = await imported();
    const outputId = await delivered(project.id);
    setNow(start + 5 * day);
    await activate('activate_paid', start + 65 * day);
    setNow(start + 40 * day);
    assert.ok(await generation.output(uid, project.id, outputId, now()));
    await generation.cleanup(now());
    assert.ok(await generation.output(uid, project.id, outputId, now()), 'An expired raw query candidate must survive cleanup under authoritative paid facts.');
    assert.ok(await generation.transcript(uid, project.id, now()), 'Retained transcripts need the same cleanup authority.');
  });
});

test('activation at the exact trial content deadline cannot restore pending-cleanup content', local, async () => {
  await withFixture(async ({ uid, lifecycle, imported, delivered, generation, activate, setNow, now }) => {
    await lifecycle.startTrial(uid, start);
    const { project } = await imported();
    const outputId = await delivered(project.id);
    setNow(start + 30 * day);
    await activate('activate_paid', start + 60 * day);
    assert.equal(await generation.output(uid, project.id, outputId, now()), null);
    assert.deepEqual(await generation.outputs(uid, project.id, now()), []);
    assert.equal(await generation.transcript(uid, project.id, now()), null);
    const availability = await generation.availability!(uid, project.id, now());
    assert.equal(availability.sourceAvailable, false);
    assert.equal(availability.transcriptAvailable, false);
  });
});

test('user deletion and a late accepted save serialize without exposing or reviving deleted output', local, async () => {
  await withFixture(async ({ uid, account, activate, imported, accepted, generation, projects, now, tick }) => {
    await activate('activate_paid', start + 30 * day);
    const { project } = await imported();
    const claim = await accepted(project.id);
    const at = tick();
    const [, saved] = await Promise.all([projects.remove(uid, project.id, at), generation.saveOutput(claim, result('Late content.'), at)]);
    assert.equal(await projects.get(uid, project.id), null);
    assert.equal(await generation.output(uid, project.id, claim.slot!.id, now()), null);
    await assert.rejects(generation.outputs(uid, project.id, now()), { code: 'project_not_found' });
    assert.equal(await generation.transcript(uid, project.id, now()), null);
    assert.equal(await generation.saveOutput(claim, result('Late content.'), tick()), false);
    const usage = await projects.usage(uid, now());
    assert.equal(usage.reserved.creationCredits, 0);
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(usage.consumed.sourceSeconds, 30, 'Deleting content never refunds its successful import.');
    assert.equal(usage.consumed.creationCredits, saved ? 1 : 0, 'Only a committed delivery consumes the original creation reservation.');
    await projects.remove(uid, project.id, tick());
    assert.deepEqual(await projects.usage(uid, now()), usage, 'Replayed deletion and discarded saves cannot release or consume original funding twice.');
    const finalBatch = (await account.collection('projects').doc(project.id).collection('generation').doc('batch').get()).data()!;
    assert.ok(finalBatch.slots.every((slot: { status: string }) => slot.status !== 'pending'));
  });
});
