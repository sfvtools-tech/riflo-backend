import { quotaKeys, type FeatureId } from './policy.js';
import { allocations, releaseFunding, type Allocation, type Ledgers } from './funding.js';

export type Counters = { reserved: Record<string, number>; consumed: Record<string, number> };
export type CreditAccounting = { mode: 'shared_credits'; period: string };
export type CreditCharge = { credits: number; period: string; allocations?: Allocation[] };
type ChargedSlot = { feature: FeatureId; charge?: CreditCharge };
type ChargedBatch = { period: string; accounting?: CreditAccounting };

export const emptyCounters = (): Counters => ({
  reserved: Object.fromEntries([...quotaKeys, 'creationCredits'].map(key => [key, 0])),
  consumed: Object.fromEntries([...quotaKeys, 'creationCredits'].map(key => [key, 0])),
});

export function readCounters(value: unknown, requireCredits = false): Counters {
  if (value === undefined) return emptyCounters();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid allowance counters.');
  const result = emptyCounters();
  for (const field of ['reserved', 'consumed'] as const) {
    const counts = Object.getOwnPropertyDescriptor(value, field)?.value;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid allowance counters.');
    for (const key of quotaKeys) {
      if (!Number.isFinite(counts[key]) || counts[key] < 0 || counts[key] > Number.MAX_SAFE_INTEGER || (key !== 'sourceSeconds' && !Number.isSafeInteger(counts[key]))) throw new Error('Invalid allowance counters.');
      result[field][key] = counts[key];
    }
    if (requireCredits && counts.creationCredits === undefined) throw new Error('Missing credit counters.');
    if (counts.creationCredits !== undefined) {
      if (!Number.isSafeInteger(counts.creationCredits) || counts.creationCredits < 0) throw new Error('Invalid credit counters.');
      result[field].creationCredits = counts.creationCredits;
    }
  }
  return result;
}

export function slotCharge(slot: ChargedSlot, batch: ChargedBatch) {
  if (!batch.accounting) {
    if (slot.charge) throw new Error('Unexpected credit charge on legacy work.');
    return { key: slot.feature, amount: 1 };
  }
  if (batch.accounting.mode !== 'shared_credits' || batch.accounting.period !== batch.period || slot.charge?.period !== batch.period || !Number.isSafeInteger(slot.charge.credits) || slot.charge.credits <= 0) throw new Error('Invalid accepted credit charge.');
  allocations(slot.charge.allocations, batch.period, slot.charge.credits);
  return { key: 'creationCredits', amount: slot.charge.credits };
}

export function slotOwners(slot: ChargedSlot, batch: ChargedBatch) {
  const charge = slotCharge(slot, batch);
  return allocations(slot.charge?.allocations, batch.period, charge.amount);
}
export function releaseSlotFunding(ledgers: Ledgers, slot: ChargedSlot, batch: ChargedBatch) {
  releaseFunding(ledgers, slotOwners(slot, batch), slotCharge(slot, batch).key);
}

export function releaseSlot(usage: Counters, slot: ChargedSlot, batch: ChargedBatch) {
  const { key, amount } = slotCharge(slot, batch);
  usage.reserved[key] = Math.max(0, usage.reserved[key]! - amount);
}
