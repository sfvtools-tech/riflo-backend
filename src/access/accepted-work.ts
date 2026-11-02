import { createHash } from 'node:crypto';
import { isGrant, isSharedCreditGrant, type FeatureId, type Grant } from './policy.js';
import { isLifecycle, lifecycleAccepted } from './lifecycle.js';

export const grantPeriod = (grant: Grant) => isSharedCreditGrant(grant) ? `shared-${grant.allowancePeriodId}` : createHash('sha256').update(`${grant.startsAt}/${grant.expiresAt}`).digest('hex');

export function acceptedWorkAllowed(value: unknown, period: string, features: readonly FeatureId[] = []): boolean {
  // Renewal or expiry does not retract reserved work; removing access still does.
  return isLifecycle(value) ? lifecycleAccepted(value, period, features) : isGrant(value) && (grantPeriod(value) !== period || features.every(feature => value.features.includes(feature)));
}

export function hasSourceReservation(reserved: number, available: number, allowFractional = false) {
  const valid = allowFractional ? Number.isFinite : Number.isSafeInteger;
  return valid(reserved) && reserved > 0 && Number.isFinite(available) && available >= reserved;
}
