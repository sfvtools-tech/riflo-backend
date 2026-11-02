import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { buildCapabilities, creationCreditCosts, featureIds, isGrant, quotaKeys } from '../../src/access/policy.js';
import { planGrant, plans, trialOffering } from '../../src/access/plans.js';
import { grantPeriod } from '../../src/access/accepted-work.js';
import { emptyCounters, readCounters } from '../../src/access/accounting.js';
import { sourcePath } from '../../src/projects/source.js';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { assetPath, videoPath } from '../../src/generation/asset-paths.js';
import { unknownUsage, type AttemptResult, type Selection, type Transcript } from '../../src/generation/service.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const now = Date.parse('2026-10-18T12:00:00Z');
const transcript: Transcript = { text: 'A clear practical idea.', words: [{ text: 'A', start: 0, end: 1 }, { text: 'clear', start: 1, end: 2 }] };
const result = <T>(value: T): AttemptResult<T> => ({ value, usage: unknownUsage(), provider: 'fixture', model: 'fixture', promptVersion: 'fixture', rates: null });
const all: Selection = { x_posts: 1, linkedin_posts: 1, blogs: 1, newsletters: 1, carousels: 1, short_videos: 1 };

async function withAccount(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>, credits = 10) {
  const context = await setup(credits);
  try { await run(context); }
  finally {
    for (const name of ['intakeJobs', 'generationJobs']) {
      const jobs = await context.db.collection(name).where('uid', '==', context.uid).get();
      await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
    }
    const cleanup = await context.db.collection('assetCleanup').where('owner.uid', '==', context.uid).get();
    await Promise.all(cleanup.docs.map(doc => doc.ref.delete()));
    await context.db.recursiveDelete(context.account);
    await context.grantRef.delete();
    await context.db.terminate();
    await deleteApp(context.app);
  }
}

async function setup(credits: number) {
  const uid = `credits-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grantRef = db.collection('subscriptionGrants').doc(uid);
  const grant = planGrant('lower', randomUUID(), new Date(now - 1000).toISOString(), new Date(now + 1_000_000).toISOString());
  grant.limits.creationCredits = credits;
  await grantRef.set(grant);
  const imports = createProjectStore(db);
  const generations = createGenerationStore(db);
  const usage = account.collection('allowances').doc(grantPeriod(grant));
  const imported = async () => {
    const project = await imports.create({ uid, id: randomUUID(), key: randomUUID(), now, input: { fileId: 'source-file' }, source: { fileId: 'source-file', name: 'source.mp4', mimeType: 'video/mp4', bytes: 9, durationSeconds: 30, requiresProbe: true } });
    const claim = await imports.claim('importer', now + 1, 1000) ?? await imports.claim('importer', now + 1, 1000);
    assert.ok(claim);
    assert.equal(claim.project.id, project.id);
    await imports.complete(claim, { bytes: 9, durationSeconds: 30, storagePath: sourcePath(uid, project.id, claim.attempt) }, now + 2);
    // Legacy source-only fixture: these tests retain first-generation ASR accounting coverage.
    await account.collection('projects').doc(project.id).update({ preparation: FieldValue.delete() });
    return project.id;
  };
  const accepted = async (selection: Selection = { x_posts: 1, linkedin_posts: 0 }) => {
    const id = await imported();
    const key = randomUUID();
    const batch = await generations.start(uid, id, key, selection, now + 3);
    const claim = await generations.claim('transcriber', now + 4, 1000);
    assert.ok(claim);
    await generations.saveTranscript(claim, result(transcript), now + 5);
    return { id, batch, key };
  };
  return { uid, app, db, account, grantRef, grant, imports, generations, usage, imported, accepted };
}

test('catalogue and shared grant validation keep stable identity separate from mutable dates', () => {
  assert.deepEqual(plans, { lower: { priceUsd: 39, creationCredits: 120, sourceSeconds: 18000 }, higher: { priceUsd: 69, creationCredits: 250, sourceSeconds: 36000 } });
  assert.deepEqual(trialOffering, { days: 7, creationCredits: 15, sourceSeconds: 2700 });
  assert.equal(Object.values(creationCreditCosts).reduce((sum, cost) => sum + cost, 0), 10);
  const grant = planGrant('higher', 'stable_period', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.ok(isGrant(grant));
  assert.equal(grantPeriod(grant), grantPeriod({ ...grant, expiresAt: '2026-12-01T00:00:00Z' }));
  assert.notEqual(grantPeriod(grant), grantPeriod({ ...grant, allowancePeriodId: 'next_period' }));
  for (const invalid of [{ ...grant, accounting: 'unknown' }, { ...grant, allowancePeriodId: '' }, { ...grant, limits: { sourceSeconds: 100 } }, { ...grant, limits: { ...grant.limits, creationCredits: 1.5 } }]) assert.equal(isGrant(invalid), false);
  const capability = buildCapabilities(grant, new Date(now), featureIds);
  assert.equal(capability.accounting?.mode, 'shared_credits');
  assert.deepEqual(capability.limits, grant.limits);
  assert.equal(capability.operationalLimits.maxSourceSeconds, 1800);
  assert.equal(capability.operationalLimits.maxSourceBytes, 2 * 1024 ** 3);
});

test('counter validation preserves legacy fractions and fails closed for malformed active meters', () => {
  const counters = emptyCounters();
  counters.reserved.sourceSeconds = 1.25;
  assert.equal(readCounters(counters, true).reserved.sourceSeconds, 1.25);
  for (const invalid of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => readCounters({ ...counters, consumed: { ...counters.consumed, creationCredits: invalid } }, true));
  }
  const legacy = { reserved: Object.fromEntries(quotaKeys.map(key => [key, 0])), consumed: Object.fromEntries(quotaKeys.map(key => [key, 0])) };
  assert.equal(readCounters(legacy).consumed.creationCredits, 0);
  assert.throws(() => readCounters(legacy, true));
});

test('all formats reserve ten shared credits; insufficient admission is atomic', local, async () => {
  await withAccount(async ({ uid, generations, imports, imported, usage }) => {
    const id = await imported();
    const batch = await generations.start(uid, id, 'all-formats', all, now + 3);
    assert.equal(batch.slots.reduce((sum, slot) => sum + slot.charge!.credits, 0), 10);
    assert.ok(batch.slots.every(slot => slot.charge!.period === batch.period));
    const ledger = (await usage.get()).data()!;
    assert.equal(ledger.reserved.creationCredits, 10);
    assert.equal(ledger.reserved.carousels, 0);
    assert.equal(ledger.consumed.sourceSeconds, 30);
    const publicUsage = await imports.usage(uid, now);
    assert.deepEqual(Object.keys(publicUsage.limits).sort(), ['creationCredits', 'sourceSeconds']);
    assert.equal(publicUsage.remaining.creationCredits, 0);
  });
  await withAccount(async ({ uid, generations, imported, usage }) => {
    const id = await imported();
    const before = (await usage.get()).data();
    await assert.rejects(generations.start(uid, id, 'insufficient-all', all, now + 3), { code: 'allowance_exceeded' });
    assert.deepEqual((await usage.get()).data(), before);
    assert.equal(await generations.batch(uid, id), null);
  }, 9);
});

test('shared availability and concurrent admission enforce aggregate weighted capacity', local, async () => {
  await withAccount(async ({ uid, generations, imported, usage }) => {
    const first = await imported();
    const second = await imported();
    const available = await generations.availability!(uid, first, now + 3);
    assert.equal(available.credits!.remaining, 2);
    assert.equal(available.outputs.carousels.available, true);
    assert.equal(available.outputs.short_videos.reason, 'allowance_exceeded');
    const outcomes = await Promise.allSettled([first, second].map((id, index) => generations.start(uid, id, `concurrent-${index}`, { x_posts: 0, linkedin_posts: 0, carousels: 1 }, now + 4)));
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal((await usage.get()).data()!.reserved.creationCredits, 2);
  }, 2);
});

test('partial success and terminal failure settle only accepted charges and preserve source consumption', local, async () => {
  await withAccount(async ({ uid, generations, usage, accepted }) => {
    const { id } = await accepted({ x_posts: 1, linkedin_posts: 0, carousels: 1, short_videos: 1 });
    const claim = (await generations.claim('generator', now + 6, 1000))!;
    assert.equal(await generations.saveOutput(claim, result('One useful source post.'), now + 7), true);
    assert.equal(await generations.saveOutput(claim, result('This stale replay cannot charge.'), now + 8), false);
    for (let time = now + 9; time < now + 13; time += 2) {
      const failed = (await generations.claim('generator', time, 1000))!;
      await generations.fail(failed, { ...result(null), code: 'render_failed', retryable: false }, time + 1);
    }
    const counters = (await usage.get()).data()!;
    assert.equal(counters.consumed.creationCredits, 1);
    assert.equal(counters.reserved.creationCredits, 0);
    assert.equal(counters.consumed.sourceSeconds, 30);
    assert.equal((await generations.batch(uid, id))!.status, 'partial');
  });
});

test('successful carousel and video delivery settle frozen weighted credits exactly once', local, async () => {
  await withAccount(async ({ uid, generations, usage, imported }) => {
    const id = await imported();
    const batch = await generations.start(uid, id, 'weighted-delivery', { x_posts: 0, linkedin_posts: 0, carousels: 1, short_videos: 1 }, now + 3);
    assert.deepEqual(batch.slots.map(slot => slot.charge!.credits), [2, 4]);
    assert.equal((await usage.get()).data()!.reserved.creationCredits, 6);
    const transcription = (await generations.claim('transcriber', now + 4, 1000))!;
    await generations.saveTranscript(transcription, result({ text: 'A complete source idea.', words: [{ text: 'A complete', start: 0, end: 5 }, { text: 'source idea.', start: 5, end: 10 }] }), now + 5);
    const previous = { carousels: creationCreditCosts.carousels, short_videos: creationCreditCosts.short_videos };
    creationCreditCosts.carousels = 7;
    creationCreditCosts.short_videos = 9;
    try {
      const carousel = (await generations.claim('carousel-worker', now + 6, 1000))!;
      assert.equal(carousel.slot!.feature, 'carousels');
      const carouselResult = {
        ...result({ status: 'ok' as const, slides: Array.from({ length: 5 }, (_, index) => ({ title: `Source idea ${index + 1}`, body: 'A practical explanation grounded in the source.' })) }),
        assets: Array.from({ length: 5 }, (_, index) => ({ id: `slide-${index + 1}`, storagePath: assetPath(uid, id, carousel.slot!.id, carousel.attempt, index + 1), contentType: 'image/png' as const, bytes: 100, width: 1080, height: 1080 })),
      };
      assert.equal(await generations.saveOutput(carousel, carouselResult, now + 7), true);
      const afterCarousel = (await usage.get()).data()!;
      assert.equal(afterCarousel.reserved.creationCredits, 4);
      assert.equal(afterCarousel.consumed.creationCredits, 2);
      assert.equal(await generations.saveOutput(carousel, carouselResult, now + 8), false);
      assert.deepEqual((await usage.get()).data(), afterCarousel);

      const video = (await generations.claim('video-worker', now + 9, 1000))!;
      assert.equal(video.slot!.feature, 'short_videos');
      const videoResult = {
        ...result({ status: 'ok' as const, startSeconds: 0, endSeconds: 10 }),
        assets: [{ id: 'clip', storagePath: videoPath(uid, id, video.slot!.id, video.attempt), contentType: 'video/mp4' as const, bytes: 123, width: 720, height: 1280, durationSeconds: 10 }],
      };
      assert.equal(await generations.saveOutput(video, videoResult, now + 10), true);
      const afterVideo = (await usage.get()).data()!;
      assert.equal(afterVideo.reserved.creationCredits, 0);
      assert.equal(afterVideo.consumed.creationCredits, 6);
      assert.equal(afterVideo.consumed.sourceSeconds, 30);
      assert.equal(await generations.saveOutput(video, videoResult, now + 11), false);
      assert.deepEqual((await usage.get()).data(), afterVideo);
      assert.equal((await generations.outputs(uid, id, now + 12)).length, 2);
      assert.equal((await generations.batch(uid, id))!.status, 'completed');
    } finally { Object.assign(creationCreditCosts, previous); }
  });
});

test('renewal and price changes cannot move or reprice accepted work; exact replay remains frozen', local, async () => {
  await withAccount(async ({ uid, grantRef, grant, generations, usage, account, accepted }) => {
    const { id, batch, key } = await accepted();
    await grantRef.set({ ...grant, allowancePeriodId: 'renewed_period', limits: { ...grant.limits, creationCredits: 0 } });
    const previous = creationCreditCosts.x_posts;
    creationCreditCosts.x_posts = 7;
    try {
      const claim = (await generations.claim('renewed-worker', now + 6, 1000))!;
      await generations.saveOutput(claim, result('An originally accepted one credit post.'), now + 7);
      assert.equal((await usage.get()).data()!.consumed.creationCredits, 1);
      assert.equal((await account.collection('allowances').doc('shared-renewed_period').get()).exists, false);
      assert.equal((await generations.batch(uid, id))!.slots[0]!.charge!.credits, 1);
      assert.equal(batch.slots[0]!.charge!.credits, 1);
      const replay = await generations.start(uid, id, key, { x_posts: 1, linkedin_posts: 0 }, now + 8);
      assert.equal(replay.id, batch.id);
      assert.equal(replay.slots[0]!.charge!.credits, 1);
      assert.equal((await usage.get()).data()!.consumed.creationCredits, 1);
    } finally { creationCreditCosts.x_posts = previous; }
  });
});

test('retryable output failure retains reservation; terminal retry and duplicate release once', local, async () => {
  await withAccount(async ({ uid, generations, usage, accepted }) => {
    const { id } = await accepted({ x_posts: 2, linkedin_posts: 0 });
    const first = (await generations.claim('generator', now + 6, 1000))!;
    await generations.fail(first, { ...result(null), code: 'temporary', retryable: true }, now + 7);
    assert.equal((await usage.get()).data()!.reserved.creationCredits, 2);
    const retry = (await generations.claim('generator', now + 3000, 1000))!;
    await generations.saveOutput(retry, result('A unique retained source post.'), now + 3001);
    const second = (await generations.claim('generator', now + 3002, 1000))!;
    assert.equal(await generations.saveOutput(second, result('A unique retained source post.'), now + 3003), false);
    assert.equal(await generations.saveOutput(second, result('A unique retained source post.'), now + 3004), false);
    const counters = (await usage.get()).data()!;
    assert.equal(counters.reserved.creationCredits, 0);
    assert.equal(counters.consumed.creationCredits, 1);
    assert.equal((await generations.batch(uid, id))!.status, 'partial');
  });
});

test('deletion with source period A and batch period B releases owning ledger and never refunds source', local, async () => {
  await withAccount(async ({ uid, grantRef, grant, imports, generations, imported, usage, account }) => {
    const id = await imported();
    const next = { ...grant, allowancePeriodId: 'new_generation_period' };
    await grantRef.set(next);
    const batch = await generations.start(uid, id, 'new-period-generation', all, now + 3);
    assert.notEqual((await imports.get(uid, id))!.period, batch.period);
    await imports.remove(uid, id, now + 4);
    await imports.remove(uid, id, now + 5);
    const original = (await usage.get()).data()!;
    const generation = (await account.collection('allowances').doc(grantPeriod(next)).get()).data()!;
    assert.equal(original.consumed.sourceSeconds, 30);
    assert.equal(original.reserved.creationCredits, 0);
    assert.equal(generation.reserved.creationCredits, 0);
    assert.equal(generation.consumed.creationCredits, 0);
  });
});

test('source expiry releases only pending videos while cached-transcript text settles', local, async () => {
  await withAccount(async ({ uid, account, imports, generations, usage, accepted }) => {
    const { id } = await accepted({ x_posts: 1, linkedin_posts: 0, short_videos: 1 });
    await account.collection('projects').doc(id).update({ sourceExpiresAt: now + 6 });
    await imports.remove(uid, id, now + 6, true);
    assert.equal((await usage.get()).data()!.reserved.creationCredits, 1);
    const claim = (await generations.claim('text-worker', now + 7, 1000))!;
    assert.equal(claim.slot!.feature, 'x_posts');
    await generations.saveOutput(claim, result('Text survives source expiry.'), now + 8);
    assert.equal((await usage.get()).data()!.reserved.creationCredits, 0);
    assert.equal((await usage.get()).data()!.consumed.creationCredits, 1);
    assert.equal((await usage.get()).data()!.consumed.sourceSeconds, 30);
  });
});

test('revocation, transcription failure, batch deadline and exhausted attempts release pending credits', local, async () => {
  for (const terminal of ['revoke', 'transcribe', 'deadline', 'attempts']) {
    await withAccount(async ({ uid, grantRef, generations, imported, usage }) => {
      const id = await imported();
      const batch = await generations.start(uid, id, `terminal-${terminal}`, all, now + 3);
      if (terminal === 'revoke') await grantRef.delete();
      if (terminal === 'deadline') {
        assert.equal(await generations.claim('expired-worker', batch.deadline + 1, 1000), null);
      } else if (terminal === 'revoke') {
        assert.equal(await generations.claim('revoked-worker', now + 4, 1000), null);
      } else {
        const claim = (await generations.claim('transcriber', now + 4, 1000))!;
        if (terminal === 'transcribe') await generations.fail(claim, { ...result(null), code: 'transcription_failed', retryable: false }, now + 5);
        else {
          // Lost responses after dispatch exhaust attempts without delivering outputs.
          const metadata = { provider: 'deepgram', model: 'fixture', rates: null };
          assert.equal(await generations.markProviderInvoked(claim, metadata, now + 5), true);
          const replacement1 = (await generations.claim('replacement1', now + 1005, 1000))!;
          assert.ok(replacement1);
          assert.equal(await generations.markProviderInvoked(replacement1, metadata, now + 1006), true);
          const replacement2 = (await generations.claim('replacement2', now + 2006, 1000))!;
          assert.ok(replacement2);
          assert.equal(await generations.markProviderInvoked(replacement2, metadata, now + 2007), true);
          assert.equal(await generations.claim('replacement3', now + 3007, 1000), null);
        }
      }
      assert.equal((await usage.get()).data()!.reserved.creationCredits, 0, terminal);
      assert.equal((await usage.get()).data()!.consumed.creationCredits, 0, terminal);
      assert.equal((await usage.get()).data()!.consumed.sourceSeconds, 30, terminal);
    });
  }
});


test('pending legacy and shared batches retain their original meter across grant mode switches', local, async () => {
  for (const originalMode of ['legacy', 'shared']) {
    await withAccount(async ({ uid, grant, grantRef, account, generations, accepted }) => {
      const legacy = { status: 'active' as const, startsAt: grant.startsAt, expiresAt: grant.expiresAt, features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, key === 'sourceSeconds' ? 1000 : 10])) as import('../../src/access/policy.js').LegacyGrant['limits'] };
      const original = originalMode === 'legacy' ? legacy : grant;
      await grantRef.set(original);
      const { id, batch, key } = await accepted();
      const oldLedger = account.collection('allowances').doc(grantPeriod(original));
      await grantRef.set(originalMode === 'legacy' ? grant : legacy);
      const replacementLedger = account.collection('allowances').doc(grantPeriod(originalMode === 'legacy' ? grant : legacy));
      const before = await replacementLedger.get();
      const claim = (await generations.claim('transition-worker', now + 6, 1000))!;
      assert.equal(await generations.saveOutput(claim, result(`An accepted ${originalMode} post.`), now + 7), true);
      const counters = (await oldLedger.get()).data()!;
      assert.equal(counters.reserved.creationCredits, 0);
      assert.equal(counters.reserved.x_posts, 0);
      assert.equal(counters.consumed[originalMode === 'legacy' ? 'x_posts' : 'creationCredits'], 1);
      assert.equal(counters.consumed[originalMode === 'legacy' ? 'creationCredits' : 'x_posts'], 0);
      assert.equal(counters.consumed.sourceSeconds, 30);
      assert.deepEqual((await replacementLedger.get()).data(), before.data());
      const replay = await generations.start(uid, id, key, { x_posts: 1, linkedin_posts: 0 }, now + 8);
      assert.equal(replay.id, batch.id);
      assert.equal(replay.accounting?.mode, originalMode === 'shared' ? 'shared_credits' : undefined);
    });
  }
});

test('same-period grant correction preserves consumption and accepted charges', local, async () => {
  await withAccount(async ({ uid, grantRef, grant, generations, usage, accepted }) => {
    const { id } = await accepted();
    await grantRef.set({ ...grant, expiresAt: new Date(now + 2_000_000).toISOString(), limits: { ...grant.limits, creationCredits: 20 } });
    const claim = (await generations.claim('upgraded-worker', now + 6, 1000))!;
    await generations.saveOutput(claim, result('A post accepted before a same-period correction.'), now + 7);
    await generations.start(uid, id, 'upgraded-next-batch', { x_posts: 2, linkedin_posts: 0 }, now + 8);
    assert.equal((await usage.get()).data()!.consumed.creationCredits, 1);
    assert.equal((await usage.get()).data()!.reserved.creationCredits, 2);
  });
});

test('malformed shared slot snapshots never authorize a provider call', local, async () => {
  for (const credits of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await withAccount(async ({ uid, db, generations, accepted }) => {
      const { id, batch } = await accepted();
      batch.slots[0]!.charge!.credits = credits;
      await db.collection('accounts').doc(uid).collection('projects').doc(id).collection('generation').doc('batch').update({ slots: batch.slots });
      // Fail closed before claiming provider work; malformed historical charges cannot be inferred.
      await assert.rejects(generations.claim('invalid-worker', now + 6, 1000), /Invalid accepted credit charge/);
    });
  }
});
