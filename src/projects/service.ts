import { legacySourceLimits, type SourceLimits } from '../access/source-limits.js';
import type { CreditAccounting } from '../access/accounting.js';
import type { Allocation } from '../access/funding.js';
import type { RequestIdentity } from '../access/trial-abuse.js';
import { operationalLimits } from '../access/policy.js';
import { createId } from '../shared/id.js';
import type { RetentionOrigin, RetentionPolicy } from '../generation/retention.js';
import { originalSourceUrl, parseSourceInput, type SourceInput, type SourceDetails } from '../sources/source.js';
export type { SourceDetails } from '../sources/source.js';

export class ProjectError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSeconds?: number, public allowance?: { requiredSeconds: number; remainingSeconds: number }) { super(message); }
}
export class OperationSupersededError extends ProjectError {
  readonly operation: { projectId: string; kind: 'import'; id: string };
  constructor(projectId: string, id: string) {
    super(409, 'operation_superseded', 'This request was accepted, but a newer import replaced its saved state. Read the current project.');
    this.operation = { projectId, kind: 'import', id };
  }
}
export type ImportProgress = { attempt: number; stage: 'download' | 'prepare' | 'upload' | 'transcribe'; transferredBytes: number; totalBytes: number | null };
export type Project = {
  transcriptionStage?: import('../generation/service.js').TranscriptionStage;
  preparation?: 'pending' | 'transcribing' | 'ready' | 'failed';
  importUpload?: ImportResult & { attempt: number; operationId: string };
  importProgress?: ImportProgress;
  importIntent?: 'source_restore';
  sourceSha256?: string;
  sourceLimits?: SourceLimits;
  importedAt?: number;
  retentionOrigin?: RetentionOrigin;
  sourceRetention?: RetentionPolicy;
  sourceCleanupAt?: number | null;
  dedupVersion?: 1;
  sourceFunding?: Allocation[];
  accounting?: CreditAccounting;
  importOperationId?: string;
  id: string; uid: string; status: 'queued' | 'importing' | 'source_ready' | 'source_expired' | 'failed' | 'deleted';
  input: SourceInput; source: SourceDetails; createdAt: number; updatedAt: number;
  deadline: number; sourceExpiresAt: number | null; storagePath: string | null;
  retryAvailableAt?: number | null;
  sourceRetentionDays?: 1 | 7 | 30;
  sourceAllowanceLimit?: number;
  sourceAllowanceConsumed?: boolean; attempts: number; errorCode: string | null; period: string; reservedSourceSeconds: number;
};
export type SourceCleanup = { uid: string; id: string; storagePath: string | null; attempts: number; sourceExpiresAt: number | null };
export type ImportResult = { sourceSha256?: string; bytes: number; durationSeconds: number; storagePath: string; mimeType?: string };
export type JobClaim = { project: Project; workerId: string; attempt: number; leaseUntil: number; startedAt: number };
export type ProjectStore = {
  preflight?: (uid: string, now: number) => Promise<void>;
  lookup: (uid: string, key: string, input: SourceInput) => Promise<Project | null>;
  create: (input: { uid: string; id: string; key: string; source: SourceDetails; input: SourceInput; now: number }) => Promise<Project>;
  lookupRetry: (uid: string, id: string, key: string, intent?: 'source_restore') => Promise<Project | null>;
  retry: (input: { intent?: 'source_restore'; uid: string; id: string; key: string; source: SourceDetails; attempts: number; updatedAt: number; now: number }) => Promise<Project>;
  get: (uid: string, id: string) => Promise<Project | null>;
  list: (uid: string) => Promise<Project[]>;
  usage: (uid: string, now: number) => Promise<{ limits: Record<string, number>; reserved: Record<string, number>; consumed: Record<string, number>; remaining: Record<string, number>; sourceLimits?: SourceLimits; access?: { active: boolean; reason: string; expiresAt: string | null } }>;
  remove: (uid: string, id: string, now: number, sourceOnly?: boolean, expected?: SourceCleanup) => Promise<string | null | undefined>;
  claim: (workerId: string, now: number, leaseMilliseconds: number) => Promise<JobClaim | null>;
  progress?: (claim: JobClaim, progress: ImportProgress, now: number) => Promise<boolean>;
  renew: (claim: JobClaim, now: number, leaseMilliseconds: number) => Promise<boolean>;
  complete: (claim: JobClaim, result: ImportResult, now: number) => Promise<boolean>;
  checkpointSource?: (claim: JobClaim, result: ImportResult, now: number) => Promise<boolean>;
  fail: (claim: JobClaim, failure: { code: string; retryable: boolean; bytes: number }, now: number) => Promise<boolean>;
  expiredSources: (now: number) => Promise<SourceCleanup[]>;
  finishCleanup: (uid: string, id: string, now: number, expected: SourceCleanup) => Promise<void>;
};

export type PublicSource = {
  name: string; bytes: number | null; durationSeconds: number | null;
} & ({ source: 'drive'; fileId: string } | { source: 'youtube'; videoId: string });

function publicSource(source: SourceDetails): PublicSource {
  const details = { name: source.name, bytes: source.bytes, durationSeconds: source.durationSeconds };
  return source.source === 'youtube'
    ? { source: 'youtube', videoId: source.videoId, ...details }
    : { source: 'drive', fileId: source.fileId, ...details };
}

export function publicProject(project: Project, now = Date.now(), allowance?: { requiredSeconds: number; remainingSeconds: number }) {
  const retryAvailableAt = project.status === 'failed' ? project.retryAvailableAt ?? project.updatedAt + operationalLimits.importRetryCooldownSeconds * 1000 : null;
  const coolingDown = retryAvailableAt !== null && retryAvailableAt > now;
  const canRestore = restorableSource(project, now);
  const sourceAccessRequired = ['youtube_video_restricted', 'youtube_video_unavailable', 'youtube_verification_required', 'file_not_found', 'file_access_denied', 'drive_file_unavailable', 'drive_reconnect_required'].includes(project.errorCode ?? '');
  const retryReason = project.status !== 'failed' ? 'import_not_failed'
    : coolingDown ? 'retry_cooldown' : allowance && allowance.requiredSeconds > allowance.remainingSeconds ? 'allowance_exceeded' : sourceAccessRequired ? 'source_access_required' : 'revalidation_required';
  return {
    ...(project.preparation === 'transcribing' && project.transcriptionStage ? { transcriptionStage: project.transcriptionStage } : {}),
    id: project.id, ...(project.preparation ? { preparation: project.preparation } : {}), ...(project.importIntent ? { importIntent: project.importIntent } : {}), importOperationId: project.importOperationId ?? null, status: project.status, source: publicSource(project.source),
    ...(project.status === 'importing' && project.importProgress ? { importProgress: project.importProgress } : {}),
    sourceUrl: originalSourceUrl(project.input),
    createdAt: new Date(project.createdAt).toISOString(),
    sourceExpiresAt: project.sourceExpiresAt === null ? null : new Date(project.sourceExpiresAt).toISOString(),
    errorCode: project.status === 'failed' ? project.errorCode : null,
    sourceRestore: {
      available: canRestore && !coolingDown && !(allowance && allowance.requiredSeconds > allowance.remainingSeconds),
      reason: !canRestore ? 'source_restore_not_available'
        : coolingDown ? 'retry_cooldown'
        : allowance && allowance.requiredSeconds > allowance.remainingSeconds ? 'allowance_exceeded' : 'revalidation_required',
      availableAt: project.importIntent === 'source_restore' && retryAvailableAt !== null ? new Date(retryAvailableAt).toISOString() : null,
    },
    importRetry: { available: project.importIntent !== 'source_restore' && project.status === 'failed' && !coolingDown && retryReason !== 'allowance_exceeded', reason: retryReason, availableAt: retryAvailableAt === null ? null : new Date(retryAvailableAt).toISOString(), ...(allowance ? { allowance } : {}) },
  };
}
export type PublicProject = ReturnType<typeof publicProject>;

export function restorableSource(project: Project, now: number) {
  return project.status === 'source_expired' || (project.status === 'source_ready' && project.sourceExpiresAt !== null && project.sourceExpiresAt <= now) || (project.status === 'failed' && project.importIntent === 'source_restore');
}

export function createProjectService({ store, validateSource, startTrial, beforeValidateSource, now = Date.now }: {
  store: ProjectStore;
  validateSource: (uid: string, input: SourceInput, signal?: AbortSignal) => Promise<SourceDetails>;
  startTrial?: (uid: string, now: number, input: SourceInput, identity?: RequestIdentity) => Promise<void>;
  beforeValidateSource?: (uid: string, input: SourceInput, identity?: RequestIdentity) => Promise<void>;
  now?: () => number;
}) {
  async function retryImport(uid: string, id: string, key: string, authorizeNewRequest?: () => Promise<void>, identity?: RequestIdentity, signal?: AbortSignal, intent?: 'source_restore') {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ProjectError(400, 'invalid_idempotency_key', 'Provide an Idempotency-Key of 8 to 128 letters, numbers, underscores or hyphens.');
    const existing = await store.lookupRetry(uid, id, key, intent);
    if (existing) return publicProject(existing, now());
    if (authorizeNewRequest) { await authorizeNewRequest(); }
    const project = await store.get(uid, id);
    if (!project) throw new ProjectError(404, 'project_not_found', 'Project not found.');
    if (intent ? !restorableSource(project, now()) : project.status !== 'failed' || project.importIntent === 'source_restore') throw new ProjectError(409, intent ? 'source_restore_not_available' : 'import_not_failed', intent ? 'Only an unavailable source copy can be restored.' : 'Only a failed import can be retried. Use Restore source for a failed restoration.');
    const retryAvailableAt = project.retryAvailableAt ?? project.updatedAt + operationalLimits.importRetryCooldownSeconds * 1000;
    if (project.status === 'failed' && retryAvailableAt > now()) throw new ProjectError(429, 'retry_cooldown', 'Wait a moment before retrying this import.', Math.ceil((retryAvailableAt - now()) / 1000));
    await store.preflight?.(uid, now());
    await beforeValidateSource?.(uid, project.input, identity);
    const source = await validateSource(uid, project.input, signal);
    return publicProject(await store.retry({ ...(intent ? { intent } : {}), uid, id, key, source, attempts: project.attempts, updatedAt: project.updatedAt, now: now() }), now());
  }
  return {
    async create(uid: string, value: unknown, key: string, authorizeNewRequest?: () => Promise<void>, identity?: RequestIdentity, signal?: AbortSignal) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ProjectError(400, 'invalid_idempotency_key', 'Provide an Idempotency-Key of 8 to 128 letters, numbers, underscores or hyphens.');
      const input = parseSourceInput(value);
      const existing = await store.lookup(uid, key, input);
      if (existing) return publicProject(existing, now());
      if (authorizeNewRequest) { await authorizeNewRequest(); }
      await store.preflight?.(uid, now());
      await beforeValidateSource?.(uid, input, identity);
      if (startTrial) { await startTrial(uid, now(), input, identity); }
      const source = await validateSource(uid, input, signal);
      return publicProject(await store.create({ uid, id: createId(), key, input, source, now: now() }), now());
    },
    retry: retryImport,
    restoreSource: (uid: string, id: string, key: string, authorizeNewRequest?: () => Promise<void>, identity?: RequestIdentity, signal?: AbortSignal) => retryImport(uid, id, key, authorizeNewRequest, identity, signal, 'source_restore'),
    async get(uid: string, id: string) {
      const project = await store.get(uid, id);
      if (!project) throw new ProjectError(404, 'project_not_found', 'Project not found.');
      if (project.status !== 'failed' && !restorableSource(project, now())) { return publicProject(project, now()); }
      try {
        const usage = await store.usage(uid, now());
        if (usage.access && !usage.access.active) {
          const result = publicProject(project, now());
          result.importRetry.available = false;
          result.importRetry.reason = 'subscription_required';
          result.sourceRestore.available = false;
          if (restorableSource(project, now())) result.sourceRestore.reason = 'subscription_required';
          return result;
        }
        return publicProject(project, now(), { requiredSeconds: project.source.durationSeconds === null ? (usage.sourceLimits ?? legacySourceLimits).maxSourceSeconds : Math.ceil(project.source.durationSeconds), remainingSeconds: usage.remaining.sourceSeconds! });
      } catch (error) {
        if (!(error instanceof ProjectError) || error.code !== 'subscription_required') { throw error; }
        const result = publicProject(project, now());
        result.importRetry.available = false;
        result.importRetry.reason = 'subscription_required';
        result.sourceRestore.available = false;
        if (restorableSource(project, now())) result.sourceRestore.reason = 'subscription_required';
        return result;
      }
    },
    async list(uid: string) { return (await store.list(uid)).map(project => publicProject(project, now())); },
    async usage(uid: string) { const { sourceLimits: _internalLimits, ...usage } = await store.usage(uid, now()); return usage; },
    async remove(uid: string, id: string) {
      await store.remove(uid, id, now());
      // The worker also removes files left by interrupted earlier attempts.
      return { deleted: true, cleanup: 'pending' as const };
    },
  };
}
export type ProjectService = ReturnType<typeof createProjectService>;
