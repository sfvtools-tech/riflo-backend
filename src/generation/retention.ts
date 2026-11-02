import { operationalLimits } from '../access/policy.js';
import type { Project } from '../projects/service.js';
import type { GenerationBatch, GeneratedOutput, Transcript } from './service.js';

import { resolveRetention, type RetentionPolicy, type RetentionContext } from '../access/retention.js';
export * from '../access/retention.js';
const day = 86_400_000;

export type SavedTranscript = Transcript & { stagedImport?: { operationId: string; sourceSha256: string; durationSeconds: number }; sourceSha256?: string; createdAt?: number; expiresAt?: number; retention?: RetentionPolicy };
export function sourceExpiry(project: Project, context?: RetentionContext) {
  return resolveRetention({ kind: 'source', expiresAt: project.sourceExpiresAt, retention: project.sourceRetention, importedAt: project.importedAt }, 0, context).expiresAt;
}
export function retainedOutput(output: GeneratedOutput, now: number, context?: RetentionContext): GeneratedOutput | null {
  const resolved = resolveRetention({ kind: 'output', expiresAt: output.expiresAt, retention: output.retention }, now, context);
  return resolved.available && resolved.expiresAt !== null ? { ...output, expiresAt: resolved.expiresAt, ...(output.retention ? { retentionMode: resolved.mode } : {}) } : null;
}
export function sourceAvailable(project: Project, now: number, context?: RetentionContext) {
  return project.status === 'source_ready' && Boolean(project.storagePath) && resolveRetention({ kind: 'source', expiresAt: project.sourceExpiresAt, retention: project.sourceRetention, importedAt: project.importedAt }, now, context).available;
}
export function transcriptExpiry(transcript: SavedTranscript, batch?: GenerationBatch, context?: RetentionContext) {
  // Old transcripts inherit a fixed saved batch time, never a fresh read time.
  const expiresAt = transcript.expiresAt ?? (transcript.createdAt ?? batch?.createdAt ?? 0) + operationalLimits.transcriptRetentionDays * day;
  return resolveRetention({ kind: 'transcript', expiresAt, retention: transcript.retention }, 0, context).expiresAt ?? Number.NaN;
}
export function liveTranscript(transcript: SavedTranscript | undefined, batch: GenerationBatch | undefined, now: number, context?: RetentionContext): transcript is SavedTranscript {
  if (!transcript || transcript.stagedImport) return false;
  const expiresAt = transcript.expiresAt ?? (transcript.createdAt ?? batch?.createdAt ?? 0) + operationalLimits.transcriptRetentionDays * day;
  return resolveRetention({ kind: 'transcript', expiresAt, retention: transcript.retention }, now, context).available;
}
