import { resolveSourceLimits } from './source-limits.js';
import { isLifecycle, resolveAccess } from './lifecycle.js';

export const featureIds = ['x_posts', 'linkedin_posts', 'blogs', 'newsletters', 'carousels', 'short_videos'] as const;
export type FeatureId = typeof featureIds[number];
export const quotaKeys = ['sourceSeconds', ...featureIds] as const;
export type QuotaKey = typeof quotaKeys[number];
export type LegacyGrant = {
  status: 'active';
  startsAt: string;
  expiresAt: string;
  features: FeatureId[];
  limits: Record<QuotaKey, number>;
  sourceRetentionDays?: 1 | 7 | 30;
};

export type SharedCreditGrant = Omit<LegacyGrant, 'limits'> & {
  accounting: 'shared_credits';
  allowancePeriodId: string;
  limits: { sourceSeconds: number; creationCredits: number };
};
export type Grant = LegacyGrant | SharedCreditGrant;
export const isSharedCreditGrant = (grant: Grant): grant is SharedCreditGrant => 'accounting' in grant && grant.accounting === 'shared_credits';

// Backend catalogue: change future admissions here; accepted slot charges are immutable.
export const creationCreditCosts: Record<FeatureId, number> = {
  x_posts: 1, linkedin_posts: 1, blogs: 1, newsletters: 1, carousels: 2, short_videos: 4,
};

export const generationBatchLimits: Record<FeatureId, number> = {
  x_posts: 2,
  linkedin_posts: 1,
  blogs: 1,
  newsletters: 1,
  carousels: 1,
  short_videos: 1,
};

// Processing and API responses use the same bounds.
export const operationalLimits = {
  maxSourceSeconds: 1800,
  maxSourceBytes: 2 * 1024 ** 3,
  activeProjects: 1,
  queuedProjects: 2,
  transientRetries: 2,
  importRetryCooldownSeconds: 60,
  projectLifetimeHours: 24,
  sourceRetentionDays: 7 as const,
  outputRetentionDays: 30,
  transcriptRetentionDays: 30,
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGrant(value: unknown): value is Grant {
  if (!record(value) || value.kind === 'lifecycle' || value.status !== 'active' || !Array.isArray(value.features) || !record(value.limits)) return false;
  if (!value.features.every((id) => featureIds.includes(id)) || new Set(value.features).size !== value.features.length) return false;

  if (value.sourceRetentionDays !== undefined && ![1, 7, 30].includes(value.sourceRetentionDays as number)) return false;

  const limits = value.limits;
  const keys = value.accounting === 'shared_credits' ? ['sourceSeconds', 'creationCredits'] : quotaKeys;
  if (value.accounting !== undefined && value.accounting !== 'shared_credits') return false;
  if (value.accounting === 'shared_credits' && (typeof value.allowancePeriodId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.allowancePeriodId))) return false;
  if (value.accounting === undefined && value.allowancePeriodId !== undefined) return false;
  if (!keys.every((key) => Number.isSafeInteger(limits[key]) && (limits[key] as number) >= 0)) return false;

  const dates = [value.startsAt, value.expiresAt];
  const validDates = dates.every((date) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date)) return false;
    if (!Number.isFinite(Date.parse(date))) return false;
    // JavaScript accepts dates such as February 30 by moving them into March.
    return new Date(date).toISOString() === date.replace(/(?<=:\d{2})Z$/, '.000Z');
  });
  if (!validDates) return false;
  return Date.parse(value.startsAt as string) < Date.parse(value.expiresAt as string);
}

export function buildCapabilities(rawGrant: unknown, now = new Date(), implementedFeatures: readonly FeatureId[] = [], trialEnabled = false) {
  const resolved = resolveAccess(rawGrant, now.getTime());
  const lifecycle = isLifecycle(rawGrant) || trialEnabled && rawGrant == null ? resolved.lifecycle : undefined;
  const grant = lifecycle ? resolved.grant : isGrant(rawGrant) ? rawGrant : null;
  const reason = lifecycle ? grant ? 'active' : lifecycle.trial.state === 'eligible' ? 'trial_eligible' : lifecycle.paid.state === 'expired' ? 'subscription_expired' : lifecycle.trial.state === 'expired' ? 'trial_expired' : 'subscription_required'
    : rawGrant == null ? 'subscription_required'
    : !grant ? 'invalid_subscription'
    : now.getTime() < Date.parse(grant.startsAt) ? 'subscription_not_started'
    : now.getTime() >= Date.parse(grant.expiresAt) ? 'subscription_expired'
    : 'active';
  const active = reason === 'active';
  const features = Object.fromEntries(featureIds.map((id) => {
    const implemented = implementedFeatures.includes(id);
    // A paid plan does not make an unfinished or unconfigured feature available.
    const entitled = active && grant!.features.includes(id);
    return [id, {
      implemented,
      entitled,
      available: entitled && implemented,
      reason: entitled ? implemented ? 'available' : 'not_implemented' : active ? 'feature_not_in_plan' : reason,
    }];
  }));
  return {
    subscription: { active, reason, expiresAt: grant?.expiresAt ?? lifecycle?.paid.expiresAt ?? lifecycle?.trial.expiresAt ?? null },
    ...(lifecycle ? { lifecycle, intake: { available: active || trialEnabled && lifecycle.trial.state === 'eligible', reason: active ? 'available' : trialEnabled && lifecycle.trial.state === 'eligible' ? 'trial_eligible' : reason } } : {}),
    features,
    ...(grant && isSharedCreditGrant(grant) ? { accounting: { mode: 'shared_credits' as const, ...(!lifecycle ? { periodId: grant.allowancePeriodId } : {}), creditCosts: { ...creationCreditCosts } } } : {}),
    limits: active ? lifecycle ? { sourceSeconds: resolved.funding.reduce((sum, entry) => sum + entry.limits.sourceSeconds, 0), creationCredits: resolved.funding.reduce((sum, entry) => sum + entry.limits.creationCredits, 0) } : { ...grant!.limits } : null,
    operationalLimits: { ...operationalLimits, ...resolveSourceLimits(rawGrant, now.getTime()), sourceRetentionDays: active ? grant!.sourceRetentionDays ?? operationalLimits.sourceRetentionDays : operationalLimits.sourceRetentionDays },
    generationBatchLimits,
  };
}
