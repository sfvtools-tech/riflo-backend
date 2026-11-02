const day = 86_400_000;
export type RetentionOrigin = { kind: 'trial'; startsAt: number } | { kind: 'paid'; tenureId: string };
export type RetentionPolicy = RetentionOrigin & { version: 1; promisedUntil: number; deletedAt?: number };
export type PaidTenure = { id: string; uid: string; startsAt: number; activatedAt?: number; paidAccessEndsAt: number; revision: number };
export type TrialPromotion = { at: number; tenureId: string };
export type AccountRetention = { version: 1; paidTenureId: string | null; trialPromotion?: TrialPromotion };
export type RetentionContext = { uid: string; tenures: ReadonlyMap<string, PaidTenure>; promotion?: TrialPromotion; survivingTenures?: ReadonlyMap<number, PaidTenure | null> };
export type RetentionKind = 'source' | 'transcript' | 'output';
type RetainedResource = { kind: RetentionKind; expiresAt: unknown; retention?: unknown; importedAt?: number };
export const validDeadline = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function isAccountRetention(value: unknown): value is AccountRetention {
  return record(value) && value.version === 1 && (value.paidTenureId === null || identity(value.paidTenureId))
    && (value.trialPromotion === undefined || record(value.trialPromotion) && validDeadline(value.trialPromotion.at) && identity(value.trialPromotion.tenureId));
}
export function isRetentionOrigin(value: unknown): value is RetentionOrigin {
  return record(value) && (value.kind === 'trial' ? validDeadline(value.startsAt) : value.kind === 'paid' && identity(value.tenureId));
}
export function isRetentionPolicy(value: unknown): value is RetentionPolicy {
  return record(value) && value.version === 1 && validDeadline(value.promisedUntil)
    && (value.deletedAt === undefined || validDeadline(value.deletedAt))
    && isRetentionOrigin(value);
}
export function isPaidTenure(value: unknown): value is PaidTenure {
  return record(value) && identity(value.id) && typeof value.uid === 'string' && value.uid.length > 0
    && (value.activatedAt === undefined || validDeadline(value.activatedAt))
    && validDeadline(value.startsAt) && validDeadline(value.paidAccessEndsAt) && value.startsAt < value.paidAccessEndsAt
    && validDeadline(value.paidAccessEndsAt + 60 * day) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
}
function tenure(context: RetentionContext | undefined, id: string) {
  const value = context?.tenures.get(id);
  return isPaidTenure(value) && value.id === id && value.uid === context?.uid ? value : null;
}
export function resolveRetention(resource: RetainedResource, now: number, context?: RetentionContext) {
  const invalid = { available: false, valid: false, expiresAt: null, mode: 'fixed' as const };
  if (!validDeadline(now)) return invalid;
  if (resource.retention === undefined) {
    return validDeadline(resource.expiresAt) ? { available: resource.expiresAt > now, valid: true, expiresAt: resource.expiresAt, mode: 'fixed' as const } : invalid;
  }
  if (!isRetentionPolicy(resource.retention)) return invalid;
  const policy = resource.retention;
  let paid: PaidTenure | null = null;
  let deadline: number;
  if (policy.kind === 'trial') {
    deadline = Math.max(policy.promisedUntil, policy.startsAt + (resource.kind === 'source' ? 14 : 30) * day);
    const promotion = context?.promotion;
    if (promotion !== undefined) {
      if (!validDeadline(promotion.at) || !identity(promotion.tenureId)) return invalid;
      if (promotion.at < policy.startsAt) return invalid;
      if (deadline > promotion.at) paid = tenure(context, promotion.tenureId);
      if (deadline > promotion.at && (!paid || paid.startsAt > promotion.at || paid.paidAccessEndsAt <= promotion.at)) return invalid;
    }
  } else {
    paid = tenure(context, policy.tenureId);
    if (!paid) return invalid;
    deadline = policy.promisedUntil;
  }
  if (paid) {
    if (resource.kind === 'source' && !validDeadline(resource.importedAt)) return invalid;
    deadline = Math.max(deadline, (resource.kind === 'source' ? resource.importedAt! : paid.paidAccessEndsAt) + 60 * day);
    if (resource.kind !== 'source' && context?.survivingTenures?.has(policy.promisedUntil)) {
      const surviving = context.survivingTenures.get(policy.promisedUntil);
      if (!isPaidTenure(surviving) || surviving.uid !== context.uid || !validDeadline(surviving.activatedAt) || surviving.activatedAt >= policy.promisedUntil) return invalid;
      deadline = Math.max(deadline, surviving.paidAccessEndsAt + 60 * day);
      if (surviving.paidAccessEndsAt > paid.paidAccessEndsAt) paid = surviving;
    }
  }
  if (!validDeadline(deadline)) return invalid;
  return { available: policy.deletedAt === undefined && deadline > now, valid: true, expiresAt: deadline, mode: paid && resource.kind !== 'source' && paid.paidAccessEndsAt > now ? 'while_paid' as const : 'fixed' as const };
}

