import { featureIds, type SharedCreditGrant } from './policy.js';

// Offering quantities only. These do not activate access or raise processing caps.
export const plans = {
  lower: { priceUsd: 39, creationCredits: 120, sourceSeconds: 300 * 60 },
  higher: { priceUsd: 69, creationCredits: 250, sourceSeconds: 600 * 60 },
};
export const trialOffering = { days: 7, creationCredits: 15, sourceSeconds: 45 * 60 };
// Approved within-period additions remain fixed when future plan quantities change.
export const upgradeOffering = { creationCredits: 130, sourceSeconds: 18_000 };

export function planGrant(plan: keyof typeof plans, allowancePeriodId: string, startsAt: string, expiresAt: string): SharedCreditGrant {
  const { creationCredits, sourceSeconds } = plans[plan];
  return { status: 'active', accounting: 'shared_credits', allowancePeriodId, startsAt, expiresAt, features: [...featureIds], limits: { creationCredits, sourceSeconds } };
}
