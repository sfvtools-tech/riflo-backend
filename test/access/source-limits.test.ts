import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedSourceLimits, legacySourceLimits, resolveSourceLimits, sourceAudioBytes, sourcePlanLimits } from '../../src/access/source-limits.js';
import { startTrial, transitionLifecycle } from '../../src/access/lifecycle.js';
import { buildCapabilities } from '../../src/access/policy.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const trial = () => startTrial(null, 'trial-period', now);
const paid = (plan: 'lower' | 'higher') => transitionLifecycle(trial(), { type: 'activate_paid', expectedRevision: 1, plan, periodId: 'paid-period', startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString() }, now);

test('source caps follow active paid authorization independently of trial-first funding and next plan', () => {
  assert.deepEqual(resolveSourceLimits(null, now), sourcePlanLimits.trial);
  assert.deepEqual(resolveSourceLimits(trial(), now), sourcePlanLimits.trial);
  for (const plan of ['lower', 'higher'] as const) {
    const record = paid(plan);
    assert.deepEqual(resolveSourceLimits(record, now), sourcePlanLimits[plan]);
    assert.equal(buildCapabilities(record, new Date(now)).operationalLimits.maxSourceBytes, sourcePlanLimits[plan].maxSourceBytes);
    assert.equal(buildCapabilities(record, new Date(now)).operationalLimits.maxSourceSeconds, sourcePlanLimits[plan].maxSourceSeconds);
    assert.equal(record.trial!.limits.sourceSeconds, 2700);
    assert.equal(record.paid!.grant.limits.sourceSeconds, plan === 'lower' ? 18000 : 36000);
    if (plan === 'higher') assert.deepEqual(resolveSourceLimits(transitionLifecycle(record, { type: 'downgrade', expectedRevision: 2 }, now), now), sourcePlanLimits.higher);
    record.paid!.grant.expiresAt = new Date(now + 1000).toISOString();
    assert.deepEqual(resolveSourceLimits(record, now + 1000), sourcePlanLimits.trial);
    record.paid!.grant.startsAt = new Date(now + 2000).toISOString();
    record.paid!.grant.expiresAt = new Date(now + 3000).toISOString();
    assert.deepEqual(resolveSourceLimits(record, now + 1000), sourcePlanLimits.trial);
  }
  assert.deepEqual(resolveSourceLimits({ ...trial(), withdrawn: true }, now), legacySourceLimits);
  assert.deepEqual(resolveSourceLimits(trial(), now + 7 * 86400000), legacySourceLimits);
  assert.deepEqual(resolveSourceLimits(trial().trial, now), legacySourceLimits, 'manual grants cannot infer a paid tier from allowance totals');
});

test('historical caps stay fixed and corrupt explicit accepted caps fail closed', () => {
  assert.deepEqual(acceptedSourceLimits({}), legacySourceLimits);
  for (const value of [null, {}, [], { maxSourceSeconds: 3601, maxSourceBytes: 1 }, { maxSourceSeconds: 1, maxSourceBytes: 6000000001 }, { maxSourceSeconds: 1.5, maxSourceBytes: 1 }, { ...sourcePlanLimits.higher, injected: true }]) assert.throws(() => acceptedSourceLimits({ sourceLimits: value as any }));
  const snapshot = { ...sourcePlanLimits.higher };
  assert.deepEqual(acceptedSourceLimits({ sourceLimits: snapshot }), snapshot);
  assert.equal(sourceAudioBytes(snapshot), 115264000);
  assert.equal(sourceAudioBytes(sourcePlanLimits.lower), 86464000);
});
