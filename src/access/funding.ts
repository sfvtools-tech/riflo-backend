import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { grantPeriod } from './accepted-work.js';
import { emptyCounters, readCounters, type Counters } from './accounting.js';
import type { SharedCreditGrant } from './policy.js';

export type Allocation = { period: string; amount: number; limit: number };
export type Ledgers = Map<string, Counters>;
export const ledgerRef = (db: Firestore, uid: string, period: string) => db.collection('accounts').doc(uid).collection('allowances').doc(period);

export function allocations(value: readonly Allocation[] | undefined, period: string, amount: number, limit = 0): Allocation[] {
  if (!value) return amount > 0 ? [{ period, amount, limit }] : [];
  if (!Array.isArray(value) || value.length > 2 || new Set(value.map(entry => entry.period)).size !== value.length || value.some(entry => !entry || typeof entry.period !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(entry.period) || !Number.isSafeInteger(entry.amount) || entry.amount <= 0 || !Number.isSafeInteger(entry.limit) || entry.limit < entry.amount) || value.reduce((sum, entry) => sum + entry.amount, 0) !== amount) throw new Error('Invalid accepted funding allocation.');
  return value.map(entry => ({ ...entry }));
}

export async function readLedgers(transaction: Transaction, db: Firestore, uid: string, periods: Iterable<string>, requireCredits = false): Promise<Ledgers> {
  const result: Ledgers = new Map();
  for (const period of new Set(periods)) result.set(period, readCounters((await transaction.get(ledgerRef(db, uid, period))).data(), requireCredits && period.startsWith('shared-')));
  return result;
}
export function writeLedgers(transaction: Transaction, db: Firestore, uid: string, ledgers: Ledgers) {
  for (const [period, usage] of ledgers) transaction.set(ledgerRef(db, uid, period), usage);
}
export function available(grants: readonly SharedCreditGrant[], ledgers: Ledgers, key: 'creationCredits' | 'sourceSeconds') {
  return grants.reduce((sum, grant) => {
    const usage = ledgers.get(grantPeriod(grant)) ?? emptyCounters();
    return sum + Math.max(0, grant.limits[key] - usage.reserved[key]! - usage.consumed[key]!);
  }, 0);
}
export function reserve(grants: readonly SharedCreditGrant[], ledgers: Ledgers, key: 'creationCredits' | 'sourceSeconds', amount: number): Allocation[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || available(grants, ledgers, key) < amount) throw new Error('Insufficient funding.');
  let remaining = amount;
  const result: Allocation[] = [];
  for (const grant of grants) {
    const period = grantPeriod(grant);
    const usage = ledgers.get(period)!;
    const take = Math.min(remaining, Math.max(0, grant.limits[key] - usage.reserved[key]! - usage.consumed[key]!));
    if (take > 0) { result.push({ period, amount: take, limit: grant.limits[key] }); usage.reserved[key]! += take; remaining -= take; }
  }
  return result;
}
export function covered(ledgers: Ledgers, owners: readonly Allocation[], key: string) {
  return owners.every(entry => Number.isFinite(ledgers.get(entry.period)?.reserved[key]) && ledgers.get(entry.period)!.reserved[key]! >= entry.amount);
}
export function releaseFunding(ledgers: Ledgers, owners: readonly Allocation[], key: string) {
  for (const owner of owners) {
    const usage = ledgers.get(owner.period)!;
    usage.reserved[key] = Math.max(0, usage.reserved[key]! - owner.amount);
  }
}
export function settleFunding(ledgers: Ledgers, owners: readonly Allocation[], key: string, actual = owners.reduce((sum, owner) => sum + owner.amount, 0)) {
  if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('Invalid funding settlement.');
  const reserved = owners.reduce((sum, owner) => sum + owner.amount, 0);
  if (!covered(ledgers, owners, key)) throw new Error('The original reservation is unavailable.');
  let remaining = actual;
  const charges = owners.map(owner => {
    const amount = Math.min(remaining, owner.amount);
    remaining -= amount;
    return { ...owner, amount };
  });
  if (remaining > 0) {
    for (const charge of charges) {
      const usage = ledgers.get(charge.period)!;
      const owner = owners.find(entry => entry.period === charge.period)!;
      const extra = Math.min(remaining, Math.max(0, owner.limit - usage.consumed[key]! - usage.reserved[key]!));
      charge.amount += extra; remaining -= extra;
    }
    if (remaining > 0 || actual < reserved) throw new Error('The imported video exceeds its original allowance.');
  }
  releaseFunding(ledgers, owners, key);
  for (const charge of charges) ledgers.get(charge.period)!.consumed[key]! += charge.amount;
}
