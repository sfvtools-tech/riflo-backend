import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCounters } from '../../src/access/accounting.js';
import { allocations, available, reserve, settleFunding, releaseFunding, type Ledgers } from '../../src/access/funding.js';
import { grantPeriod } from '../../src/access/accepted-work.js';
import { planGrant } from '../../src/access/plans.js';

function fixture() {
  const grants = ['trial_period_001', 'paid_period_0001'].map(period => planGrant('lower', period, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'));
  grants[0]!.limits = { sourceSeconds: 20, creationCredits: 3 };
  grants[1]!.limits = { sourceSeconds: 40, creationCredits: 5 };
  const ledgers: Ledgers = new Map(grants.map(grant => [grantPeriod(grant), emptyCounters()]));
  return { grants, ledgers, trial: ledgers.get(grantPeriod(grants[0]!))!, paid: ledgers.get(grantPeriod(grants[1]!))! };
}

test('source and creation meters spend their trial remainders independently', () => {
  const { grants, ledgers, trial, paid } = fixture();
  const source = reserve(grants, ledgers, 'sourceSeconds', 50);
  const clip = reserve(grants, ledgers, 'creationCredits', 4);
  assert.deepEqual(source.map(owner => owner.amount), [20, 30]);
  assert.deepEqual(clip.map(owner => owner.amount), [3, 1]);
  assert.equal(trial.reserved.sourceSeconds, 20);
  assert.equal(paid.reserved.sourceSeconds, 30);
  assert.equal(available(grants, ledgers, 'sourceSeconds'), 10);
  assert.equal(available(grants, ledgers, 'creationCredits'), 4);
  settleFunding(ledgers, source, 'sourceSeconds', 25);
  assert.equal(trial.consumed.sourceSeconds, 20);
  assert.equal(paid.consumed.sourceSeconds, 5);
  assert.equal(trial.reserved.sourceSeconds, 0);
  assert.equal(paid.reserved.sourceSeconds, 0);
  assert.equal(trial.reserved.creationCredits, 3);
  assert.equal(paid.reserved.creationCredits, 1);
  settleFunding(ledgers, clip, 'creationCredits');
  assert.equal(trial.consumed.creationCredits, 3);
  assert.equal(paid.consumed.creationCredits, 1);
});

test('insufficient multi-owner admission and unsupported duration adjustment preserve every counter', () => {
  const { grants, ledgers } = fixture();
  const before = structuredClone(ledgers);
  assert.throws(() => reserve(grants, ledgers, 'creationCredits', 9));
  assert.deepEqual(ledgers, before);
  const owners = reserve(grants, ledgers, 'sourceSeconds', 50);
  const reserved = structuredClone(ledgers);
  assert.throws(() => settleFunding(ledgers, owners, 'sourceSeconds', 61));
  assert.deepEqual(ledgers, reserved);
  // A later larger plan must not raise the accepted allocation snapshots.
  grants[1]!.limits.sourceSeconds = 1000;
  assert.throws(() => settleFunding(ledgers, owners, 'sourceSeconds', 61));
  assert.deepEqual(ledgers, reserved);
  settleFunding(ledgers, owners, 'sourceSeconds', 60);
  assert.deepEqual([...ledgers.values()].map(ledger => ledger.consumed.sourceSeconds), [20, 40]);
});

test('release restores every pending owner while retaining consumed usage and other reservations', () => {
  const { grants, ledgers, trial, paid } = fixture();
  trial.consumed.creationCredits = 1;
  const owners = reserve(grants, ledgers, 'creationCredits', 4);
  paid.reserved.creationCredits! += 1;
  releaseFunding(ledgers, owners, 'creationCredits');
  assert.equal(trial.consumed.creationCredits, 1);
  assert.equal(trial.reserved.creationCredits, 0);
  assert.equal(paid.reserved.creationCredits, 1);
});

test('legacy charges normalize without writes and malformed allocations fail closed', () => {
  assert.deepEqual(allocations(undefined, 'shared-old_period', 2), [{ period: 'shared-old_period', amount: 2, limit: 0 }]);
  assert.deepEqual(allocations(undefined, 'legacy_period_01', 1.25), [{ period: 'legacy_period_01', amount: 1.25, limit: 0 }]);
  const owner = { period: 'shared-trial_period_001', amount: 1, limit: 15 };
  for (const invalid of [[owner, owner], [{ ...owner, amount: -1 }], [{ ...owner, amount: 0.5 }], [{ ...owner, limit: 0 }], [owner, { ...owner, period: 'shared-paid_period_0001' }, { ...owner, period: 'shared-third_period_01' }]]) {
    assert.throws(() => allocations(invalid, 'shared-admission_period', invalid.reduce((sum, entry) => sum + entry.amount, 0)));
  }
  assert.throws(() => allocations([owner], 'shared-admission_period', 2));
});

test('measured source growth respects competing reservations without disturbing either meter', () => {
  const { grants, ledgers, trial, paid } = fixture();
  const first = reserve(grants, ledgers, 'sourceSeconds', 25);
  const second = reserve(grants, ledgers, 'sourceSeconds', 30);
  const clip = reserve(grants, ledgers, 'creationCredits', 4);
  const before = structuredClone(ledgers);
  assert.throws(() => settleFunding(ledgers, first, 'sourceSeconds', 31));
  assert.deepEqual(ledgers, before);
  settleFunding(ledgers, first, 'sourceSeconds', 30);
  assert.equal(trial.consumed.sourceSeconds, 20);
  assert.equal(paid.consumed.sourceSeconds, 10);
  assert.equal(paid.reserved.sourceSeconds, 30);
  releaseFunding(ledgers, second, 'sourceSeconds');
  settleFunding(ledgers, clip, 'creationCredits');
  assert.equal(available(grants, ledgers, 'sourceSeconds'), 30);
  assert.deepEqual([...ledgers.values()].map(ledger => ledger.consumed.creationCredits), [3, 1]);
});

test('source shrinking below the trial allocation releases all paid funding and preserves unrelated reservations', () => {
  const { grants, ledgers, trial, paid } = fixture();
  const owners = reserve(grants, ledgers, 'sourceSeconds', 50);
  const other = reserve(grants, ledgers, 'sourceSeconds', 10);
  settleFunding(ledgers, owners, 'sourceSeconds', 7);
  assert.equal(trial.consumed.sourceSeconds, 7);
  assert.equal(paid.consumed.sourceSeconds, 0);
  assert.equal(trial.reserved.sourceSeconds, 0);
  assert.equal(paid.reserved.sourceSeconds, 10);
  releaseFunding(ledgers, other, 'sourceSeconds');
  assert.equal(available(grants, ledgers, 'sourceSeconds'), 53);
});
