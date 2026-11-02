import { featureIds, isGrant, isSharedCreditGrant, type FeatureId, type Grant, type SharedCreditGrant } from './policy.js';
import { plans, planGrant, trialOffering, upgradeOffering } from './plans.js';
import { isAccountRetention, type AccountRetention } from './retention.js';

export type Plan = keyof typeof plans;
export type LifecycleRecord = {
  retention?: AccountRetention;
  kind: 'lifecycle'; version: 1; revision: number; withdrawn: boolean;
  trial: SharedCreditGrant | null;
  paid: { plan: Plan; grant: SharedCreditGrant; cancelAtPeriodEnd: boolean; nextPlan: Plan | null } | null;
};
export type LifecycleCommand = { expectedRevision: number } & (
  { type: 'activate_paid' | 'renew'; plan: Plan; periodId: string; startsAt: string; expiresAt: string }
  | { type: 'upgrade' | 'cancel' | 'downgrade' | 'withdraw' }
);
export class LifecycleError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const plan = (value: unknown): value is Plan => typeof value === 'string' && Object.hasOwn(plans, value);
const active = (grant: Grant, now: number) => Date.parse(grant.startsAt) <= now && Date.parse(grant.expiresAt) > now;
export function isLifecycle(value: unknown): value is LifecycleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as LifecycleRecord;
  if (record.kind !== 'lifecycle' || record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.withdrawn !== 'boolean') return false;
  if (record.retention !== undefined && !isAccountRetention(record.retention)) return false;
  if (record.trial !== null && (!isGrant(record.trial) || !isSharedCreditGrant(record.trial))) return false;
  if (record.paid !== null && (!record.paid || !plan(record.paid.plan) || !isGrant(record.paid.grant) || !isSharedCreditGrant(record.paid.grant) || typeof record.paid.cancelAtPeriodEnd !== 'boolean' || record.paid.nextPlan !== null && !plan(record.paid.nextPlan))) return false;
  return !record.trial || !record.paid || record.trial.allowancePeriodId !== record.paid.grant.allowancePeriodId;
}
const empty = (): LifecycleRecord => ({ kind: 'lifecycle', version: 1, revision: 0, withdrawn: false, trial: null, paid: null });
function validated(record: LifecycleRecord): LifecycleRecord {
  if (!isLifecycle(record)) throw new LifecycleError(409, 'lifecycle_conflict', 'This transition would create invalid account access.');
  return record;
}

export function startTrial(value: unknown, periodId: string, now: number): LifecycleRecord {
  if (value != null && !isLifecycle(value)) throw new LifecycleError(409, 'lifecycle_conflict', 'This account requires explicit access migration.');
  const record = value == null ? empty() : value as LifecycleRecord;
  if (record.trial || record.paid || record.withdrawn) return record;
  if (!Number.isSafeInteger(now) || now < 0) throw new LifecycleError(400, 'invalid_lifecycle', 'Provide a valid trial start.');
  const trial: SharedCreditGrant = { status: 'active', accounting: 'shared_credits', allowancePeriodId: periodId, startsAt: new Date(now).toISOString(), expiresAt: new Date(now + trialOffering.days * 86_400_000).toISOString(), features: [...featureIds], limits: { creationCredits: trialOffering.creationCredits, sourceSeconds: trialOffering.sourceSeconds } };
  if (!isGrant(trial)) throw new LifecycleError(400, 'invalid_lifecycle', 'Provide a valid trial identity.');
  return validated({ ...record, trial, revision: record.revision + 1 });
}

export function transitionLifecycle(value: unknown, command: LifecycleCommand, now = Date.now()): LifecycleRecord {
  if (value != null && !isLifecycle(value)) throw new LifecycleError(409, 'lifecycle_conflict', 'This account requires explicit access migration.');
  const record = value == null ? empty() : value as LifecycleRecord;
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== record.revision) throw new LifecycleError(409, 'lifecycle_conflict', 'Account access has changed.');
  if (record.withdrawn) throw new LifecycleError(409, 'lifecycle_conflict', 'Access was explicitly withdrawn.');
  let paid = record.paid;
  if (command.type === 'activate_paid' || command.type === 'renew') {
    if (!plan(command.plan) || command.type === 'activate_paid' && paid && Date.parse(paid.grant.expiresAt) > now || command.type === 'renew' && !paid) throw new LifecycleError(409, 'lifecycle_conflict', 'This paid transition does not match account state.');
    const grant = planGrant(command.plan, command.periodId, command.startsAt, command.expiresAt);
    if (!isGrant(grant) || Date.parse(command.startsAt) > now || Date.parse(command.expiresAt) <= now || command.periodId === record.trial?.allowancePeriodId || command.periodId === paid?.grant.allowancePeriodId || paid && Date.parse(command.startsAt) < Date.parse(paid.grant.expiresAt)) throw new LifecycleError(409, 'lifecycle_conflict', 'Provide a current, new non-overlapping allowance period.');
    if (command.type === 'renew' && (paid!.cancelAtPeriodEnd || paid!.nextPlan && paid!.nextPlan !== command.plan)) throw new LifecycleError(409, 'lifecycle_conflict', 'Renewal conflicts with the saved plan change.');
    paid = { plan: command.plan, grant, cancelAtPeriodEnd: false, nextPlan: null };
  } else if (command.type === 'withdraw') {
    return validated({ ...record, withdrawn: true, revision: record.revision + 1 });
  } else {
    if (!paid) throw new LifecycleError(409, 'lifecycle_conflict', 'A paid period is required.');
    if (!active(paid.grant, now)) throw new LifecycleError(409, 'lifecycle_conflict', 'The current paid period is inactive.');
    if (command.type === 'upgrade') {
      if (paid.plan !== 'lower') throw new LifecycleError(409, 'lifecycle_conflict', 'This plan cannot be upgraded.');
      paid = { ...paid, plan: 'higher', grant: { ...paid.grant, limits: { creationCredits: paid.grant.limits.creationCredits + upgradeOffering.creationCredits, sourceSeconds: paid.grant.limits.sourceSeconds + upgradeOffering.sourceSeconds } }, nextPlan: null };
    } else if (command.type === 'cancel') paid = { ...paid, cancelAtPeriodEnd: true };
    else if (command.type === 'downgrade' && paid.plan === 'higher') paid = { ...paid, nextPlan: 'lower' };
    else throw new LifecycleError(409, 'lifecycle_conflict', 'Unsupported account transition.');
  }
  return validated({ ...record, paid, revision: record.revision + 1 });
}

export function resolveAccess(value: unknown, now: number) {
  if (value == null) value = empty();
  if (!isLifecycle(value)) {
    const grant = isGrant(value) && active(value, now) ? value : null;
    return { grant, funding: grant && isSharedCreditGrant(grant) ? [grant] : [], lifecycle: undefined };
  }
  const trial = value.trial;
  const paid = value.paid;
  const trialActive = !value.withdrawn && !!trial && active(trial, now);
  const paidActive = !value.withdrawn && !!paid && active(paid.grant, now);
  const deadlines = [trial, paid?.grant].filter((grant): grant is SharedCreditGrant => !!grant).flatMap(grant => [grant.startsAt, grant.expiresAt]).filter(date => Date.parse(date) > now).sort();
  return {
    grant: paidActive ? paid!.grant : trialActive ? trial! : null,
    funding: [trialActive ? trial : null, paidActive ? paid!.grant : null].filter((grant): grant is SharedCreditGrant => !!grant),
    lifecycle: {
      trial: { state: value.withdrawn ? 'unavailable' as const : !trial ? paid ? 'unavailable' as const : 'eligible' as const : trialActive ? 'active' as const : 'expired' as const, startsAt: trial?.startsAt ?? null, expiresAt: trial?.expiresAt ?? null },
      paid: { state: value.withdrawn ? 'withdrawn' as const : !paid ? 'none' as const : paidActive ? 'active' as const : Date.parse(paid.grant.startsAt) > now ? 'scheduled' as const : 'expired' as const, plan: paid?.plan ?? null, startsAt: paid?.grant.startsAt ?? null, expiresAt: paid?.grant.expiresAt ?? null, cancelAtPeriodEnd: paid?.cancelAtPeriodEnd ?? false, nextPlan: paid?.nextPlan ?? null },
      nextChangeAt: deadlines[0] ?? null,
    },
  };
}

export function lifecycleAccepted(value: unknown, period: string, features: readonly FeatureId[] = []) {
  if (!isLifecycle(value) || value.withdrawn) return false;
  const grants = [value.trial, value.paid?.grant].filter((grant): grant is SharedCreditGrant => !!grant);
  const admitted = grants.find(grant => `shared-${grant.allowancePeriodId}` === period);
  // A renewed period retains authority for already reserved work.
  return admitted ? features.every(feature => admitted.features.includes(feature)) : grants.length > 0;
}
