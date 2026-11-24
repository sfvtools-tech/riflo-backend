import type { Project } from '../projects/service.js';
import type { GeneratedOutput, Transcript } from './service.js';

import { resolveRetention, type RetentionPolicy, type RetentionContext } from '../access/retention.js';
export * from '../access/retention.js';

export type SavedTranscript = Transcript & { stagedImport?: { operationId: string; sourceSha256: string; durationSeconds: number }; sourceSha256?: string; createdAt?: number; expiresAt?: number; retention?: RetentionPolicy };
export function sourceExpiry(project: Project, context?: RetentionContext) {
  return resolveRetention({ kind: 'source', retention: project.sourceRetention, importedAt: project.importedAt }, 0, context).expiresAt;
}
export function retainedOutput(output: GeneratedOutput, now: number, context?: RetentionContext): GeneratedOutput | null {
  const resolved = resolveRetention({ kind: 'output', retention: output.retention }, now, context);
  return resolved.available && resolved.expiresAt !== null ? { ...output, expiresAt: resolved.expiresAt, retentionMode: resolved.mode } : null;
}
export function sourceAvailable(project: Project, now: number, context?: RetentionContext) {
  return project.status === 'source_ready' && Boolean(project.storagePath) && resolveRetention({ kind: 'source', retention: project.sourceRetention, importedAt: project.importedAt }, now, context).available;
}
export function transcriptExpiry(transcript: SavedTranscript, context?: RetentionContext) {
  return resolveRetention({ kind: 'transcript', retention: transcript.retention }, 0, context).expiresAt ?? Number.NaN;
}
export function liveTranscript(transcript: SavedTranscript | undefined, now: number, context?: RetentionContext): transcript is SavedTranscript {
  if (!transcript || transcript.stagedImport) return false;
  return resolveRetention({ kind: 'transcript', retention: transcript.retention }, now, context).available;
}
