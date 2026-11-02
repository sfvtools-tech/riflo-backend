import type { Project } from '../projects/service.js';
import { sourceAvailable, type RetentionContext } from './retention.js';
import type { GenerationAvailability, GenerationBatch } from './service.js';
import type { ValidationIssue } from './diagnostics.js';

// Bump when processing changes can make previously unsupported sources usable.
export const transcriptionSourceRulesVersion = 1;
export const transcriptionSourceRejected = (batch: GenerationBatch | undefined) => batch?.transcriptionFailure?.sourceRejectedVersion === transcriptionSourceRulesVersion;
export function rejectsTranscriptionSource(code: string, validation?: ValidationIssue) {
  return code === 'audio_too_large' || code === 'invalid_transcript' && validation !== undefined && ['empty_text', 'character_limit', 'item_count', 'byte_limit'].includes(validation.reason);
}

export function transcriptionAvailability(project: Project, batch: GenerationBatch | undefined, ready: boolean, activeAccess: boolean, now: number, context?: RetentionContext): NonNullable<GenerationAvailability['transcription']> {
  if (ready) return { status: 'ready', retryAvailable: false, reason: 'transcript_ready' };
  if (batch && ['queued', 'transcribing', 'generating'].includes(batch.status)) return { status: 'processing', retryAvailable: false, reason: 'generation_in_progress' };
  if (!sourceAvailable(project, now, context)) return { status: 'unavailable', retryAvailable: false, reason: project.status === 'source_expired' || (project.sourceExpiresAt !== null && project.sourceExpiresAt <= now) ? 'requires_reimport' : 'source_not_ready' };
  if (!activeAccess) return { status: 'unavailable', retryAvailable: false, reason: 'subscription_required' };
  if (transcriptionSourceRejected(batch)) return { status: 'failed', retryAvailable: false, reason: 'transcription_not_retryable', errorCode: batch!.transcriptionFailure!.code };
  if (project.preparation && (!batch || batch.transcriptReady || batch.transcriptionAttempts === 0)) return { status: 'failed', retryAvailable: true, reason: 'available', errorCode: 'transcription_unavailable' };
  if (!batch || batch.transcriptReady || batch.transcriptionAttempts === 0) return { status: 'not_started', retryAvailable: false, reason: 'transcription_not_failed' };
  // Older records may lack classification; recognize only known provider failures.
  const changedSourceRules = batch.transcriptionFailure?.sourceRejectedVersion !== undefined && !transcriptionSourceRejected(batch);
  // Provider authentication must be repaired before a new explicit attempt; do not auto-retry it.
  const failureCode = batch.transcriptionFailure?.code ?? batch.errorCode;
  const retryable = changedSourceRules || failureCode === 'transcription_configuration_failed' || failureCode === 'transcription_failed' || (batch.transcriptionFailure?.retryable ?? failureCode === 'transcription_unavailable');
  return { status: 'failed', retryAvailable: retryable, reason: retryable ? 'available' : 'transcription_not_retryable', errorCode: batch.transcriptionFailure?.code ?? batch.errorCode };
}
