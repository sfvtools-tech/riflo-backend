import { resolveAccess } from './lifecycle.js';

export type SourceLimits = { maxSourceSeconds: number; maxSourceBytes: number };
export const legacySourceLimits: Readonly<SourceLimits> = Object.freeze({ maxSourceSeconds: 1800, maxSourceBytes: 2 * 1024 ** 3 });
export const sourcePlanLimits = Object.freeze({
  trial: Object.freeze({ maxSourceSeconds: 1800, maxSourceBytes: 3_000_000_000 }),
  lower: Object.freeze({ maxSourceSeconds: 2700, maxSourceBytes: 5_000_000_000 }),
  higher: Object.freeze({ maxSourceSeconds: 3600, maxSourceBytes: 6_000_000_000 }),
});

export function resolveSourceLimits(access: unknown, now: number): SourceLimits {
  const lifecycle = resolveAccess(access, now).lifecycle;
  if (lifecycle?.paid.state === 'active' && lifecycle.paid.plan) return { ...sourcePlanLimits[lifecycle.paid.plan] };
  if (lifecycle && ['eligible', 'active'].includes(lifecycle.trial.state)) return { ...sourcePlanLimits.trial };
  return { ...legacySourceLimits };
}

// Only absent historical snapshots use the old ceiling. Corrupt explicit snapshots fail closed.
export function acceptedSourceLimits(project: { sourceLimits?: SourceLimits }): SourceLimits {
  if (project.sourceLimits === undefined) return { ...legacySourceLimits };
  const limits = project.sourceLimits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !['maxSourceSeconds', 'maxSourceBytes'].includes(key)) || !Number.isSafeInteger(limits.maxSourceSeconds) || limits.maxSourceSeconds <= 0 || limits.maxSourceSeconds > sourcePlanLimits.higher.maxSourceSeconds || !Number.isSafeInteger(limits.maxSourceBytes) || limits.maxSourceBytes <= 0 || limits.maxSourceBytes > sourcePlanLimits.higher.maxSourceBytes) throw new Error('Invalid accepted source limits.');
  return { ...limits };
}

// Mono 16kHz signed 16-bit PCM plus a bounded WAV header.
export const sourceAudioBytes = (limits: SourceLimits) => limits.maxSourceSeconds * 32_000 + 64_000;
