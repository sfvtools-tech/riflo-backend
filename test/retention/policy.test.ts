import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRetention, type RetentionContext, type RetentionPolicy } from '../../src/generation/retention.js';

const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const uid = 'policy-owner';
const tenure = { id: 'paid-tenure', uid, startsAt: start + day, paidAccessEndsAt: start + 31 * day, revision: 1 };
const context: RetentionContext = { uid, tenures: new Map([[tenure.id, tenure]]) };
const trial = (promisedUntil: number): RetentionPolicy => ({ version: 1, kind: 'trial', startsAt: start, promisedUntil });
const paid = (promisedUntil: number): RetentionPolicy => ({ version: 1, kind: 'paid', tenureId: tenure.id, promisedUntil });

test('trial resources share the first initiation anchor, independently of import and read time', () => {
  for (const [kind, days] of [['source', 14], ['transcript', 30], ['output', 30]] as const) {
    const resource = { kind, expiresAt: start + day, importedAt: start + 6 * day, retention: trial(start + day) };
    const expiry = start + days * day;
    assert.equal(resolveRetention(resource, start + 7 * day, context).expiresAt, expiry, kind);
    assert.equal(resolveRetention(resource, expiry - 1, context).available, true, kind);
    assert.equal(resolveRetention(resource, expiry, context).available, false, kind);
    assert.equal(resolveRetention(resource, expiry + day, context).expiresAt, expiry, 'Reading cannot restart retention.');
  }
});

test('paid originals expire sixty days after successful import even through renewal', () => {
  const importedAt = start + 2 * day;
  const source = { kind: 'source' as const, expiresAt: start + 3 * day, importedAt, retention: paid(start + 3 * day) };
  const renewed: RetentionContext = { uid, tenures: new Map([[tenure.id, { ...tenure, paidAccessEndsAt: start + 120 * day, revision: 2 }]]) };
  for (const facts of [context, renewed]) {
    assert.equal(resolveRetention(source, importedAt + 60 * day - 1, facts).available, true);
    assert.equal(resolveRetention(source, importedAt + 60 * day, facts).available, false);
    assert.equal(resolveRetention(source, start + 10 * day, facts).expiresAt, importedAt + 60 * day);
  }
});

test('paid transcripts and outputs follow the actual paid end and contiguous tenure extension', () => {
  for (const kind of ['transcript', 'output'] as const) {
    const resource = { kind, expiresAt: start + 2 * day, retention: paid(start + 2 * day) };
    const expiry = tenure.paidAccessEndsAt + 60 * day;
    assert.equal(resolveRetention(resource, tenure.paidAccessEndsAt, context).available, true);
    assert.equal(resolveRetention(resource, expiry - 1, context).available, true);
    assert.equal(resolveRetention(resource, expiry, context).available, false);
    const extended = { ...tenure, paidAccessEndsAt: tenure.paidAccessEndsAt + 31 * day, revision: 2 };
    assert.equal(resolveRetention(resource, start + 40 * day, { uid, tenures: new Map([[tenure.id, extended]]) }).expiresAt, expiry + 31 * day);
  }
});

test('trial or split funding cannot demote accepted paid retention or couple source and creation funds', () => {
  for (const funding of [[], [{ period: 'trial-period', credits: 2 }], [{ period: 'trial-period', credits: 1 }, { period: 'paid-period', credits: 1 }]]) {
    const resource = { kind: 'output' as const, expiresAt: start + day, retention: paid(start + day), sourceFunding: [], charge: { funding } };
    const resolved = resolveRetention(resource, start + 32 * day, context);
    assert.equal(resolved.available, true);
    assert.equal(resolved.expiresAt, tenure.paidAccessEndsAt + 60 * day);
  }
});

test('reactivation extends a surviving archive through its retained tenure; a new tenure after expiry cannot revive it', () => {
  const resource = { kind: 'output' as const, expiresAt: start + day, retention: paid(start + day) };
  const archiveEnd = tenure.paidAccessEndsAt + 60 * day;
  const reactivated = { ...tenure, paidAccessEndsAt: archiveEnd + 31 * day, revision: 2 };
  const survivingFacts = { uid, tenures: new Map([[tenure.id, reactivated]]) };
  assert.equal(resolveRetention(resource, archiveEnd + day, survivingFacts).available, true);
  assert.equal(resolveRetention(resource, archiveEnd + day, survivingFacts).expiresAt, archiveEnd + 91 * day);
  const laterTenure = { ...tenure, id: 'new-tenure', startsAt: archiveEnd, paidAccessEndsAt: archiveEnd + 31 * day };
  const expiredFacts = { uid, tenures: new Map([[tenure.id, tenure], [laterTenure.id, laterTenure]]) };
  assert.equal(resolveRetention(resource, archiveEnd, expiredFacts).available, false);
  assert.equal(resolveRetention(resource, archiveEnd + day, expiredFacts).available, false);
  assert.equal(resolveRetention({ ...resource, retention: { ...resource.retention, deletedAt: archiveEnd - day } }, archiveEnd + day, survivingFacts).available, false);
});

test('finite original promises survive shorter policy deadlines', () => {
  const floor = start + 200 * day;
  for (const retention of [trial(floor), paid(floor)]) {
    for (const kind of ['source', 'transcript', 'output'] as const) {
      const resource = { kind, importedAt: start + day, expiresAt: floor, retention };
      assert.equal(resolveRetention(resource, floor - 1, context).expiresAt, floor);
      assert.equal(resolveRetention(resource, floor - 1, context).available, true);
      assert.equal(resolveRetention(resource, floor, context).available, false);
    }
  }
});

test('promotion before each original deadline adopts paid clocks, while exact or later promotion never resurrects', () => {
  for (const [kind, days] of [['source', 14], ['transcript', 30], ['output', 30]] as const) {
    const expiry = start + days * day;
    const resource = { kind, importedAt: start + 3 * day, expiresAt: expiry, retention: trial(expiry) };
    const facts = (at: number): RetentionContext => ({ ...context, promotion: { at, tenureId: tenure.id } });
    assert.equal(resolveRetention(resource, expiry + day, facts(expiry - 1)).expiresAt,
      kind === 'source' ? start + 63 * day : tenure.paidAccessEndsAt + 60 * day);
    assert.equal(resolveRetention(resource, expiry + day, facts(expiry - 1)).available, true);
    for (const at of [expiry, expiry + 1]) {
      assert.equal(resolveRetention(resource, expiry + day, facts(at)).available, false);
      assert.equal(resolveRetention(resource, expiry + day, facts(at)).expiresAt, expiry);
    }
  }
});

test('source and transcript eligibility differ when promotion falls between day fourteen and thirty', () => {
  const facts = { ...context, promotion: { at: start + 20 * day, tenureId: tenure.id } };
  assert.equal(resolveRetention({ kind: 'source', importedAt: start + day, expiresAt: start + 14 * day, retention: trial(start + 14 * day) }, start + 31 * day, facts).available, false);
  assert.equal(resolveRetention({ kind: 'transcript', expiresAt: start + 30 * day, retention: trial(start + 30 * day) }, start + 31 * day, facts).available, true);
});

test('promotion requires an actual paid tenure covering its recorded activation time', () => {
  const resource = { kind: 'output' as const, expiresAt: start + 30 * day, retention: trial(start + 30 * day) };
  for (const [at, startsAt, paidAccessEndsAt] of [
    [start + day, start + 100 * day, start + 130 * day],
    [start + day, start, start + day],
    [start - day, start - 2 * day, start + day],
  ]) {
    const facts = { uid, promotion: { at, tenureId: tenure.id }, tenures: new Map([[tenure.id, { ...tenure, startsAt, paidAccessEndsAt }]]) };
    assert.deepEqual(resolveRetention(resource, start + 40 * day, facts), { available: false, valid: false, expiresAt: null, mode: 'fixed' });
  }
});

test('logical deletion defeats promotion, renewal and remaining promise floors', () => {
  const facts = { ...context, promotion: { at: start + day, tenureId: tenure.id } };
  for (const retention of [trial(start + 200 * day), paid(start + 200 * day)]) {
    assert.equal(resolveRetention({ kind: 'output', expiresAt: start + 200 * day, retention: { ...retention, deletedAt: start + 2 * day } }, start + 3 * day, facts).available, false);
  }
});

test('legacy finite expiry stays fixed under current paid and promotion facts', () => {
  const facts = { ...context, promotion: { at: start, tenureId: tenure.id } };
  for (const kind of ['source', 'transcript', 'output'] as const) {
    const resource = { kind, expiresAt: start + day };
    assert.equal(resolveRetention(resource, start, facts).expiresAt, start + day);
    assert.equal(resolveRetention(resource, start + day, facts).available, false);
  }
});

test('nonfinite deadlines and malformed versioned metadata never authorize delivery', () => {
  for (const expiresAt of [undefined, null, '2026-11-01', NaN, Infinity, -Infinity]) {
    assert.equal(resolveRetention({ kind: 'output', expiresAt }, start, context).available, false);
  }
  for (const retention of [{}, { ...paid(start + day), version: 2 }, { ...trial(start + day), startsAt: NaN }, { ...paid(start + day), promisedUntil: Infinity }]) {
    const result = resolveRetention({ kind: 'output', expiresAt: start + day, retention }, start, context);
    assert.equal(result.available, false);
    assert.equal(result.valid, false);
  }
});

test('missing and cross-owner tenure facts fail closed even with an unexpired stored promise', () => {
  const resource = { kind: 'output' as const, expiresAt: start + 200 * day, retention: paid(start + 200 * day) };
  for (const facts of [undefined, { uid, tenures: new Map() }, { uid, tenures: new Map([[tenure.id, { ...tenure, uid: 'another-owner' }]]) }]) {
    const result = resolveRetention(resource, start + 2 * day, facts);
    assert.equal(result.available, false);
    assert.equal(result.valid, false);
  }
  assert.equal(resolveRetention({ kind: 'source', expiresAt: start + day, retention: paid(start + day) }, start, context).available, false, 'Mutable update timestamps cannot substitute for successful import.');
});
