import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import { buildCapabilities, featureIds, quotaKeys } from '../../src/access/policy.js';
import { grantPeriod } from '../../src/access/accepted-work.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { applyGenerationConfiguration, type GenerationAvailability } from '../../src/generation/service.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const grant = { status: 'active' as const, startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 10])) as Record<typeof quotaKeys[number], number> };
const projectPath = 'accounts/alice/projects/project-id';

// Only document reads are supported: a new query or account/profile lookup fails here.
function snapshotStore(rawGrant: unknown, extra: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const docs: Record<string, unknown> = {
    [projectPath]: { status: 'source_ready', storagePath: 'source.mp4', sourceExpiresAt: now + 1000, source: { durationSeconds: 1 }, period: 'old-period', reservedSourceSeconds: 1 },
    [`${projectPath}/generation/batch`]: undefined,
    [`${projectPath}/transcripts/shared`]: undefined,
    'subscriptionGrants/alice': rawGrant,
    [`accounts/alice/allowances/${grantPeriod(grant)}`]: { reserved: Object.fromEntries(quotaKeys.map(key => [key, 0])), consumed: Object.fromEntries(quotaKeys.map(key => [key, key === 'x_posts' ? 10 : 0])) },
    ...extra,
  };
  const ref = (path: string): unknown => ({
    collection: (name: string) => ref(`${path}/${name}`),
    doc: (id: string) => ref(`${path}/${id}`),
    get: async () => {
      assert.ok(Object.hasOwn(docs, path), `Unexpected read: ${path}`);
      reads.push(path);
      return { data: () => docs[path] };
    },
  });
  const db = { collection: (name: string) => ref(name) } as unknown as Firestore;
  return { store: createGenerationStore(db), reads };
}

test('availability reuses the grant snapshot and reads usage from the current grant period', async () => {
  const { store, reads } = snapshotStore(grant);
  const availability = await store.availability!('alice', 'project-id', now);
  assert.deepEqual(availability.access, buildCapabilities(grant, new Date(now)).subscription);
  assert.equal(availability.outputs.x_posts.reason, 'allowance_exceeded');
  assert.equal(availability.outputs.linkedin_posts.reason, 'available');
  assert.equal(reads.filter(path => path === 'subscriptionGrants/alice').length, 1);
  assert.deepEqual(reads.filter(path => path.includes('/allowances/')), [`accounts/alice/allowances/${grantPeriod(grant)}`]);
  assert.equal(reads.length, 5);
});

test('inactive access keeps its precise snapshot reason and needs no usage read', async () => {
  for (const rawGrant of [null, { invalid: true }, { ...grant, startsAt: '2026-10-20T00:00:00Z' }, { ...grant, expiresAt: '2026-10-17T00:00:00Z' }]) {
    const { store, reads } = snapshotStore(rawGrant);
    const availability = await store.availability!('alice', 'project-id', now);
    assert.deepEqual(availability.access, buildCapabilities(rawGrant, new Date(now)).subscription);
    assert.equal(availability.outputs.x_posts.reason, 'subscription_required');
    assert.equal(reads.length, 4);
  }
});

test('both configuration boundaries preserve resource denials and cached transcription', () => {
  const snapshot = (): GenerationAvailability => ({
    access: { active: true, reason: 'active', expiresAt: grant.expiresAt },
    sourceAvailable: true, transcriptAvailable: false, sourceExpiresAt: null, transcriptExpiresAt: null, activeBatch: false,
    outputs: Object.fromEntries(featureIds.map(feature => [feature, { available: feature !== 'short_videos', reason: feature === 'short_videos' ? 'requires_reimport' : 'available' }])) as GenerationAvailability['outputs'],
    transcription: { status: 'failed', retryAvailable: true, reason: 'available', errorCode: 'transcription_failed' },
  });
  for (const serviceConfigured of [true, false]) {
    for (const httpConfigured of [true, false]) {
      for (const implemented of [featureIds, []]) {
        const availability = applyGenerationConfiguration(snapshot(), { configured: serviceConfigured });
        applyGenerationConfiguration(availability, { configured: httpConfigured, implementedFeatures: implemented });
        const configured = serviceConfigured && httpConfigured;
        assert.deepEqual(availability.outputs.x_posts, configured
          ? { available: implemented.length > 0, reason: implemented.length ? 'available' : 'feature_not_implemented' }
          : { available: false, reason: 'generation_not_configured' });
        assert.deepEqual(availability.outputs.short_videos, { available: false, reason: 'requires_reimport' });
        assert.deepEqual(availability.transcription, { status: 'failed', retryAvailable: configured, reason: configured ? 'available' : 'generation_not_configured', errorCode: 'transcription_failed' });
      }
    }
  }
  for (const reason of ['subscription_required', 'feature_not_in_plan', 'generation_in_progress', 'allowance_exceeded', 'transcription_not_retryable']) {
    const availability = snapshot();
    availability.outputs.x_posts = { available: false, reason };
    availability.transcription = { status: 'ready', retryAvailable: false, reason: 'transcript_ready' };
    applyGenerationConfiguration(availability, { configured: false, implementedFeatures: [] });
    assert.deepEqual(availability.outputs.x_posts, { available: false, reason });
    assert.deepEqual(availability.transcription, { status: 'ready', retryAvailable: false, reason: 'transcript_ready' });
  }
});
