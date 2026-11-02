import { acceptedSourceLimits, resolveSourceLimits, type SourceLimits } from '../access/source-limits.js';
import { liveTranscript, sourceExpiry, sourceAvailable, resolveRetention, type SavedTranscript } from '../generation/retention.js';
import { generationJobId, generationEventId, type GenerationBatch } from '../generation/service.js';
import { carouselLimits } from '../generation/config.js';
import { assetPath, videoPath } from '../generation/asset-paths.js';
import { queueStorageCleanup } from '../storage/cleanup.js';
import { sourceAttemptPaths } from './source.js';
import { createHash } from 'node:crypto';
import { createId } from '../shared/id.js';
import { workerEvent } from '../worker-health.js';
import { FieldValue, type Firestore, type Transaction, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { buildCapabilities, isGrant, operationalLimits, quotaKeys, isSharedCreditGrant, type Grant } from '../access/policy.js';
import { acceptedWorkAllowed, grantPeriod as periodId } from '../access/accepted-work.js';
import { OperationSupersededError, ProjectError, restorableSource, type Project, type ProjectStore, type JobClaim, type ImportResult } from './service.js';

import { admittedRetention, readRetentionContext, retentionPolicy } from '../access/retention-firestore.js';
import { readCounters, releaseSlotFunding, slotOwners } from '../access/accounting.js';
import { resolveAccess, isLifecycle } from '../access/lifecycle.js';
import { allocations, available, covered, readLedgers, releaseFunding, reserve, settleFunding, writeLedgers, type Ledgers } from '../access/funding.js';
type Runtime = { active: string | null; queued: number };
type Job = { uid: string; projectId: string; availableAt: number; workerId: string | null; attempt: number; attemptBase?: number; startedAt: number | null };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function activeGrant(value: unknown, now: number): Grant {
  const effective = resolveAccess(value, now).grant;
  if (!effective) {
    throw new ProjectError(403, 'subscription_required', 'An active subscription is required.');
  }
  return effective;
}


function validateSourceBounds(source: { bytes: number | null; durationSeconds: number | null }, limits: SourceLimits) {
  if (source.bytes !== null && (!Number.isSafeInteger(source.bytes) || source.bytes <= 0)) throw new ProjectError(422, 'invalid_video', 'The video size is invalid.');
  if (source.bytes !== null && source.bytes > limits.maxSourceBytes) throw new ProjectError(422, 'source_too_large', 'The video exceeds the source size limit.');
  if (source.durationSeconds !== null && (!Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0)) throw new ProjectError(422, 'invalid_video', 'The video duration is invalid.');
  if (source.durationSeconds !== null && source.durationSeconds > limits.maxSourceSeconds) throw new ProjectError(422, 'source_too_long', 'The video exceeds the source duration limit.');
}

export function createProjectStore(db: Firestore): ProjectStore {
  const account = (uid: string) => db.collection('accounts').doc(uid);
  const projects = (uid: string) => account(uid).collection('projects');
  const runtimeRef = (uid: string) => account(uid).collection('processing').doc('current');
  const allowanceRef = (uid: string, period: string) => account(uid).collection('allowances').doc(period);
  const jobs = db.collection('intakeJobs');
  let queueCursor: QueryDocumentSnapshot | undefined;
  let cleanupCursor: QueryDocumentSnapshot | undefined;
  const eventRef = (project: Project, attempt: number) => account(project.uid).collection('usageEvents').doc(`${project.id}-import-${attempt}`);
  const readRuntime = (value: unknown) => (value as Runtime | undefined) ?? { active: null, queued: 0 };
  const readAllowance = readCounters;
  const ownsClaim = (job: Job | undefined, claim: JobClaim, now: number) => job?.uid === claim.project.uid && job.projectId === claim.project.id && job.workerId === claim.workerId && job.attempt === claim.attempt && job.availableAt > now;
  const sameSource = (left: ImportResult, right: ImportResult) => left.storagePath === right.storagePath && left.sourceSha256 === right.sourceSha256 && left.bytes === right.bytes && left.durationSeconds === right.durationSeconds && left.mimeType === right.mimeType;
  function discardImportPreparation(transaction: Transaction, project: Project, now: number) {
    if (!project.preparation || project.importIntent === 'source_restore') return;
    const ref = projects(project.uid).doc(project.id);
    transaction.delete(ref.collection('transcripts').doc('shared'));
    transaction.update(ref, { preparation: 'failed', importUpload: FieldValue.delete() });
    if (project.importUpload) queueStorageCleanup(transaction, db.collection('assetCleanup').doc(`${project.id}-import-abandoned`), [project.importUpload.storagePath], now, project.deadline);
  }

  const sourceOwners = (project: Project) => project.reservedSourceSeconds === 0 ? [] : allocations(project.sourceFunding, project.period, project.reservedSourceSeconds, project.sourceAllowanceLimit ?? 0);
  const projectPeriods = (project: Project) => [project.period, ...sourceOwners(project).map(owner => owner.period)];
  function release(transaction: Transaction, project: Project, ledgers: Ledgers) {
    releaseFunding(ledgers, sourceOwners(project), 'sourceSeconds');
    writeLedgers(transaction, db, project.uid, ledgers);
  }
  function finishEvent(transaction: Transaction, claim: JobClaim, now: number, status: string, bytes: number | null, errorCode: string | null, sourceSeconds?: number) {
    transaction.set(eventRef(claim.project, claim.attempt), {
      status, endedAt: now, errorCode, period: claim.project.period,
      units: { sourceBytes: bytes, processingMilliseconds: Math.max(0, now - claim.startedAt), ...(sourceSeconds === undefined ? {} : { sourceSeconds }) },
    }, { merge: true });
  }

  async function effectiveProject(project: Project, transaction?: Transaction): Promise<Project> {
    if (!project.sourceRetention) return project;
    const accessRef = db.collection('subscriptionGrants').doc(project.uid);
    const access = (await (transaction ? transaction.get(accessRef) : accessRef.get())).data();
    const retention = await readRetentionContext(db, project.uid, access, [project.sourceRetention], transaction);
    return { ...project, sourceExpiresAt: sourceExpiry(project, retention) };
  }

  function replay(project: Project | undefined, key: { importOperationId?: string }): Project {
    if (!project || project.status === 'deleted') throw new ProjectError(409, "request_unresolved", "The original request is unavailable. Preserve its request key.");
    if (key.importOperationId && key.importOperationId !== project.importOperationId) throw new OperationSupersededError(project.id, key.importOperationId);
    return { ...project, importOperationId: key.importOperationId };
  }

  return {
    async preflight(uid, now) {
      // This is a cheap rejection only; final admission always rechecks atomically.
      await db.runTransaction(async transaction => {
        const raw = (await transaction.get(db.collection('subscriptionGrants').doc(uid))).data();
        const access = resolveAccess(raw, now);
        if (!access.lifecycle || access.lifecycle.paid.state === 'active' || !['eligible', 'active'].includes(access.lifecycle.trial.state)) return;
        const runtime = readRuntime((await transaction.get(runtimeRef(uid))).data());
        if (runtime.queued >= operationalLimits.queuedProjects) throw new ProjectError(429, 'queue_full', 'Your waiting project limit has been reached.');
        if (access.lifecycle.trial.state === 'active') {
          const ledgers = await readLedgers(transaction, db, uid, access.funding.map(periodId), true);
          if (available(access.funding, ledgers, 'sourceSeconds') < 1) throw new ProjectError(403, 'allowance_exceeded', 'Not enough source video allowance remains.');
        }
      });
    },
    async lookup(uid, key, input) {
      const saved = (await account(uid).collection('intakeKeys').doc(digest(key)).get()).data();
      if (!saved) return null;
      if (saved.fingerprint !== digest(JSON.stringify(input))) throw new ProjectError(409, 'idempotency_conflict', 'This request key belongs to a different video.');
      return effectiveProject(replay((await projects(uid).doc(saved.projectId).get()).data() as Project | undefined, saved));
    },
    async create(input) {
      return db.runTransaction(async (transaction) => {
        const keyRef = account(input.uid).collection('intakeKeys').doc(digest(input.key));
        const key = (await transaction.get(keyRef)).data();
        const fingerprint = digest(JSON.stringify(input.input));
        if (key) {
          if (key.fingerprint !== fingerprint) throw new ProjectError(409, 'idempotency_conflict', 'This request key belongs to a different video.');
          const existing = (await transaction.get(projects(input.uid).doc(key.projectId))).data() as Project | undefined;
          if (!existing) throw new ProjectError(409, 'idempotency_conflict', 'This request has already been handled.');
          return effectiveProject(replay(existing, key), transaction);
        }
        const access = (await transaction.get(db.collection('subscriptionGrants').doc(input.uid))).data();
        const grant = activeGrant(access, input.now);
        const sourceLimits = resolveSourceLimits(access, input.now);
        validateSourceBounds(input.source, sourceLimits);
        const funding = resolveAccess(access, input.now).funding;
        const period = periodId(grant);
        const ledgers = await readLedgers(transaction, db, input.uid, [period, ...funding.map(periodId)], true);
        const allowance = ledgers.get(period)!;
        const runtime = readRuntime((await transaction.get(runtimeRef(input.uid))).data());
        const seconds = input.source.durationSeconds === null ? sourceLimits.maxSourceSeconds : Math.ceil(input.source.durationSeconds);
        if (runtime.queued >= operationalLimits.queuedProjects) throw new ProjectError(429, 'queue_full', 'Your waiting project limit has been reached.');
        if (isSharedCreditGrant(grant) ? available(funding, ledgers, 'sourceSeconds') < seconds : allowance.reserved.sourceSeconds! + allowance.consumed.sourceSeconds! + seconds > grant.limits.sourceSeconds) {
          throw new ProjectError(403, 'allowance_exceeded', 'Not enough source video allowance remains.');
        }
        const retention = await readRetentionContext(db, input.uid, access, [], transaction);
        const retentionOrigin = admittedRetention(access, input.now, retention);
        const sourceFunding = isSharedCreditGrant(grant) ? reserve(funding, ledgers, 'sourceSeconds', seconds) : undefined;
        const project: Project = {
          ...(retentionOrigin ? { retentionOrigin, dedupVersion: 1 } : {}),
          ...(sourceFunding ? { sourceFunding } : {}),
          ...(isSharedCreditGrant(grant) ? { accounting: { mode: 'shared_credits' as const, period } } : {}),
          preparation: 'pending', sourceLimits, id: input.id, importOperationId: createId(), uid: input.uid, input: input.input, source: input.source, status: 'queued',
          createdAt: input.now, updatedAt: input.now, deadline: input.now + operationalLimits.projectLifetimeHours * 3_600_000,
          sourceRetentionDays: grant.sourceRetentionDays ?? operationalLimits.sourceRetentionDays, sourceAllowanceLimit: grant.limits.sourceSeconds, sourceExpiresAt: null, storagePath: null, attempts: 0, errorCode: null, period, reservedSourceSeconds: seconds,
        };
        if (!sourceFunding) allowance.reserved.sourceSeconds! += seconds;
        writeLedgers(transaction, db, input.uid, ledgers);
        transaction.set(runtimeRef(input.uid), { ...runtime, queued: runtime.queued + 1 });
        transaction.create(projects(input.uid).doc(input.id), project);
        transaction.create(jobs.doc(input.id), { uid: input.uid, projectId: input.id, availableAt: input.now, workerId: null, attempt: 0, startedAt: null });
        transaction.create(keyRef, { fingerprint, projectId: input.id, importOperationId: project.importOperationId, createdAt: input.now });
        return project;
      });
    },
    async lookupRetry(uid, id, key, intent) {
      const saved = (await account(uid).collection(intent ? 'sourceRestoreKeys' : 'importRetryKeys').doc(digest(key)).get()).data();
      if (!saved) return null;
      if (saved.projectId !== id) throw new ProjectError(409, 'idempotency_conflict', 'This request key belongs to a different project.');
      return effectiveProject(replay((await projects(uid).doc(id).get()).data() as Project | undefined, saved));
    },
    async retry(input) {
      return db.runTransaction(async (transaction) => {
        const ref = projects(input.uid).doc(input.id);
        const keyRef = account(input.uid).collection(input.intent ? 'sourceRestoreKeys' : 'importRetryKeys').doc(digest(input.key));
        const key = (await transaction.get(keyRef)).data();
        const project = (await transaction.get(ref)).data() as Project | undefined;
        if (!project || project.status === 'deleted') throw new ProjectError(404, 'project_not_found', 'Project not found.');
        if (key) {
          if (key.projectId !== input.id) throw new ProjectError(409, 'idempotency_conflict', 'This request key belongs to a different project.');
          return effectiveProject(replay(project, key), transaction);
        }
        if ((!input.intent && (project.status !== 'failed' || project.importIntent === 'source_restore')) || project.attempts !== input.attempts || project.updatedAt !== input.updatedAt) throw new ProjectError(409, input.intent ? 'source_restore_not_available' : 'import_not_failed', 'This import has already changed. Refresh the project.');
        const retryAvailableAt = project.retryAvailableAt ?? project.updatedAt + operationalLimits.importRetryCooldownSeconds * 1000;
        if (project.status === 'failed' && retryAvailableAt > input.now) throw new ProjectError(429, 'retry_cooldown', 'Wait a moment before retrying this import.', Math.ceil((retryAvailableAt - input.now) / 1000));
        const access = (await transaction.get(db.collection('subscriptionGrants').doc(input.uid))).data();
        const generation = (await transaction.get(ref.collection('generation').doc('batch'))).data() as GenerationBatch | undefined;
        const transcript = (await transaction.get(ref.collection('transcripts').doc('shared'))).data() as SavedTranscript | undefined;
        const retention = await readRetentionContext(db, input.uid, access, [project.sourceRetention, transcript?.retention, generation?.retentionOrigin], transaction);
        if (input.intent) {
          const effective = { ...project, sourceExpiresAt: sourceExpiry(project, retention) };
          const sourceState = resolveRetention({ kind: 'source', expiresAt: project.sourceExpiresAt, retention: project.sourceRetention, importedAt: project.importedAt }, input.now, retention);
          if (!restorableSource(effective, input.now) || (!sourceState.valid && project.status !== 'failed')) throw new ProjectError(409, 'source_restore_not_available', 'Only an unavailable source copy can be restored.');
          if (generation && ['queued', 'transcribing', 'generating'].includes(generation.status)) throw new ProjectError(409, 'generation_in_progress', 'Wait for current content generation to finish before restoring the source.');
          if (liveTranscript(transcript, generation, input.now, retention) && (!project.sourceSha256 || !/^[a-f0-9]{64}$/.test(project.sourceSha256) || transcript.sourceSha256 !== project.sourceSha256)) throw new ProjectError(409, 'source_identity_unverified', 'The original source identity cannot be verified for the retained transcript. Import this video as a new project; your retained content stays available.');
        }
        const grant = activeGrant(access, input.now);
        const sourceLimits = resolveSourceLimits(access, input.now);
        validateSourceBounds(input.source, sourceLimits);
        const funding = resolveAccess(access, input.now).funding;
        const period = periodId(grant);
        const ledgers = await readLedgers(transaction, db, input.uid, [period, ...funding.map(periodId)], true);
        const allowance = ledgers.get(period)!;
        const runtime = readRuntime((await transaction.get(runtimeRef(input.uid))).data());
        const job = await transaction.get(jobs.doc(input.id));
        if (job.exists || runtime.active === input.id) throw new ProjectError(409, 'import_not_failed', 'This import is already running.');
        const seconds = input.source.durationSeconds === null ? sourceLimits.maxSourceSeconds : Math.ceil(input.source.durationSeconds);
        if (runtime.queued >= operationalLimits.queuedProjects) throw new ProjectError(429, 'queue_full', 'Your waiting project limit has been reached.');
        const remainingSeconds = isSharedCreditGrant(grant) ? available(funding, ledgers, 'sourceSeconds') : Math.max(0, grant.limits.sourceSeconds - allowance.reserved.sourceSeconds! - allowance.consumed.sourceSeconds!);
        if (seconds > remainingSeconds) throw new ProjectError(403, 'allowance_exceeded', `This import needs ${seconds} seconds of source video allowance; ${remainingSeconds} seconds remain. Other imported videos may have allowance reserved.`, undefined, { requiredSeconds: seconds, remainingSeconds });
        const retentionOrigin = admittedRetention(access, input.now, retention);
        const sourceFunding = isSharedCreditGrant(grant) ? reserve(funding, ledgers, 'sourceSeconds', seconds) : undefined;
        const updated: Project = { ...project, ...(input.intent ? { importIntent: input.intent } : {}), sourceLimits, ...(retentionOrigin ? { retentionOrigin } : {}), ...(sourceFunding ? { sourceFunding } : {}), ...(isSharedCreditGrant(grant) ? { accounting: { mode: 'shared_credits' as const, period } } : {}), importOperationId: createId(), sourceRetentionDays: grant.sourceRetentionDays ?? operationalLimits.sourceRetentionDays, sourceAllowanceLimit: grant.limits.sourceSeconds, source: input.intent ? project.source : input.source, status: 'queued', retryAvailableAt: null, updatedAt: input.now, deadline: input.now + operationalLimits.projectLifetimeHours * 3_600_000, sourceExpiresAt: null, storagePath: null, errorCode: null, period, reservedSourceSeconds: seconds };
        if (!isSharedCreditGrant(grant)) { delete updated.accounting; delete updated.sourceFunding; }
        if (!retentionOrigin) delete updated.retentionOrigin;
        delete updated.importProgress; delete updated.sourceRetention; delete updated.importedAt; delete updated.sourceCleanupAt; delete updated.importUpload;
        if (!input.intent && updated.preparation) updated.preparation = 'pending';
        if (!sourceFunding) allowance.reserved.sourceSeconds! += seconds;
        writeLedgers(transaction, db, input.uid, ledgers);
        transaction.set(runtimeRef(input.uid), { ...runtime, queued: runtime.queued + 1 });
        transaction.set(ref, updated);
        // Attempts remain monotonic so old workers, files and usage events cannot collide.
        transaction.create(jobs.doc(input.id), { uid: input.uid, projectId: input.id, availableAt: input.now, workerId: null, attempt: project.attempts, attemptBase: project.attempts, startedAt: null });
        transaction.create(keyRef, { projectId: input.id, importOperationId: updated.importOperationId, createdAt: input.now });
        return updated;
      });
    },
    async get(uid, id) {
      const project = (await projects(uid).doc(id).get()).data() as Project | undefined;
      if (!project || project.status === 'deleted') return null;
      return effectiveProject(project);
    },
    async list(uid) {
      const saved = (await projects(uid).orderBy('createdAt', 'desc').limit(50).get()).docs.map(doc => doc.data() as Project).filter(project => project.status !== 'deleted');
      if (!saved.some(project => project.sourceRetention)) return saved;
      const access = (await db.collection('subscriptionGrants').doc(uid).get()).data();
      const retention = await readRetentionContext(db, uid, access, saved.map(project => project.sourceRetention));
      return saved.map(project => project.sourceRetention ? { ...project, sourceExpiresAt: sourceExpiry(project, retention) } : project);
    },
    async usage(uid, now) {
      const raw = (await db.collection('subscriptionGrants').doc(uid).get()).data();
      const resolved = resolveAccess(raw, now);
      const access = buildCapabilities(raw, new Date(now)).subscription;
      if (isLifecycle(raw) || raw == null) {
        const grants = [raw?.trial ? { kind: 'trial' as const, grant: raw.trial } : null, raw?.paid ? { kind: 'paid' as const, grant: raw.paid.grant } : null].filter((entry): entry is { kind: 'trial' | 'paid'; grant: import('../access/policy.js').SharedCreditGrant } => !!entry);
        const periods = await Promise.all(grants.map(async ({ kind, grant }) => {
          const usage = readAllowance((await allowanceRef(uid, periodId(grant)).get()).data(), true);
          const active = !raw?.withdrawn && Date.parse(grant.startsAt) <= now && Date.parse(grant.expiresAt) > now;
          const keys = ['sourceSeconds', 'creationCredits'] as const;
          return { kind, accounting: { mode: 'shared_credits' as const, periodId: grant.allowancePeriodId }, startsAt: grant.startsAt, expiresAt: grant.expiresAt, active, limits: { ...grant.limits }, reserved: Object.fromEntries(keys.map(key => [key, usage.reserved[key]!])), consumed: Object.fromEntries(keys.map(key => [key, usage.consumed[key]!])), remaining: Object.fromEntries(keys.map(key => [key, active ? Math.max(0, grant.limits[key] - usage.reserved[key]! - usage.consumed[key]!) : 0])) };
        }));
        const sum = (field: 'limits' | 'reserved' | 'consumed' | 'remaining') => Object.fromEntries(['sourceSeconds', 'creationCredits'].map(key => [key, periods.filter(period => period.active).reduce((total, period) => total + (period[field] as Record<string, number>)[key]!, 0)]));
        return { sourceLimits: resolveSourceLimits(raw, now), accounting: { mode: 'shared_credits' as const }, access, lifecycle: resolved.lifecycle, periods, startsAt: resolved.grant?.startsAt ?? null, expiresAt: resolved.grant?.expiresAt ?? null, limits: sum('limits'), reserved: sum('reserved'), consumed: sum('consumed'), remaining: sum('remaining') };
      }
      if (!isGrant(raw)) throw new ProjectError(403, 'subscription_required', 'Account access is unavailable.');
      const grant = raw;
      const allowance = readAllowance((await allowanceRef(uid, periodId(grant)).get()).data(), isSharedCreditGrant(grant));
      const keys = isSharedCreditGrant(grant) ? ['sourceSeconds', 'creationCredits'] : quotaKeys;
      const limits: Record<string, number> = grant.limits;
      return {
        ...(isSharedCreditGrant(grant) ? { accounting: { mode: 'shared_credits' as const, periodId: grant.allowancePeriodId } } : {}),
        sourceLimits: resolveSourceLimits(raw, now), access, startsAt: grant.startsAt, expiresAt: grant.expiresAt, limits,
        reserved: Object.fromEntries(keys.map(key => [key, allowance.reserved[key]!])),
        consumed: Object.fromEntries(keys.map(key => [key, allowance.consumed[key]!])),
        remaining: Object.fromEntries(keys.map(key => [key, access.active ? Math.max(0, limits[key]! - allowance.reserved[key]! - allowance.consumed[key]!) : 0])),
      };
    },
    async remove(uid, id, now, sourceOnly = false, expected) {
      return db.runTransaction(async (transaction) => {
        const ref = projects(uid).doc(id);
        const project = (await transaction.get(ref)).data() as Project | undefined;
        if (!project) return undefined;
        if (expected && (project.attempts !== expected.attempts || project.sourceExpiresAt !== expected.sourceExpiresAt || project.storagePath !== expected.storagePath || project.sourceExpiresAt === null || project.sourceExpiresAt > now)) return undefined;
        const access = (await transaction.get(db.collection('subscriptionGrants').doc(uid))).data();
        const runtime = readRuntime((await transaction.get(runtimeRef(uid))).data());
        const job = (await transaction.get(jobs.doc(id))).data() as Job | undefined;
        const generationRef = ref.collection('generation').doc('batch');
        const generation = (await transaction.get(generationRef)).data() as GenerationBatch | undefined;
        const periods = [...projectPeriods(project), ...(generation ? [generation.period, ...generation.slots.flatMap(slot => slotOwners(slot, generation).map(owner => owner.period))] : [])];
        const ledgers = await readLedgers(transaction, db, uid, periods, true);
        const transcript = (await transaction.get(ref.collection('transcripts').doc('shared'))).data() as SavedTranscript | undefined;
        const retention = await readRetentionContext(db, uid, access, [project.sourceRetention, transcript?.retention], transaction);
        const sourceState = resolveRetention({ kind: 'source', expiresAt: project.sourceExpiresAt, retention: project.sourceRetention, importedAt: project.importedAt }, now, retention);
        if (sourceOnly && (!sourceState.valid || sourceAvailable(project, now, retention))) {
          if (sourceState.valid) transaction.update(ref, { sourceCleanupAt: sourceState.expiresAt });
          else {
            transaction.update(ref, { sourceCleanupAt: null, sourceCleanupError: 'retention_facts_unavailable' });
            workerEvent('cleanup.quarantined', { code: 'retention_facts_unavailable' }, 'error');
          }
          return undefined;
        }
        const preserveTranscriptWork = sourceOnly && generation?.transcriptReady && generation.deadline > now && liveTranscript(transcript, generation, now, retention);
        const generationJobRef = db.collection('generationJobs').doc(generationJobId(id, generation?.id));
        const generationJob = (await transaction.get(generationJobRef)).data();
        const outputs = !sourceOnly ? await transaction.get(ref.collection('outputs').limit(50)) : null;
        let cancelGeneration = false;
        if (generationJob && generation) {
          for (const slot of generation.slots) {
            if (slot.status !== 'pending' || (preserveTranscriptWork && slot.feature !== 'short_videos')) continue;
            releaseSlotFunding(ledgers, slot, generation);
            slot.status = 'failed'; slot.errorCode = sourceOnly ? 'source_expired' : 'project_deleted';
          }
          cancelGeneration = !generation.slots.some(slot => slot.status === 'pending');
          const activeSlot = generation.slots.find(slot => slot.id === generationJob.slotId);
          const cancelClaim = cancelGeneration || generationJob.stage === 'transcribe' || activeSlot?.status === 'failed';
          const ready = generation.slots.filter(slot => slot.status === 'ready').length;
          transaction.set(generationRef, { slots: generation.slots, status: cancelGeneration ? ready ? 'partial' : 'failed' : generation.status, errorCode: cancelGeneration ? sourceOnly ? 'source_expired' : 'project_deleted' : generation.errorCode, updatedAt: now }, { merge: true });
          if (generationJob.claimId && cancelClaim) {
            const event = account(uid).collection('usageEvents').doc(generationEventId(id, generation?.id, generationJob.stage, generationJob.slotId ?? null, generationJob.attempt));
            transaction.set(event, { status: 'cancelled', endedAt: now, errorCode: sourceOnly ? 'source_expired' : 'project_deleted' }, { merge: true });
          }
          if (cancelGeneration) transaction.delete(generationJobRef);
          else if (cancelClaim) transaction.set(generationJobRef, { ...generationJob, claimId: null, workerId: null, availableAt: now });
        }

        {
          const paths = !sourceOnly ? outputs?.docs.flatMap((output) => (output.data().assets ?? []).map((asset: { storagePath: string }) => asset.storagePath)) ?? [] : [];
          for (const slot of generation?.slots ?? []) {
            if (slot.feature !== 'carousels' && slot.feature !== 'short_videos') continue;
            if (sourceOnly && preserveTranscriptWork && slot.feature === 'carousels' && slot.status === 'pending') continue;
            // Source expiry preserves the delivered attempt, but not abandoned files.
            const attempts = sourceOnly && slot.status === 'ready' ? slot.attempts - 1 : slot.attempts;
            for (let attempt = 1; attempt <= attempts; attempt++) {
              if (slot.feature === 'short_videos') paths.push(videoPath(uid, id, slot.id, attempt));
              else for (let slide = 1; slide <= carouselLimits.slides; slide++) paths.push(assetPath(uid, id, slot.id, attempt, slide));
            }
          }
          const sourcePaths = [project.storagePath, ...Array.from({ length: project.attempts }, (_, index) => sourceAttemptPaths(uid, id, index + 1)).flat()].filter((path): path is string => path !== null);
          queueStorageCleanup(transaction, db.collection('assetCleanup').doc(`${id}-${sourceOnly ? 'expired' : 'deleted'}`), [...paths, ...sourcePaths], now, Math.max(project.deadline, generation?.deadline ?? 0));
        }
        transaction.set(ref.collection('retentionDeletions').doc(`source-${id}`), { kind: 'source', deletedAt: now });
        if (!sourceOnly) {
          transaction.delete(ref.collection('transcripts').doc('shared'));
          transaction.update(ref, { payloadCleanupPending: true });
        }
        outputs?.docs.forEach((output) => transaction.delete(output.ref));
        if (project.status !== 'deleted' || generationJob) {
          const preserveSourceReservation = preserveTranscriptWork && generationJob && !cancelGeneration;
          if (preserveSourceReservation) writeLedgers(transaction, db, uid, ledgers);
          else release(transaction, project, ledgers);
          if (job || (generationJob && cancelGeneration)) {
            if (runtime.active === id) runtime.active = null;
            else runtime.queued = Math.max(0, runtime.queued - 1);
          }
          transaction.set(runtimeRef(uid), runtime);
          const status = sourceOnly ? (project.status === 'failed' || project.status === 'deleted' ? project.status : 'source_expired') : 'deleted';
          transaction.update(ref, { status, importProgress: FieldValue.delete(), updatedAt: now, reservedSourceSeconds: preserveSourceReservation ? project.reservedSourceSeconds : 0, storagePath: null, sourceCleanupAt: null, sourceExpiresAt: project.sourceExpiresAt ?? now, ...(project.sourceRetention ? { sourceRetention: { ...project.sourceRetention, deletedAt: now } } : {}) });
          transaction.delete(jobs.doc(id));
        }
        return project.storagePath;
      });
    },
    async claim(workerId, now, leaseMilliseconds) {
      // Continue past busy accounts without reading the entire queue in one pass.
      for (let page = 0; page < 10; page++) {
        let query = jobs.where('availableAt', '<=', now).orderBy('availableAt').limit(50);
        if (queueCursor) query = query.startAfter(queueCursor);
        const candidates = await query.get();
        if (candidates.empty) { queueCursor = undefined; return null; }
        for (const candidate of candidates.docs) {
          queueCursor = candidate;
          const claimed = await db.runTransaction(async (transaction) => {
            const job = (await transaction.get(candidate.ref)).data() as Job | undefined;
            if (!job || job.availableAt > now) return null;
            const ref = projects(job.uid).doc(job.projectId);
            const project = (await transaction.get(ref)).data() as Project | undefined;
            if (!project || project.status === 'deleted') { transaction.delete(candidate.ref); return null; }
            const runtime = readRuntime((await transaction.get(runtimeRef(job.uid))).data());
            if (runtime.active && runtime.active !== project.id) return null;
            const ledgers = await readLedgers(transaction, db, job.uid, projectPeriods(project), true);
            const rawGrant = (await transaction.get(db.collection('subscriptionGrants').doc(job.uid))).data();
            const subscriptionActive = acceptedWorkAllowed(rawGrant, project.period);
            const allowanceFits = project.reservedSourceSeconds > 0 && covered(ledgers, sourceOwners(project), 'sourceSeconds');
            if (!subscriptionActive || !allowanceFits || project.deadline <= now || job.attempt - (job.attemptBase ?? 0) >= operationalLimits.transientRetries + 1) {
              const errorCode = !subscriptionActive ? 'subscription_required' : !allowanceFits ? 'allowance_exceeded' : 'import_expired';
              release(transaction, project, ledgers);
              if (runtime.active === project.id) runtime.active = null;
              else runtime.queued = Math.max(0, runtime.queued - 1);
              transaction.set(runtimeRef(job.uid), runtime);
              transaction.update(ref, { status: 'failed', importProgress: FieldValue.delete(), retryAvailableAt: now + operationalLimits.importRetryCooldownSeconds * 1000, errorCode, reservedSourceSeconds: 0, updatedAt: now, sourceExpiresAt: now });
              transaction.delete(candidate.ref);
              discardImportPreparation(transaction, project, now);
              if (job.workerId && job.startedAt !== null) finishEvent(transaction, { project, workerId: job.workerId, attempt: job.attempt, startedAt: job.startedAt, leaseUntil: now }, now, 'failed', null, errorCode);
              return null;
            }
            if (job.workerId && job.attempt > 0) {
              finishEvent(transaction, { project, workerId: job.workerId, attempt: job.attempt, startedAt: job.startedAt!, leaseUntil: now }, now, 'interrupted', null, 'worker_interrupted');
            }
            if (runtime.active !== project.id) runtime.queued = Math.max(0, runtime.queued - 1);
            runtime.active = project.id;
            const attempt = job.attempt + 1;
            const leaseUntil = now + leaseMilliseconds;
            const importProgress = { attempt, stage: 'download' as const, transferredBytes: 0, totalBytes: null };
            const updated = { ...project, importProgress, status: 'importing' as const, attempts: attempt, updatedAt: now };
            transaction.set(runtimeRef(job.uid), runtime);
            transaction.update(ref, { status: 'importing', importProgress, attempts: attempt, updatedAt: now });
            transaction.set(candidate.ref, { ...job, workerId, attempt, startedAt: now, availableAt: leaseUntil });
            transaction.set(eventRef(project, attempt), {
              uid: project.uid, projectId: project.id, stage: 'source_import', attempt, provider: 'source' in project.input ? project.input.source : 'google_drive', model: null,
              credentialSource: 'source' in project.input ? 'none' : 'user', status: 'running', startedAt: now, endedAt: null, errorCode: null,
              units: { sourceBytes: 0, processingMilliseconds: 0 },
              // Missing infrastructure prices are unknown, never recorded as free.
              cost: { status: 'unknown', amountMicros: null, currency: 'USD', rateSnapshot: null },
            });
            return { project: updated, workerId, attempt, leaseUntil, startedAt: now };
          });
          if (claimed) return claimed;
        }
        if (candidates.size < 50) { queueCursor = undefined; return null; }
      }
      return null;
    },
    async progress(claim, progress, now) {
      const stages = ['download', 'prepare', 'upload', 'transcribe'];
      if (progress.attempt !== claim.attempt || !stages.includes(progress.stage) || !Number.isSafeInteger(progress.transferredBytes) || progress.transferredBytes < 0 || (progress.totalBytes !== null && (!Number.isSafeInteger(progress.totalBytes) || progress.totalBytes <= 0 || progress.totalBytes < progress.transferredBytes)) || (['prepare', 'transcribe'].includes(progress.stage) && (progress.transferredBytes !== 0 || progress.totalBytes !== null))) return false;
      return db.runTransaction(async transaction => {
        const job = (await transaction.get(jobs.doc(claim.project.id))).data() as Job | undefined;
        if (!ownsClaim(job, claim, now)) return false;
        const ref = projects(claim.project.uid).doc(claim.project.id);
        const project = (await transaction.get(ref)).data() as Project | undefined;
        if (!project || project.status !== 'importing' || project.attempts !== claim.attempt || project.deadline <= now) return false;
        const previous = project.importProgress;
        if (previous?.attempt === progress.attempt && (stages.indexOf(previous.stage) > stages.indexOf(progress.stage) || (previous.stage === progress.stage && previous.transferredBytes > progress.transferredBytes))) return false;
        transaction.update(ref, { importProgress: progress, updatedAt: now });
        return true;
      });
    },
    async renew(claim, now, leaseMilliseconds) {
      return db.runTransaction(async (transaction) => {
        const ref = jobs.doc(claim.project.id);
        const job = (await transaction.get(ref)).data() as Job | undefined;
        if (!ownsClaim(job, claim, now)) return false;
        const access = (await transaction.get(db.collection('subscriptionGrants').doc(claim.project.uid))).data();
        if (!acceptedWorkAllowed(access, claim.project.period)) return false;
        transaction.update(ref, { availableAt: now + leaseMilliseconds });
        return true;
      });
    },
    async checkpointSource(claim, result, now) {
      validateSourceBounds(result, acceptedSourceLimits(claim.project));
      if (!result.sourceSha256 || !/^[a-f0-9]{64}$/.test(result.sourceSha256) || !sourceAttemptPaths(claim.project.uid, claim.project.id, claim.attempt).includes(result.storagePath)) throw new ProjectError(422, 'invalid_video', 'The imported source receipt is invalid.');
      return db.runTransaction(async transaction => {
        const job = (await transaction.get(jobs.doc(claim.project.id))).data() as Job | undefined;
        const ref = projects(claim.project.uid).doc(claim.project.id);
        const project = (await transaction.get(ref)).data() as Project | undefined;
        const grant = (await transaction.get(db.collection('subscriptionGrants').doc(claim.project.uid))).data();
        if (!ownsClaim(job, claim, now) || !project || project.status !== 'importing' || project.importOperationId !== claim.project.importOperationId || project.deadline <= now || !acceptedWorkAllowed(grant, project.period)) return false;
        if (project.importUpload) return sameSource(project.importUpload, result);
        transaction.update(ref, { importUpload: { ...result, attempt: claim.attempt, operationId: project.importOperationId! }, updatedAt: now });
        return true;
      });
    },
    async complete(claim, result, now) {
      const limits = acceptedSourceLimits(claim.project);
      if ((result.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(result.sourceSha256)) || !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > limits.maxSourceBytes || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > limits.maxSourceSeconds) {
        throw new ProjectError(422, 'invalid_video', 'The imported video is outside the source limits.');
      }
      return db.runTransaction(async (transaction) => {
        const jobRef = jobs.doc(claim.project.id);
        const job = (await transaction.get(jobRef)).data() as Job | undefined;
        if (!ownsClaim(job, claim, now)) return false;
        const projectRef = projects(claim.project.uid).doc(claim.project.id);
        const project = (await transaction.get(projectRef)).data() as Project;
        validateSourceBounds(result, acceptedSourceLimits(project));
        const restoredReceipt = project.importUpload && project.importUpload.operationId === project.importOperationId && sameSource(project.importUpload, result);
        if (!sourceAttemptPaths(project.uid, project.id, claim.attempt).includes(result.storagePath) && !restoredReceipt) throw new ProjectError(422, 'invalid_video', 'The source receipt is not owned by this import.');
        const ledgers = await readLedgers(transaction, db, project.uid, projectPeriods(project), true);
        const allowance = ledgers.get(project.period)!;
        const grant = (await transaction.get(db.collection('subscriptionGrants').doc(project.uid))).data();
        const runtime = readRuntime((await transaction.get(runtimeRef(project.uid))).data());
        if (!acceptedWorkAllowed(grant, project.period)) throw new ProjectError(403, 'subscription_required', 'Access to this import was removed.');
        if (project.deadline <= now) throw new ProjectError(422, 'import_expired', 'The import deadline has passed.');
        if (!project.reservedSourceSeconds || !covered(ledgers, sourceOwners(project), 'sourceSeconds')) throw new ProjectError(403, 'allowance_exceeded', 'The original source reservation is unavailable.');
        const actual = Math.ceil(result.durationSeconds);
        if (project.sourceFunding) {
          try { settleFunding(ledgers, sourceOwners(project), 'sourceSeconds', actual); }
          catch { throw new ProjectError(403, 'allowance_exceeded', 'The imported video exceeds its original allowance.'); }
        } else {
          const adjusted = allowance.reserved.sourceSeconds! - project.reservedSourceSeconds + actual;
          const originalLimit = project.sourceAllowanceLimit ?? (isGrant(grant) && periodId(grant) === project.period && Date.parse(grant.expiresAt) > now ? grant.limits.sourceSeconds : null);
          if (actual > project.reservedSourceSeconds && (originalLimit === null || adjusted + allowance.consumed.sourceSeconds! > originalLimit)) throw new ProjectError(403, 'allowance_exceeded', 'The imported video exceeds its original allowance.');
          allowance.reserved.sourceSeconds! -= project.reservedSourceSeconds;
          allowance.consumed.sourceSeconds! += actual;
        }
        const transcript = project.importIntent === 'source_restore' || project.preparation ? (await transaction.get(projectRef.collection('transcripts').doc('shared'))).data() as SavedTranscript | undefined : undefined;
        const generation = project.importIntent === 'source_restore' || project.preparation ? (await transaction.get(projectRef.collection('generation').doc('batch'))).data() as GenerationBatch | undefined : undefined;
        const retention = await readRetentionContext(db, project.uid, grant, [project.retentionOrigin, transcript?.retention, generation?.retentionOrigin], transaction);
        if (project.importIntent === 'source_restore') {
          if (!result.sourceSha256) throw new ProjectError(409, 'source_identity_unverified', 'The imported source identity could not be verified. Restore the source again.');
          if (project.sourceSha256 && result.sourceSha256 !== project.sourceSha256) throw new ProjectError(409, 'source_changed', 'The original video has changed. Import it as a new project; your retained content stays available.');
          if (liveTranscript(transcript, generation, now, retention) && (!result.sourceSha256 || transcript.sourceSha256 !== result.sourceSha256)) throw new ProjectError(409, 'source_identity_unverified', 'The original source identity cannot be verified. Import this video as a new project; your retained content stays available.');
        }
        const sourceRetention = retentionPolicy('source', project.retentionOrigin, retention, now);
        const sourceExpiresAt = sourceRetention?.promisedUntil ?? now + (project.sourceRetentionDays ?? operationalLimits.sourceRetentionDays) * 86_400_000;
        const staged = transcript?.stagedImport;
        const matches = Boolean(staged && staged.operationId === project.importOperationId && staged.sourceSha256 === result.sourceSha256 && staged.durationSeconds === result.durationSeconds && transcript?.sourceSha256 === result.sourceSha256);
        const promote = matches && liveTranscript({ ...transcript!, stagedImport: undefined }, generation, now, retention);
        if (staged && !matches) throw new ProjectError(409, 'source_identity_unverified', 'The prepared transcript does not match this source.');
        if (staged && !promote) {
          transaction.delete(projectRef.collection('transcripts').doc('shared'));
          if (generation?.intent === 'import_transcription') transaction.update(projectRef.collection('generation').doc('batch'), { transcriptReady: false, status: 'failed', errorCode: 'transcript_unavailable', transcriptionFailure: { code: 'transcript_unavailable', retryable: true }, updatedAt: now });
        }
        if (promote) transaction.update(projectRef.collection('transcripts').doc('shared'), { stagedImport: FieldValue.delete() });
        const pendingTranscript = generation?.intent === 'import_transcription' && ['queued', 'transcribing'].includes(generation.status);
        writeLedgers(transaction, db, project.uid, ledgers);
        transaction.set(runtimeRef(project.uid), { ...runtime, active: pendingTranscript ? project.id : null });
        transaction.update(projectRef, {
          sourceSha256: result.sourceSha256 ?? FieldValue.delete(),
          importedAt: now, ...(sourceRetention ? { sourceRetention } : {}), sourceCleanupAt: sourceExpiresAt,
          status: 'source_ready', importProgress: FieldValue.delete(), importUpload: FieldValue.delete(), ...(project.preparation && project.importIntent !== 'source_restore' ? { preparation: promote ? 'ready' : pendingTranscript ? 'transcribing' : 'failed' } : {}), storagePath: result.storagePath, reservedSourceSeconds: 0, sourceAllowanceConsumed: true, updatedAt: now,
          source: { ...project.source, ...(result.mimeType ? { mimeType: result.mimeType } : {}), bytes: result.bytes, durationSeconds: result.durationSeconds, requiresProbe: false },
          sourceExpiresAt,
        });
        const obsoletePaths = Array.from({ length: Math.max(0, project.attempts - 1) }, (_, index) => sourceAttemptPaths(project.uid, project.id, index + 1)).flat().filter(path => path !== result.storagePath);
        queueStorageCleanup(transaction, db.collection('assetCleanup').doc(`${project.id}-source-unused`), obsoletePaths, now, Math.max(project.deadline, claim.leaseUntil));
        if (project.importIntent === 'source_restore') transaction.delete(projectRef.collection('retentionDeletions').doc(`source-${project.id}`));
        transaction.delete(jobRef);
        finishEvent(transaction, claim, now, 'succeeded', result.bytes, null, actual);
        return true;
      });
    },
    async fail(claim, failure, now) {
      return db.runTransaction(async (transaction) => {
        const jobRef = jobs.doc(claim.project.id);
        const job = (await transaction.get(jobRef)).data() as Job | undefined;
        if (!ownsClaim(job, claim, now)) return false;
        const projectRef = projects(claim.project.uid).doc(claim.project.id);
        const project = (await transaction.get(projectRef)).data() as Project;
        const runtime = readRuntime((await transaction.get(runtimeRef(project.uid))).data());
        const ledgers = await readLedgers(transaction, db, project.uid, projectPeriods(project), true);
        const grant = (await transaction.get(db.collection('subscriptionGrants').doc(project.uid))).data();
        const allowed = acceptedWorkAllowed(grant, project.period);
        const code = allowed ? failure.code : 'subscription_required';
        const shutdownRelease = failure.code === 'worker_shutdown' && failure.bytes === 0 && allowed && project.deadline > now;
        const retry = shutdownRelease || failure.retryable && allowed && claim.attempt - (job!.attemptBase ?? 0) <= operationalLimits.transientRetries && project.deadline > now;
        finishEvent(transaction, claim, now, shutdownRelease ? 'interrupted' : 'failed', failure.bytes, code);
        if (retry) {
          // The retry keeps this account's running slot; waiting projects cannot overtake it.
          transaction.update(jobRef, { workerId: null, startedAt: null, ...(shutdownRelease ? { attemptBase: (job!.attemptBase ?? 0) + 1 } : {}), availableAt: shutdownRelease ? now : now + 1000 * 2 ** (claim.attempt - (job!.attemptBase ?? 0)) });
          transaction.update(projectRef, { importProgress: FieldValue.delete(), errorCode: code, updatedAt: now });
        } else {
          release(transaction, project, ledgers);
          transaction.set(runtimeRef(project.uid), { ...runtime, active: null });
          transaction.update(projectRef, { status: 'failed', importProgress: FieldValue.delete(), retryAvailableAt: now + operationalLimits.importRetryCooldownSeconds * 1000, errorCode: code, reservedSourceSeconds: 0, updatedAt: now, sourceExpiresAt: now });
          transaction.delete(jobRef);
          discardImportPreparation(transaction, project, now);
        }
        return true;
      });
    },
    async finishCleanup(uid, id, now, expected) {
      await db.runTransaction(async (transaction) => {
        const ref = projects(uid).doc(id);
        const project = (await transaction.get(ref)).data() as Project | undefined;
        if (!project || !['deleted', 'source_expired', 'failed'].includes(project.status) || project.attempts !== expected.attempts || project.sourceExpiresAt !== expected.sourceExpiresAt || project.storagePath !== expected.storagePath) return;
        // Cleared expiry keeps completed cleanup from filling every later scan.
        transaction.update(ref, { storagePath: null, sourceCleanupAt: null, updatedAt: now });
      });
    },
    async expiredSources(now) {
      let query = db.collectionGroup('projects').where('sourceExpiresAt', '<=', now).orderBy('sourceExpiresAt').limit(50);
      if (cleanupCursor) query = query.startAfter(cleanupCursor);
      const snapshot = await query.get();
      // Advance past failed deletions too, then revisit them after the scan wraps.
      cleanupCursor = snapshot.size === 50 ? snapshot.docs.at(-1) : undefined;
      const managed = await db.collectionGroup('projects').where('sourceCleanupAt', '<=', now).limit(50).get();
      const candidates = [...managed.docs, ...snapshot.docs.filter(doc => doc.data().sourceCleanupAt === undefined)];
      return candidates.map((doc) => {
        const project = doc.data() as Project;
        return { uid: project.uid, id: project.id, storagePath: project.storagePath, attempts: project.attempts, sourceExpiresAt: project.sourceExpiresAt };
      });
    },
  };
}
