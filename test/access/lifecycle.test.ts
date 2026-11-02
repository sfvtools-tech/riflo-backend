import assert from 'node:assert/strict';
import test from 'node:test';
import { startTrial, transitionLifecycle, resolveAccess, isLifecycle, type LifecycleCommand } from '../../src/access/lifecycle.js';
import { planGrant } from '../../src/access/plans.js';
import { buildCapabilities, featureIds, isGrant, quotaKeys } from '../../src/access/policy.js';
import { acceptedWorkAllowed, grantPeriod } from '../../src/access/accepted-work.js';

const now = Date.parse('2026-10-29T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const paid = (expectedRevision: number) => ({ type: 'activate_paid' as const, expectedRevision, plan: 'lower' as const, periodId: 'paid_period_0001', startsAt: iso(now + 1000), expiresAt: iso(now + 31 * 86_400_000) });

test('first import fixes one seven-day trial and reads never advance its clock', () => {
  const trial = startTrial(undefined, 'trial_period_001', now);
  assert.ok(isLifecycle(trial));
  assert.equal(trial.trial!.startsAt, iso(now));
  assert.equal(trial.trial!.expiresAt, iso(now + 7 * 86_400_000));
  assert.deepEqual(trial.trial!.limits, { creationCredits: 15, sourceSeconds: 2700 });
  assert.deepEqual(startTrial(trial, 'different_period', now + 1000), trial);
  assert.deepEqual(startTrial(trial, 'different_period', now + 8 * 86_400_000), trial);
  const original = structuredClone(trial);
  assert.deepEqual(resolveAccess(trial, now).grant, trial.trial);
  assert.equal(resolveAccess(trial, now + 7 * 86_400_000).grant, null);
  assert.deepEqual(trial, original);
});

test('paid access takes full limits immediately while retaining original trial funding and deadline', () => {
  const trial = startTrial(undefined, 'trial_period_001', now);
  const activated = transitionLifecycle(trial, paid(trial.revision), now + 1000);
  assert.deepEqual(activated.trial, trial.trial);
  assert.deepEqual(activated.paid!.grant.limits, { creationCredits: 120, sourceSeconds: 18000 });
  const access = resolveAccess(activated, now + 1000);
  assert.deepEqual(access.grant, activated.paid!.grant);
  assert.deepEqual(access.funding.map(grant => grant.allowancePeriodId), ['trial_period_001', 'paid_period_0001']);
  assert.deepEqual(resolveAccess(activated, now + 7 * 86_400_000).funding.map(grant => grant.allowancePeriodId), ['paid_period_0001']);
});

test('upgrade adds approved capacity without changing paid identity, dates or trial', () => {
  const trial = startTrial(undefined, 'trial_period_001', now);
  const lower = transitionLifecycle(trial, paid(trial.revision), now + 1000);
  const original = structuredClone(lower);
  const higher = transitionLifecycle(lower, { type: 'upgrade', expectedRevision: lower.revision }, now + 1000);
  assert.equal(higher.paid!.plan, 'higher');
  assert.equal(higher.paid!.grant.allowancePeriodId, lower.paid!.grant.allowancePeriodId);
  assert.equal(higher.paid!.grant.startsAt, lower.paid!.grant.startsAt);
  assert.equal(higher.paid!.grant.expiresAt, lower.paid!.grant.expiresAt);
  assert.equal(higher.paid!.grant.limits.creationCredits - lower.paid!.grant.limits.creationCredits, 130);
  assert.equal(higher.paid!.grant.limits.sourceSeconds - lower.paid!.grant.limits.sourceSeconds, 18000);
  assert.deepEqual(higher.trial, lower.trial);
  assert.deepEqual(lower, original);
  assert.throws(() => transitionLifecycle(higher, { type: 'upgrade', expectedRevision: lower.revision }));
});

test('downgrade and cancellation preserve access through the exact paid end', () => {
  const lower = transitionLifecycle(undefined, paid(0), now + 1000);
  const higher = transitionLifecycle(lower, { type: 'upgrade', expectedRevision: lower.revision }, now + 1000);
  const downgrade = transitionLifecycle(higher, { type: 'downgrade', expectedRevision: higher.revision }, now + 1000);
  assert.equal(downgrade.paid!.plan, 'higher');
  assert.equal(downgrade.paid!.nextPlan, 'lower');
  assert.deepEqual(downgrade.paid!.grant, higher.paid!.grant);
  const cancelled = transitionLifecycle(downgrade, { type: 'cancel', expectedRevision: downgrade.revision }, now + 1000);
  assert.equal(cancelled.paid!.cancelAtPeriodEnd, true);
  const end = Date.parse(cancelled.paid!.grant.expiresAt);
  assert.ok(resolveAccess(cancelled, end - 1).grant);
  assert.equal(resolveAccess(cancelled, end).grant, null);
  assert.deepEqual(resolveAccess(cancelled, end).funding, []);
});

test('renewal creates full fresh capacity and cannot reuse the old period identity', () => {
  const lower = transitionLifecycle(undefined, paid(0), now + 1000);
  const renewal = { type: 'renew' as const, expectedRevision: lower.revision, plan: 'lower' as const, periodId: 'paid_period_0002', startsAt: lower.paid!.grant.expiresAt, expiresAt: iso(now + 62 * 86_400_000) };
  assert.throws(() => transitionLifecycle(lower, { ...renewal, periodId: lower.paid!.grant.allowancePeriodId }, Date.parse(renewal.startsAt)));
  const next = transitionLifecycle(lower, renewal, Date.parse(renewal.startsAt));
  assert.equal(next.paid!.grant.allowancePeriodId, 'paid_period_0002');
  assert.deepEqual(next.paid!.grant.limits, { creationCredits: 120, sourceSeconds: 18000 });
  assert.equal(next.trial, null);
});

test('an early renewal cannot replace current access with a future period', () => {
  const current = transitionLifecycle(undefined, paid(0), now + 1000);
  const before = structuredClone(current);
  assert.throws(() => transitionLifecycle(current, { type: 'renew', expectedRevision: current.revision, plan: 'higher', periodId: 'future_period_001', startsAt: current.paid!.grant.expiresAt, expiresAt: iso(now + 62 * 86_400_000) }, now + 2000));
  assert.deepEqual(current, before);
  assert.deepEqual(resolveAccess(current, now + 2000).grant, current.paid!.grant);
});

test('manual and old shared grants retain access without becoming trial eligible', () => {
  const manual = { status: 'active', startsAt: iso(now - 1000), expiresAt: iso(now + 1000), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 100])) };
  const shared = planGrant('lower', 'manual_shared_01', manual.startsAt, manual.expiresAt);
  for (const old of [manual, shared]) {
    assert.deepEqual(resolveAccess(old, now).grant, old);
    assert.equal(buildCapabilities(old, new Date(now)).subscription.active, true);
    assert.equal(acceptedWorkAllowed(old, grantPeriod(resolveAccess(old, now).grant!), ['blogs']), true);
    assert.throws(() => startTrial(old, 'trial_period_001', now));
  }
  for (const invalid of [{}, { status: 'revoked' }, { kind: 'lifecycle', version: 2 }]) {
    assert.equal(resolveAccess(invalid, now).grant, null);
    assert.throws(() => startTrial(invalid, 'trial_period_001', now));
  }
});

test('lifecycle tags cannot fall back to outer legacy or shared grant authority', () => {
  const shared = planGrant('lower', 'manual_shared_01', iso(now - 1000), iso(now + 1000));
  const legacy = { status: 'active', startsAt: shared.startsAt, expiresAt: shared.expiresAt, features: [...featureIds], limits: Object.fromEntries(quotaKeys.map(key => [key, 100])) };
  for (const outer of [legacy, shared]) {
    for (const lifecycle of [
      { kind: 'lifecycle', version: 2, revision: 1, withdrawn: true, trial: null, paid: null },
      { kind: 'lifecycle', version: 1, revision: 1, withdrawn: true, trial: {}, paid: null },
    ]) {
      const invalid = { ...outer, ...lifecycle };
      assert.equal(isLifecycle(invalid), false);
      assert.equal(isGrant(invalid), false);
      assert.equal(resolveAccess(invalid, now).grant, null);
      assert.deepEqual(resolveAccess(invalid, now).funding, []);
      assert.equal(buildCapabilities(invalid, new Date(now), [...featureIds]).subscription.active, false);
      assert.equal(acceptedWorkAllowed(invalid, 'shared-manual_shared_01', ['blogs']), false);
      assert.equal(acceptedWorkAllowed(invalid, 'previous_period', ['blogs']), false);
    }
  }
});

test('overflowing changes reject valid predecessors without mutating them', () => {
  const lower = transitionLifecycle(undefined, paid(0), now + 1000);
  for (const meter of ['creationCredits', 'sourceSeconds'] as const) {
    const corrected = structuredClone(lower);
    corrected.paid!.grant.limits[meter] = Number.MAX_SAFE_INTEGER;
    const before = structuredClone(corrected);
    assert.ok(isLifecycle(corrected));
    assert.throws(() => transitionLifecycle(corrected, { type: 'upgrade', expectedRevision: corrected.revision }, now + 1000), { status: 409, code: 'lifecycle_conflict' });
    assert.deepEqual(corrected, before);
  }
  const exhausted = { ...lower, revision: Number.MAX_SAFE_INTEGER };
  for (const type of ['upgrade', 'cancel', 'withdraw'] as const) {
    assert.throws(() => transitionLifecycle(exhausted, { type, expectedRevision: exhausted.revision }, now + 1000), { status: 409, code: 'lifecycle_conflict' });
  }
  const eligible = { ...exhausted, trial: null, paid: null };
  assert.throws(() => startTrial(eligible, 'trial_period_001', now), { status: 409, code: 'lifecycle_conflict' });
  assert.throws(() => transitionLifecycle(eligible, paid(eligible.revision), now + 1000), { status: 409, code: 'lifecycle_conflict' });
  assert.equal(eligible.trial, null);
  assert.equal(eligible.paid, null);
});

test('explicit withdrawal blocks current and accepted funding without erasing trial history', () => {
  const trial = startTrial(undefined, 'trial_period_001', now);
  const withdrawn = transitionLifecycle(trial, { type: 'withdraw', expectedRevision: trial.revision });
  assert.deepEqual(withdrawn.trial, trial.trial);
  assert.equal(resolveAccess(withdrawn, now + 1).grant, null);
  assert.deepEqual(resolveAccess(withdrawn, now + 1).funding, []);
  assert.deepEqual(startTrial(withdrawn, 'new_trial_period', now + 2), withdrawn);
});

test('upgrade preserves current grant corrections while adding the approved differences', () => {
  const lower = transitionLifecycle(undefined, paid(0), now + 1000);
  lower.paid!.grant.limits = { creationCredits: 125, sourceSeconds: 18123 };
  lower.paid!.grant.features = ['x_posts', 'blogs'];
  lower.paid!.grant.sourceRetentionDays = 30;
  const higher = transitionLifecycle(lower, { type: 'upgrade', expectedRevision: lower.revision }, now + 1000);
  assert.deepEqual(higher.paid!.grant, {
    ...lower.paid!.grant, limits: { creationCredits: 255, sourceSeconds: 36123 },
  });
});

test('malformed lifecycle records and trusted commands fail closed', () => {
  const valid = transitionLifecycle(undefined, paid(0), now + 1000);
  for (const invalid of [{ ...valid, revision: -1 }, { ...valid, withdrawn: 'false' }, { ...valid, trial: {} }, { ...valid, paid: { ...valid.paid, nextPlan: 'unknown' } }]) {
    assert.equal(isLifecycle(invalid), false);
    assert.equal(resolveAccess(invalid, now).grant, null);
    assert.throws(() => transitionLifecycle(invalid, { type: 'cancel', expectedRevision: valid.revision }));
  }
  for (const command of [null, {}, { type: 'unknown', expectedRevision: valid.revision }, { type: 'cancel', expectedRevision: NaN }, { type: 'renew', expectedRevision: valid.revision, plan: 'unknown' }, { ...paid(valid.revision), type: 'renew', startsAt: '2026-02-30T00:00:00Z' }]) {
    const before = structuredClone(valid);
    assert.throws(() => transitionLifecycle(valid, command as LifecycleCommand));
    assert.deepEqual(valid, before);
  }
});

test('an expired canceled subscription can activate a fresh paid period without another trial', () => {
  const trial = startTrial(undefined, 'trial_period_001', now);
  const first = transitionLifecycle(trial, paid(trial.revision), now + 1000);
  const canceled = transitionLifecycle(first, { type: 'cancel', expectedRevision: first.revision }, now + 2000);
  const end = Date.parse(canceled.paid!.grant.expiresAt);
  const activation = { ...paid(canceled.revision), periodId: 'resubscribed_period', startsAt: iso(end), expiresAt: iso(end + 31 * 86_400_000) };
  assert.throws(() => transitionLifecycle(canceled, activation, end - 1), { code: 'lifecycle_conflict' });
  const next = transitionLifecycle(canceled, activation, end);
  assert.deepEqual(next.trial, trial.trial);
  assert.equal(next.paid!.grant.allowancePeriodId, activation.periodId);
  assert.equal(next.paid!.cancelAtPeriodEnd, false);
  assert.deepEqual(next.paid!.grant.limits, { creationCredits: 120, sourceSeconds: 18000 });
  assert.equal(resolveAccess(next, end).lifecycle!.trial.state, 'expired');
  assert.deepEqual(startTrial(next, 'another_trial_id', end), next);
});

test('saved downgrade constrains renewal and cancellation blocks automatic renewal at the exact boundary', () => {
  const lower = transitionLifecycle(undefined, paid(0), now + 1000);
  const higher = transitionLifecycle(lower, { type: 'upgrade', expectedRevision: lower.revision }, now + 1001);
  const downgraded = transitionLifecycle(higher, { type: 'downgrade', expectedRevision: higher.revision }, now + 1002);
  const end = Date.parse(downgraded.paid!.grant.expiresAt);
  const renewal = { type: 'renew' as const, expectedRevision: downgraded.revision, plan: 'lower' as const, periodId: 'downgraded_renewal', startsAt: iso(end), expiresAt: iso(end + 31 * 86_400_000) };
  const before = structuredClone(downgraded);
  assert.throws(() => transitionLifecycle(downgraded, { ...renewal, plan: 'higher' }, end), { code: 'lifecycle_conflict' });
  assert.deepEqual(downgraded, before);
  const renewed = transitionLifecycle(downgraded, renewal, end);
  assert.equal(renewed.paid!.plan, 'lower');
  assert.equal(renewed.paid!.nextPlan, null);
  assert.deepEqual(renewed.paid!.grant.limits, { creationCredits: 120, sourceSeconds: 18000 });
  const canceled = transitionLifecycle(downgraded, { type: 'cancel', expectedRevision: downgraded.revision }, end - 1);
  assert.throws(() => transitionLifecycle(canceled, { ...renewal, expectedRevision: canceled.revision }, end), { code: 'lifecycle_conflict' });
  for (const type of ['upgrade', 'downgrade', 'cancel'] as const) {
    assert.throws(() => transitionLifecycle(downgraded, { type, expectedRevision: downgraded.revision }, end), { code: 'lifecycle_conflict' });
  }
});
