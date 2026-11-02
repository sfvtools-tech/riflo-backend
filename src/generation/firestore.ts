import { validateControlsWindow, type GenerationControls } from './controls.js';
import type { BrandRequest } from '../brand/generation.js';
import { traceWorkerAwait } from '../worker-trace.js';
import { safeValidationIssue, type ValidationIssue } from './diagnostics.js';
import { createHash } from 'node:crypto';
import { createId } from '../shared/id.js';
import { FieldValue, type Firestore, type QueryDocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { carouselLimits, shortVideoLimits } from './config.js';
import { assetPath, videoPath } from './asset-paths.js';
import { buildCapabilities, operationalLimits, isSharedCreditGrant, creationCreditCosts } from '../access/policy.js';
import { acceptedWorkAllowed, grantPeriod as periodOf } from '../access/accepted-work.js';
import type { Project } from '../projects/service.js';
import { acceptedSourceLimits } from '../access/source-limits.js';
import { sourceAttemptPaths } from '../projects/source.js';
import { generationFeatures, generationJobId, generationEventId, GenerationError, type GenerationAvailability, type GenerationBatch, type GenerationClaim, type GenerationStore, type GeneratedOutput, type OutputAsset, type GenerationUsage, type RateSnapshot, type Selection, type Slot } from './service.js';
import { liveTranscript, sourceAvailable, sourceExpiry, transcriptExpiry, retainedOutput, resolveRetention, type SavedTranscript } from './retention.js';
import { runStorageCleanup, queueStorageCleanup } from '../storage/cleanup.js';
import { shortVideoDuration, validateShortVideo, validateCarousel, validateLongForm, validatePost, validateXThread, validateTranscript } from './validation.js';
import { rejectsTranscriptionSource, transcriptionAvailability, transcriptionSourceRejected, transcriptionSourceRulesVersion } from './transcription.js';
import { canonicalOutput, outputFingerprint } from './history.js';

import { emptyCounters, readCounters, releaseSlotFunding, slotCharge, slotOwners } from '../access/accounting.js';
import { workerEvent } from '../worker-health.js';
import { resolveAccess } from '../access/lifecycle.js';
import { admittedRetention, readRetentionContext, retentionPolicy } from '../access/retention-firestore.js';
import { allocations, available, covered, readLedgers, releaseFunding, reserve, settleFunding, writeLedgers, type Ledgers } from '../access/funding.js';
type Runtime = { active: string | null; queued: number };
type Job = { importOwner?: GenerationClaim['importOwner'] | null; batchId?: string; uid: string; projectId: string; availableAt: number; claimId: string | null; workerId: string | null; stage?: string; slotId?: string | null; attempt?: number; startedAt?: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const generationRequestFingerprint = (selection: Selection, brand?: BrandRequest, intent?: GenerationBatch['intent'], controls?: GenerationControls) => {
  const legacy = intent ? { selection, intent } : brand?.mode === 'none' || brand?.overrides ? { selection, brand } : selection;
  return digest(JSON.stringify(controls && Object.keys(controls).length ? { request: legacy, controls } : legacy));
};
const finalAttemptRecorded = (event: { status?: string; errorCode?: string } | undefined) => event?.status === 'succeeded' || event?.errorCode === 'duplicate_generated_output';
const empty = emptyCounters;

export function estimateCost(usage: GenerationUsage, rates: RateSnapshot | null, stage: 'transcribe' | 'generate') {
  const unknown = { status: 'unknown' as const, amountMicros: null, currency: 'USD', rateSnapshot: rates };
  if (!rates) return unknown;
  let amount: number;
  if (stage === 'transcribe') {
    if (usage.seconds === null || rates.transcriptionMicrosPerMinute === null) return unknown;
    amount = usage.seconds * rates.transcriptionMicrosPerMinute / 60;
  } else {
    if (usage.textCalls?.some(call => call.model !== rates.model)) return unknown;
    const terms = [
      [usage.nonCachedInputTokens, rates.inputMicrosPerMillion], [usage.outputTokens, rates.outputMicrosPerMillion],
      [usage.cacheReadTokens, rates.cacheReadMicrosPerMillion], [usage.cacheWriteTokens, rates.cacheWriteMicrosPerMillion],
    ];
    if (terms.some(([quantity, rate]) => quantity === null || (quantity! > 0 && rate === null))) return unknown;
    amount = terms.reduce((sum, [quantity, rate]) => sum + quantity! * (rate ?? 0) / 1_000_000, 0);
  }
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) return unknown;
  return { status: 'estimated' as const, amountMicros: Math.ceil(amount), currency: 'USD', rateSnapshot: rates };
}

export function createGenerationStore(db: Firestore, storage?: { remove: (path: string) => Promise<void> }): GenerationStore {
  const account = (uid: string) => db.collection('accounts').doc(uid);
  const projectRef = (uid: string, id: string) => account(uid).collection('projects').doc(id);
  const batchRef = (uid: string, id: string) => projectRef(uid, id).collection('generation').doc('batch');
  const historyRef = (uid: string, id: string, batchId: string) => projectRef(uid, id).collection('generation').doc(`history-${batchId}`);
  const requestRef = (uid: string, id: string, keyHash: string) => projectRef(uid, id).collection('generationRequests').doc(keyHash);
  const transcriptRef = (uid: string, id: string) => projectRef(uid, id).collection('transcripts').doc('shared');
  const outputRefs = (uid: string, id: string) => projectRef(uid, id).collection('outputs');
  const usageRef = (uid: string, period: string) => account(uid).collection('allowances').doc(period);
  const runtimeRef = (uid: string) => account(uid).collection('processing').doc('current');
  const jobs = db.collection('generationJobs');
  let cursor: QueryDocumentSnapshot | undefined;
  const retentionCursors = new Map<string, QueryDocumentSnapshot>();
  const eventRef = (claim: GenerationClaim) => account(claim.project.uid).collection('usageEvents').doc(generationEventId(claim.project.id, claim.batch.id, claim.stage, claim.slot?.id ?? null, claim.attempt));
  const validClaim = (job: Job | undefined, claim: GenerationClaim, now: number) => (job?.batchId ?? 'batch') === (claim.batch.id ?? 'batch') && job?.uid === claim.project.uid && job.projectId === claim.project.id && job.claimId === claim.claimId && job.workerId === claim.workerId && job.stage === claim.stage && job.slotId === (claim.slot?.id ?? null) && (claim.importOwner ? job.importOwner?.workerId === claim.importOwner.workerId && job.importOwner.attempt === claim.importOwner.attempt && job.importOwner.operationId === claim.importOwner.operationId : !job.importOwner && job.availableAt > now);
  const counters = readCounters;
  const runtime = (value: unknown) => (value as Runtime | undefined) ?? { active: null, queued: 0 };
  function grant(value: unknown, now: number) {
    const effective = resolveAccess(value, now).grant;
    if (!effective) throw new GenerationError(403, 'subscription_required', 'An active subscription is required.');
    return effective;
  }
  const sourceOwners = (project: Project) => project.reservedSourceSeconds === 0 ? [] : allocations(project.sourceFunding, project.period, project.reservedSourceSeconds, project.sourceAllowanceLimit ?? 0);
  async function batchLedgers(transaction: Transaction, uid: string, batch: GenerationBatch, project: Project) {
    return readLedgers(transaction, db, uid, [batch.period, project.period, ...sourceOwners(project).map(owner => owner.period), ...batch.slots.filter(slot => slot.status === 'pending').flatMap(slot => slotOwners(slot, batch).map(owner => owner.period))], true);
  }
  function reservationsCover(batch: GenerationBatch, project: Project, usage: Ledgers) {
    const required = new Map<string, Map<string, number>>();
    try {
      for (const slot of batch.slots.filter(slot => slot.status === 'pending')) {
        if (!generationFeatures.includes(slot.feature)) return false;
        const key = slotCharge(slot, batch).key;
        for (const owner of slotOwners(slot, batch)) {
          const counters = required.get(owner.period) ?? new Map<string, number>();
          counters.set(key, (counters.get(key) ?? 0) + owner.amount);
          required.set(owner.period, counters);
        }
      }
      return [...required].every(([period, keys]) => [...keys].every(([key, amount]) => Number.isSafeInteger(usage.get(period)?.reserved[key]) && usage.get(period)!.reserved[key]! >= amount))
        && (batch.intent === 'transcription_retry' || covered(usage, sourceOwners(project), 'sourceSeconds'));
    } catch { return false; }
  }
  async function claimResources(transaction: Transaction, claim: GenerationClaim, now: number) {
    const project = (await transaction.get(projectRef(claim.project.uid, claim.project.id))).data() as Project | undefined;
    const batch = (await transaction.get(batchRef(claim.project.uid, claim.project.id))).data() as GenerationBatch | undefined;
    const transcript = (await transaction.get(transcriptRef(claim.project.uid, claim.project.id))).data() as SavedTranscript | undefined;
    const plan = (await transaction.get(db.collection('subscriptionGrants').doc(claim.project.uid))).data();
    const intake = claim.importOwner ? (await transaction.get(db.collection('intakeJobs').doc(claim.project.id))).data() : undefined;
    const retention = await readRetentionContext(db, claim.project.uid, plan, [project?.sourceRetention, transcript?.retention, batch?.retentionOrigin], transaction);
    const usage = batch && project ? await batchLedgers(transaction, claim.project.uid, batch, project) : new Map();
    const slot = batch?.slots.find(entry => entry.id === claim.slot?.id);
    const active = (batch?.id ?? 'batch') === (claim.batch.id ?? 'batch') && project && project.status !== 'deleted' && batch && batch.deadline > now && ['queued', 'transcribing', 'generating'].includes(batch.status);
    const authorized = Boolean(batch && acceptedWorkAllowed(plan, batch.period, batch.slots.filter(slot => slot.status === 'pending').map(slot => slot.feature)));
    const reserved = Boolean(batch && project && reservationsCover(batch, project, usage));
    const importOwned = !claim.importOwner || Boolean(project?.status === 'importing' && project.importOperationId === claim.importOwner.operationId && intake?.uid === project.uid && intake.projectId === project.id && intake.workerId === claim.importOwner.workerId && intake.attempt === claim.importOwner.attempt && intake.availableAt > now && project.deadline > now);
    const localSource = Boolean(claim.importOwner && importOwned && batch?.intent === 'import_transcription' && batch.importSource?.operationId === claim.importOwner.operationId && batch.importSource.result.sourceSha256 === claim.project.sourceSha256 && batch.importSource.result.durationSeconds === claim.project.source.durationSeconds && batch.importSource.result.bytes === claim.project.source.bytes);
    const available = Boolean(active && authorized && reserved && importOwned && (claim.stage === 'transcribe'
      ? (localSource || sourceAvailable(project, now, retention)) && !batch.transcriptReady && batch.transcriptionAttempts === claim.attempt
      : slot?.status === 'pending' && slot.attempts === claim.attempt && liveTranscript(transcript, batch, now, retention) && (slot.feature !== 'short_videos' || sourceAvailable(project, now, retention))));
    return { project, batch, transcript, available, authorized, reserved, retention, usage, importOwned };
  }
  function recordEvent(transaction: Transaction, claim: GenerationClaim, now: number, status: string, result: { usage: GenerationUsage; provider: string; model: string; rates: RateSnapshot | null; promptVersion?: string | null; validation?: ValidationIssue }, errorCode: string | null) {
    const validation = safeValidationIssue(Object.getOwnPropertyDescriptor(result, 'validation')?.value);
    transaction.set(eventRef(claim), {
      uid: claim.project.uid, projectId: claim.project.id, batchId: claim.batch.id ?? 'batch', stage: claim.stage, outputId: claim.slot?.id ?? null,
      attempt: claim.attempt, provider: result.provider, model: result.model, promptVersion: result.promptVersion ?? null,
      credentialSource: 'platform', status, startedAt: claim.startedAt, endedAt: now,
      units: { ...result.usage, processingMilliseconds: Math.max(0, now - claim.startedAt) },
      cost: estimateCost(result.usage, result.rates, claim.stage), errorCode, ...(validation ? { validation } : {}),
    }, { merge: true });
  }
  function queueUnusedAssets(transaction: Transaction, batch: GenerationBatch, now: number) {
    const paths: string[] = [];
    for (const slot of batch.slots) {
      if (slot.feature !== 'carousels' && slot.feature !== 'short_videos') continue;
      const attempts = slot.status === 'ready' ? slot.attempts - 1 : slot.attempts;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (slot.feature === 'short_videos') paths.push(videoPath(batch.uid, batch.projectId, slot.id, attempt));
        else for (let slide = 1; slide <= carouselLimits.slides; slide++) paths.push(assetPath(batch.uid, batch.projectId, slot.id, attempt, slide));
      }
    }
    queueStorageCleanup(transaction, db.collection('assetCleanup').doc(`${generationJobId(batch.projectId, batch.id)}-unused`), paths, now, batch.deadline);
  }
  function finishBatch(transaction: Transaction, batch: GenerationBatch, project: Project, usage: Ledgers, processing: Runtime, now: number) {
    const ready = batch.slots.filter((slot) => slot.status === 'ready').length;
    batch.status = batch.intent ? batch.transcriptReady ? 'completed' : 'failed' : ready === batch.slots.length ? 'completed' : ready ? 'partial' : 'failed';
    batch.updatedAt = now;
    if (!ready && !batch.intent && project.reservedSourceSeconds > 0) {
      releaseFunding(usage, sourceOwners(project), 'sourceSeconds');
      transaction.update(projectRef(project.uid, project.id), { reservedSourceSeconds: 0 });
    }
    if (processing.active === project.id && !(batch.intent === 'import_transcription' && project.status === 'importing')) processing.active = null;
    if (project.preparation && batch.intent) transaction.update(projectRef(project.uid, project.id), { preparation: batch.transcriptReady ? 'ready' : 'failed', updatedAt: now });
    transaction.set(runtimeRef(batch.uid), processing);
    writeLedgers(transaction, db, batch.uid, usage);
    transaction.set(batchRef(batch.uid, batch.projectId), batch, { merge: true });
    transaction.delete(jobs.doc(generationJobId(batch.projectId, batch.id)));
    queueUnusedAssets(transaction, batch, now);
  }
  function failPending(batch: GenerationBatch, usage: Ledgers, code: string) {
    for (const slot of batch.slots) {
      if (slot.status !== 'pending') continue;
      slot.status = 'failed'; slot.errorCode = code;
      releaseSlotFunding(usage, slot, batch);
    }
    batch.errorCode = code;
  }

  return {
    async claimImport(intakeClaim, source, now) {
      return db.runTransaction(async transaction => {
        const { uid, id } = intakeClaim.project;
        const project = (await transaction.get(projectRef(uid, id))).data() as Project | undefined;
        const intake = (await transaction.get(db.collection('intakeJobs').doc(id))).data();
        const owner = { workerId: intakeClaim.workerId, attempt: intakeClaim.attempt, operationId: intakeClaim.project.importOperationId! };
        if (!project || project.status !== 'importing' || !project.preparation || project.importIntent === 'source_restore' || !owner.operationId || project.importOperationId !== owner.operationId || intake?.uid !== uid || intake.projectId !== id || intake.workerId !== owner.workerId || intake.attempt !== owner.attempt || intake.availableAt <= now || project.deadline <= now) throw new GenerationError(409, 'stale_import', 'This import is no longer active.');
        const limits = acceptedSourceLimits(project);
        const receipt = project.importUpload;
        const ownedPath = sourceAttemptPaths(uid, id, owner.attempt).includes(source.storagePath) || receipt?.operationId === owner.operationId && receipt.storagePath === source.storagePath && receipt.sourceSha256 === source.sourceSha256 && receipt.durationSeconds === source.durationSeconds && receipt.bytes === source.bytes;
        if (!source.sourceSha256 || !/^[a-f0-9]{64}$/.test(source.sourceSha256) || !ownedPath || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || source.bytes > limits.maxSourceBytes || !Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0 || source.durationSeconds > limits.maxSourceSeconds) throw new GenerationError(422, 'invalid_video', 'The prepared source is invalid.');
        const existing = (await transaction.get(batchRef(uid, id))).data() as GenerationBatch | undefined;
        const transcript = (await transaction.get(transcriptRef(uid, id))).data() as SavedTranscript | undefined;
        const access = (await transaction.get(db.collection('subscriptionGrants').doc(uid))).data();
        const usage = await readLedgers(transaction, db, uid, [project.period, ...sourceOwners(project).map(owner => owner.period)], true);
        const retention = await readRetentionContext(db, uid, access, [project.retentionOrigin, transcript?.retention, existing?.retentionOrigin], transaction);
        const processing = runtime((await transaction.get(runtimeRef(uid))).data());
        if (!acceptedWorkAllowed(access, project.period)) throw new GenerationError(403, 'subscription_required', 'Access to this import was removed.');
        if (processing.active !== id || !project.reservedSourceSeconds || !covered(usage, sourceOwners(project), 'sourceSeconds')) throw new GenerationError(403, 'allowance_exceeded', 'The source reservation is unavailable.');
        const actual = Math.ceil(source.durationSeconds);
        // Authorize the same adjustment as source settlement, without charging twice.
        if (project.sourceFunding) {
          try { settleFunding(structuredClone(usage), sourceOwners(project), 'sourceSeconds', actual); }
          catch { throw new GenerationError(403, 'allowance_exceeded', 'The prepared source exceeds its original allowance.'); }
        } else {
          const allowance = usage.get(project.period)!;
          const adjusted = allowance.reserved.sourceSeconds! - project.reservedSourceSeconds + actual;
          const current = resolveAccess(access, now).grant;
          const limit = project.sourceAllowanceLimit ?? (current && periodOf(current) === project.period ? current.limits.sourceSeconds : null);
          if (actual > project.reservedSourceSeconds && (limit === null || adjusted + allowance.consumed.sourceSeconds! > limit)) throw new GenerationError(403, 'allowance_exceeded', 'The prepared source exceeds its original allowance.');
        }
        const sameImport = existing?.intent === 'import_transcription' && existing.importSource?.operationId === owner.operationId;
        if (sameImport && (existing.importSource!.result.sourceSha256 !== source.sourceSha256 || existing.importSource!.result.durationSeconds !== source.durationSeconds || existing.importSource!.result.bytes !== source.bytes)) throw new GenerationError(409, 'source_changed', 'The source changed while this import was being retried.');
        if (transcript?.stagedImport?.operationId === owner.operationId && transcript.stagedImport.sourceSha256 === source.sourceSha256 && transcript.stagedImport.durationSeconds === source.durationSeconds && liveTranscript({ ...transcript, stagedImport: undefined }, existing, now, retention)) return null;
        if (sameImport && existing.status === 'failed') return null;
        if (sameImport && existing.status === 'completed') {
          existing.transcriptReady = false;
          existing.transcriptionFailure = { code: 'transcription_unavailable', retryable: true };
          existing.errorCode = 'transcription_unavailable';
          finishBatch(transaction, existing, project, usage, processing, now);
          return null;
        }
        const snapshotRetention = retentionPolicy('output', project.retentionOrigin, retention);
        const snapshotExpiresAt = snapshotRetention?.promisedUntil ?? now + operationalLimits.outputRetentionDays * 86_400_000;
        const batch: GenerationBatch = sameImport ? existing : {
          id: createId(), uid, projectId: id, intent: 'import_transcription', importSource: { operationId: owner.operationId, result: source },
          ...(project.retentionOrigin ? { retentionOrigin: project.retentionOrigin } : {}),
          snapshotExpiresAt, snapshotCleanupAt: snapshotExpiresAt, ...(snapshotRetention ? { snapshotRetention } : {}),
          selection: { x_posts: 0, linkedin_posts: 0 }, slots: [], status: 'queued', createdAt: now, updatedAt: now,
          deadline: project.deadline, period: project.period, transcriptionAttempts: 0, transcriptReady: false, errorCode: null,
        };
        const jobRef = jobs.doc(generationJobId(id, batch.id));
        const previous = sameImport ? (await transaction.get(jobRef)).data() as Job | undefined : undefined;
        const priorEventRef = previous?.claimId ? account(uid).collection('usageEvents').doc(generationEventId(id, batch.id, 'transcribe', null, previous.attempt!)) : undefined;
        const prior = priorEventRef ? (await transaction.get(priorEventRef)).data() : undefined;
        if (previous?.importOwner?.attempt === owner.attempt && previous.importOwner.workerId === owner.workerId && previous.importOwner.operationId === owner.operationId) return null;
        if (priorEventRef && !finalAttemptRecorded(prior)) transaction.set(priorEventRef, { status: 'interrupted', endedAt: now, errorCode: 'transcription_interrupted' }, { merge: true });
        // Missing dispatch evidence is ambiguous too: only positive no-dispatch proof permits retry.
        if (previous?.claimId && prior?.providerInvoked !== false || batch.transcriptionAttempts >= 3) {
          batch.transcriptionFailure = { code: 'transcription_interrupted', retryable: true };
          batch.errorCode = 'transcription_interrupted';
          finishBatch(transaction, batch, project, usage, processing, now);
          return null;
        }
        if (!sameImport && existing) transaction.set(historyRef(uid, id, existing.id ?? 'batch'), existing);
        if (transcript?.stagedImport && !sameImport) transaction.delete(transcriptRef(uid, id));
        batch.transcriptionAttempts++;
        batch.status = 'transcribing';
        batch.transcriptionStage = 'preparing_audio';
        batch.updatedAt = now;
        const claim: GenerationClaim = {
          project: { ...project, sourceSha256: source.sourceSha256, storagePath: source.storagePath, source: { ...project.source, bytes: source.bytes, durationSeconds: source.durationSeconds } },
          batch, importOwner: owner, workerId: owner.workerId, claimId: createId(), stage: 'transcribe', slot: null,
          attempt: batch.transcriptionAttempts, startedAt: now, leaseUntil: intake.availableAt,
        };
        const keyHash = digest(`import:${owner.operationId}`);
        transaction.set(batchRef(uid, id), { ...batch, keyHash, fingerprint: generationRequestFingerprint(batch.selection, undefined, batch.intent) });
        transaction.set(jobRef, { uid, projectId: id, batchId: batch.id, availableAt: intake.availableAt, claimId: claim.claimId, workerId: owner.workerId, importOwner: owner, stage: 'transcribe', slotId: null, attempt: claim.attempt, startedAt: now });
        transaction.update(projectRef(uid, id), { preparation: 'transcribing', transcriptionStage: 'preparing_audio', updatedAt: now });
        transaction.set(eventRef(claim), { uid, projectId: id, batchId: batch.id, stage: 'transcribe', outputId: null, attempt: claim.attempt, status: 'running', providerInvoked: false, startedAt: now, endedAt: null, credentialSource: 'platform', cost: { status: 'unknown', amountMicros: null, currency: 'USD', rateSnapshot: null } });
        return claim;
      });
    },
    async lookup(uid, projectId, key, selection, brandRequest, intent, controls) {
      const project = (await projectRef(uid, projectId).get()).data() as Project | undefined;
      if (!project || project.status === 'deleted') throw new GenerationError(404, 'project_not_found', 'Project not found.');
      const existing = (await batchRef(uid, projectId).get()).data();
      const keyHash = digest(key);
      const request = (await requestRef(uid, projectId, keyHash).get()).data();
      if (!request && existing?.keyHash !== keyHash) return null;
      if ((request?.fingerprint ?? existing?.fingerprint) !== generationRequestFingerprint(selection, brandRequest, intent, controls)) throw new GenerationError(409, 'idempotency_conflict', 'This request key was used for different work.');
      const id = request?.batchId ?? existing?.id ?? 'batch';
      const saved = (existing?.id ?? 'batch') === id ? existing : (await historyRef(uid, projectId, id).get()).data();
      if (!saved) throw new GenerationError(409, 'request_unresolved', 'The original generation is unavailable. Preserve its request key.');
      return saved as GenerationBatch;
    },
    async start(uid, projectId, key, selection, now, brand, intent, controls) {
      return db.runTransaction(async (transaction) => {
        const project = (await transaction.get(projectRef(uid, projectId))).data() as Project | undefined;
        if (!project || project.status === 'deleted') throw new GenerationError(404, 'project_not_found', 'Project not found.');
        const existing = (await transaction.get(batchRef(uid, projectId))).data() as (GenerationBatch & { keyHash: string; fingerprint: string }) | undefined;
        const keyHash = digest(key);
        const fingerprint = generationRequestFingerprint(selection, brand?.request, intent, controls?.request);
        const request = (await transaction.get(requestRef(uid, projectId, keyHash))).data();
        if (request || existing?.keyHash === keyHash) {
          if ((request?.fingerprint ?? existing?.fingerprint) !== fingerprint) throw new GenerationError(409, 'idempotency_conflict', 'This request key was used with different outputs.');
          const id = request?.batchId ?? existing?.id ?? 'batch';
          const saved = (existing?.id ?? 'batch') === id ? existing : (await transaction.get(historyRef(uid, projectId, id))).data() as GenerationBatch | undefined;
          if (!saved) throw new GenerationError(409, 'generation_not_found', 'The original generation request is unavailable.');
          return saved;
        }
        if (controls) validateControlsWindow(controls.snapshot, project.source.durationSeconds);
        if (project.status === 'queued' || project.status === 'importing') throw new GenerationError(409, 'source_not_ready', 'Wait for the source import to finish.');
        if (existing && ['queued', 'transcribing', 'generating'].includes(existing.status)) throw new GenerationError(409, 'generation_in_progress', 'Wait for the current generation to finish.');
        const savedTranscript = (await transaction.get(transcriptRef(uid, projectId))).data() as SavedTranscript | undefined;
        const access = (await transaction.get(db.collection('subscriptionGrants').doc(uid))).data();
        const retention = await readRetentionContext(db, uid, access, [project.sourceRetention, savedTranscript?.retention, existing?.retentionOrigin], transaction);
        const retentionOrigin = admittedRetention(access, now, retention);
        const cached = liveTranscript(savedTranscript, existing, now, retention);
        const hasSource = sourceAvailable(project, now, retention);
        if (!hasSource && (!cached || (selection.short_videos ?? 0) > 0)) throw new GenerationError(409, project.status === 'source_expired' || (project.sourceExpiresAt !== null && project.sourceExpiresAt <= now) ? 'requires_reimport' : 'source_not_ready', 'Import the original video again for these outputs.');
        if (!intent && project.preparation && !cached) throw new GenerationError(409, 'transcript_not_ready', 'Prepare the transcript before creating content.');
        const plan = grant(access, now);
        const funding = resolveAccess(access, now).funding;
        const threadSettings = selection.x_posts > 0 && controls?.snapshot.formats.x_posts?.mode === 'thread' ? controls.snapshot.formats.x_posts : undefined;
        if (threadSettings && !isSharedCreditGrant(plan)) throw new GenerationError(403, 'generation_threads_unavailable', 'Threads require shared creation credits.');
        if (!intent && !cached && transcriptionSourceRejected(existing)) throw new GenerationError(409, 'transcription_not_retryable', 'This video cannot be transcribed within the supported audio limits. Use another source.');
        if (intent && !cached) {
          const state = transcriptionAvailability(project, existing, cached, true, now, retention);
          if (!state.retryAvailable) throw new GenerationError(409, state.reason, state.reason === 'transcription_not_retryable' ? 'This transcription failure needs attention before retrying. Check the source or contact support.' : 'Only a failed transcription can be retried.');
        }
        const period = periodOf(plan);
        const ledgers = await readLedgers(transaction, db, uid, [period, project.period, ...funding.map(periodOf), ...sourceOwners(project).map(owner => owner.period)], true);
        const usage = ledgers.get(period)!;
        const processing = runtime((await transaction.get(runtimeRef(uid))).data());
        if (!(intent && cached) && processing.queued >= operationalLimits.queuedProjects) throw new GenerationError(429, 'queue_full', 'Your waiting project limit has been reached.');
        const consumedSource = project.sourceAllowanceConsumed || existing?.slots.some(slot => slot.status === 'ready');
        // Only older imports can still need first-delivery source settlement.
        const reserveSource = !intent && !consumedSource;
        if (!intent && project.reservedSourceSeconds > 0) releaseFunding(ledgers, sourceOwners(project), 'sourceSeconds');
        const sourceSeconds = reserveSource ? Math.ceil(project.source.durationSeconds!) : 0;
        if (sourceSeconds > 0 && (isSharedCreditGrant(plan) ? available(funding, ledgers, 'sourceSeconds') < sourceSeconds : usage.reserved.sourceSeconds! + usage.consumed.sourceSeconds! + sourceSeconds > plan.limits.sourceSeconds)) throw new GenerationError(403, 'allowance_exceeded', 'Not enough source allowance remains.');
        const sourceFunding = isSharedCreditGrant(plan) ? reserve(funding, ledgers, 'sourceSeconds', sourceSeconds) : undefined;
        if (!sourceFunding) usage.reserved.sourceSeconds! += sourceSeconds;
        const batchId = createId();
        const slots: Slot[] = [];
        for (const feature of Object.keys(selection) as Array<keyof Selection>) {
          const count = selection[feature] ?? 0;
          if (count && !plan.features.includes(feature)) throw new GenerationError(403, 'feature_not_in_plan', 'A requested output is not included in your plan.');
          const key = isSharedCreditGrant(plan) ? 'creationCredits' : feature;
          const credits = feature === 'x_posts' && threadSettings ? threadSettings.maxPosts! : creationCreditCosts[feature];
          const amount = count * (isSharedCreditGrant(plan) ? credits : 1);
          const limit = isSharedCreditGrant(plan) ? plan.limits.creationCredits : plan.limits[feature];
          if (isSharedCreditGrant(plan) ? available(funding, ledgers, 'creationCredits') < amount : usage.reserved[key]! + usage.consumed[key]! + amount > limit) throw new GenerationError(403, 'allowance_exceeded', 'Not enough creation allowance remains.');
          if (!isSharedCreditGrant(plan)) usage.reserved[key]! += amount;
          for (let index = 1; index <= count; index++) {
            const owners = isSharedCreditGrant(plan) ? reserve(funding, ledgers, 'creationCredits', credits) : undefined;
            slots.push({ id: createId(), feature, ordinal: index, status: 'pending', attempts: 0, errorCode: null, ...(feature === 'x_posts' && threadSettings ? { maxCredits: credits } : {}), ...(owners ? { charge: { credits, period, allocations: owners } } : {}) });
          }
        }
        const snapshotRetention = retentionPolicy('output', retentionOrigin, retention);
        const snapshotExpiresAt = snapshotRetention?.promisedUntil ?? now + operationalLimits.outputRetentionDays * 86_400_000;
        const batch: GenerationBatch = { snapshotExpiresAt, snapshotCleanupAt: snapshotExpiresAt, ...(snapshotRetention ? { snapshotRetention } : {}), ...(retentionOrigin ? { retentionOrigin } : {}), ...(isSharedCreditGrant(plan) ? { accounting: { mode: 'shared_credits', period } } : {}), ...(brand ? { brand: brand.snapshot } : {}), ...(controls ? { controls: controls.snapshot } : {}), ...(intent ? { intent } : {}), id: batchId, uid, projectId, selection, slots, status: intent && cached ? 'completed' : 'queued', createdAt: now, updatedAt: now, deadline: now + operationalLimits.projectLifetimeHours * 3_600_000, period, transcriptionAttempts: 0, transcriptReady: cached, errorCode: null };
        if (existing) {
          transaction.set(historyRef(uid, projectId, existing.id ?? 'batch'), existing);
          transaction.set(requestRef(uid, projectId, existing.keyHash), { batchId: existing.id ?? 'batch', fingerprint: existing.fingerprint });
        }
        if (savedTranscript && savedTranscript.expiresAt === undefined) {
          // Freeze the old batch's deadline even for expired transcripts before replacing that batch.
          const expiresAt = transcriptExpiry(savedTranscript, existing, retention);
          if (Number.isFinite(expiresAt)) transaction.update(transcriptRef(uid, projectId), { expiresAt });
        }
        transaction.set(batchRef(uid, projectId), { ...batch, keyHash, fingerprint });
        transaction.create(requestRef(uid, projectId, keyHash), { batchId, fingerprint });
        if (!(intent && cached)) {
          transaction.create(jobs.doc(generationJobId(projectId, batchId)), { uid, projectId, batchId, availableAt: now, claimId: null, workerId: null });
          transaction.set(runtimeRef(uid), { ...processing, queued: processing.queued + 1 });
        }
        if (!intent) {
          transaction.update(projectRef(uid, projectId), { ...(!consumedSource ? { period, sourceFunding: sourceFunding ?? FieldValue.delete() } : {}), reservedSourceSeconds: sourceSeconds, sourceAllowanceConsumed: Boolean(consumedSource) });
          writeLedgers(transaction, db, uid, ledgers);
        } else if (consumedSource && !project.sourceAllowanceConsumed) {
          // Preserve known legacy delivery across a zero-output transcription batch.
          transaction.update(projectRef(uid, projectId), { sourceAllowanceConsumed: true });
        }
        return batch;
      });
    },
    async availability(uid, projectId, now) {
      const project = (await projectRef(uid, projectId).get()).data() as Project | undefined;
      if (!project || project.status === 'deleted') throw new GenerationError(404, 'project_not_found', 'Project not found.');
      const [batchDoc, transcriptDoc, planDoc] = await Promise.all([batchRef(uid, projectId).get(), transcriptRef(uid, projectId).get(), db.collection('subscriptionGrants').doc(uid).get()]);
      const batch = batchDoc.data() as GenerationBatch | undefined;
      const transcript = transcriptDoc.data() as SavedTranscript | undefined;
      const plan = planDoc.data();
      const retention = await readRetentionContext(db, uid, plan, [project.sourceRetention, transcript?.retention]);
      const hasTranscript = liveTranscript(transcript, batch, now, retention);
      const hasSource = sourceAvailable(project, now, retention);
      const resolved = resolveAccess(plan, now);
      const activePlan = resolved.grant;
      const ledgers: Ledgers = new Map(await Promise.all(resolved.funding.map(async grant => [periodOf(grant), counters((await usageRef(uid, periodOf(grant)).get()).data(), true)] as const)));
      const creationRemaining = available(resolved.funding, ledgers, 'creationCredits');
      const usage = activePlan ? ledgers.get(periodOf(activePlan)) ?? counters((await usageRef(uid, periodOf(activePlan)).get()).data(), isSharedCreditGrant(activePlan)) : empty();
      const sourceAllowanceAvailable = !activePlan || project.sourceAllowanceConsumed || batch?.slots.some(slot => slot.status === 'ready') || (isSharedCreditGrant(activePlan) ? available(resolved.funding, ledgers, 'sourceSeconds') + sourceOwners(project).filter(owner => ledgers.has(owner.period)).reduce((sum, owner) => sum + owner.amount, 0) >= Math.ceil(project.source.durationSeconds ?? 0) : usage.reserved.sourceSeconds! + usage.consumed.sourceSeconds! - (project.period === periodOf(activePlan) ? project.reservedSourceSeconds : 0) + Math.ceil(project.source.durationSeconds ?? 0) <= activePlan.limits.sourceSeconds);
      const activeBatch = Boolean(batch && ['queued', 'transcribing', 'generating'].includes(batch.status));
      const outputs = Object.fromEntries(generationFeatures.map(feature => {
        const reason = !activePlan ? 'subscription_required'
          : !activePlan.features.includes(feature) ? 'feature_not_in_plan'
          : activeBatch ? 'generation_in_progress'
          : !hasSource && (!hasTranscript || feature === 'short_videos') ? project.status === 'source_expired' || (project.sourceExpiresAt !== null && project.sourceExpiresAt <= now) ? 'requires_reimport' : 'source_not_ready'
          : project.preparation && !hasTranscript ? 'transcript_not_ready'
          : !hasTranscript && transcriptionSourceRejected(batch) ? 'transcription_not_retryable'
          : !sourceAllowanceAvailable || (isSharedCreditGrant(activePlan) ? creationCreditCosts[feature] > creationRemaining : usage.reserved[feature]! + usage.consumed[feature]! >= activePlan.limits[feature]) ? 'allowance_exceeded'
          : 'available';
        return [feature, { available: reason === 'available', reason }];
      })) as GenerationAvailability['outputs'];
      return {
        access: buildCapabilities(plan, new Date(now)).subscription,
        ...(resolved.lifecycle ? { lifecycle: resolved.lifecycle } : {}),
        ...(activePlan && isSharedCreditGrant(activePlan) ? { credits: { remaining: creationRemaining, costs: { ...creationCreditCosts } } } : {}),
        transcription: transcriptionAvailability(project, batch, hasTranscript, Boolean(activePlan), now, retention),
        sourceAvailable: hasSource, transcriptAvailable: hasTranscript, activeBatch, outputs,
        sourceExpiresAt: sourceExpiry(project, retention) === null ? null : new Date(sourceExpiry(project, retention)!).toISOString(),
        transcriptExpiresAt: transcript && Number.isFinite(transcriptExpiry(transcript, batch, retention)) ? new Date(transcriptExpiry(transcript, batch, retention)).toISOString() : null,
        ...(transcript?.retention ? { transcriptRetentionMode: resolveRetention({ kind: 'transcript', expiresAt: transcript.expiresAt, retention: transcript.retention }, now, retention).mode } : {}),
      };
    },
    async batch(uid, projectId) {
      const project = (await projectRef(uid, projectId).get()).data() as Project | undefined;
      return project && project.status !== 'deleted' ? (await batchRef(uid, projectId).get()).data() as GenerationBatch | undefined ?? null : null;
    },
    async outputs(uid, projectId, now, feature) {
      const project = (await projectRef(uid, projectId).get()).data() as Project | undefined;
      if (!project || project.status === 'deleted') throw new GenerationError(404, 'project_not_found', 'Project not found.');
      const query = outputRefs(uid, projectId);
      const outputs = (await (feature ? query.where('feature', '==', feature) : query).get()).docs.map(doc => doc.data() as GeneratedOutput);
      const access = (await db.collection('subscriptionGrants').doc(uid).get()).data();
      const retention = await readRetentionContext(db, uid, access, outputs.map(output => output.retention));
      return outputs.map(output => retainedOutput(output, now, retention)).filter((output): output is GeneratedOutput => output !== null)
        .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    },
    async output(uid, projectId, outputId, now) {
      const project = (await projectRef(uid, projectId).get()).data() as Project | undefined;
      if (!project || project.status === 'deleted') return null;
      const output = (await outputRefs(uid, projectId).doc(outputId).get()).data() as GeneratedOutput | undefined;
      if (!output) return null;
      const access = (await db.collection('subscriptionGrants').doc(uid).get()).data();
      const retention = await readRetentionContext(db, uid, access, [output.retention]);
      return retainedOutput(output, now, retention);
    },
    async referencesAssets(uid, projectId, outputId, paths) {
      const output = (await outputRefs(uid, projectId).doc(outputId).get()).data() as GeneratedOutput | undefined;
      if (!output) return false;
      if (output.assets !== undefined && !Array.isArray(output.assets)) throw new Error('Invalid stored asset ownership.');
      return output.assets?.some(asset => paths.includes(asset.storagePath)) ?? false;
    },
    async asset(uid, projectId, outputId, assetId, now) {
      const output = await this.output(uid, projectId, outputId, now);
      return output?.assets?.find(asset => asset.id === assetId) ?? null;
    },
    async transcript(uid, projectId, now = Date.now()) {
      const [saved, project, batch, access] = await Promise.all([transcriptRef(uid, projectId).get(), projectRef(uid, projectId).get(), batchRef(uid, projectId).get(), db.collection('subscriptionGrants').doc(uid).get()]);
      const transcript = saved.data() as SavedTranscript | undefined;
      const retention = await readRetentionContext(db, uid, access.data(), [transcript?.retention]);
      if (project.data()?.status === 'deleted' || !project.exists || !liveTranscript(transcript, batch.data() as GenerationBatch | undefined, now, retention)) return null;
      return { text: transcript.text, words: transcript.words };
    },
    async claim(workerId, now, leaseMilliseconds) {
      for (let page = 0; page < 10; page++) {
        let query = jobs.where('availableAt', '<=', now).orderBy('availableAt').limit(50);
        if (cursor) query = query.startAfter(cursor);
        const candidates = await traceWorkerAwait('generation.jobs-query', () => query.get(), {}, true);
        if (candidates.empty) { cursor = undefined; return null; }
        for (const candidate of candidates.docs) {
          cursor = candidate;
          const result = await traceWorkerAwait('generation.claim-transaction', () => db.runTransaction(async (transaction) => {
            const job = (await transaction.get(candidate.ref)).data() as Job | undefined;
            if (!job || job.availableAt > now) return null;
            const project = (await transaction.get(projectRef(job.uid, job.projectId))).data() as Project | undefined;
            const batch = (await transaction.get(batchRef(job.uid, job.projectId))).data() as GenerationBatch | undefined;
            if (!project || !batch || (job.batchId ?? 'batch') !== (batch.id ?? 'batch')) { transaction.delete(candidate.ref); return null; }
            if (batch.intent === 'import_transcription' && project.status === 'importing') return null;
            const processing = runtime((await transaction.get(runtimeRef(job.uid))).data());
            if (processing.active && processing.active !== project.id) return null;
            const usage = await batchLedgers(transaction, job.uid, batch, project);
            const plan = (await transaction.get(db.collection('subscriptionGrants').doc(job.uid))).data();
            const allowed = acceptedWorkAllowed(plan, batch.period, batch.slots.filter(slot => slot.status === 'pending').map(slot => slot.feature));
            const reserved = reservationsCover(batch, project, usage);
            const transcript = (await transaction.get(transcriptRef(job.uid, job.projectId))).data() as SavedTranscript | undefined;
            const retention = await readRetentionContext(db, job.uid, plan, [project.sourceRetention, transcript?.retention, batch.retentionOrigin], transaction);
            const hasTranscript = liveTranscript(transcript, batch, now, retention);
            const hasSource = sourceAvailable(project, now, retention);
            if (batch.transcriptReady && hasTranscript && !hasSource) {
              for (const slot of batch.slots) {
                if (slot.status !== 'pending' || slot.feature !== 'short_videos') continue;
                slot.status = 'failed'; slot.errorCode = 'source_expired';
                releaseSlotFunding(usage, slot, batch);
              }
            }
            if (job.claimId) {
              const priorEvent = account(job.uid).collection('usageEvents').doc(generationEventId(job.projectId, job.batchId, job.stage!, job.slotId ?? null, job.attempt!));
              const prior = (await transaction.get(priorEvent)).data();
              // A lost provider response needs an explicit retry, not another hidden paid request.
              if (batch.intent && prior?.providerInvoked !== false) {
                transaction.set(priorEvent, { status: 'interrupted', endedAt: now, errorCode: 'transcription_interrupted' }, { merge: true });
                batch.transcriptionFailure = { code: 'transcription_interrupted', retryable: true };
                failPending(batch, usage, 'transcription_interrupted');
                if (processing.active !== project.id) processing.queued = Math.max(0, processing.queued - 1);
                finishBatch(transaction, batch, project, usage, processing, now);
                return null;
              }
              // A lease can expire between claim and graceful release. Only positive
              // durable no-dispatch evidence exempts that attempt from the budget,
              // even when a late failure already marked its expired claim discarded.
              if (prior?.providerInvoked === false && allowed && reserved && project.status !== 'deleted' && batch.deadline > now) {
                if (job.stage === 'transcribe' && !batch.transcriptReady && hasSource && batch.transcriptionAttempts === job.attempt) {
                  batch.transcriptionPreDispatchReleases = (batch.transcriptionPreDispatchReleases ?? 0) + 1;
                } else if (job.stage === 'generate' && batch.transcriptReady && hasTranscript) {
                  const abandoned = batch.slots.find(entry => entry.id === job.slotId);
                  if (abandoned?.status === 'pending' && abandoned.attempts === job.attempt && !abandoned.lengthCorrectionStarted && (abandoned.feature !== 'short_videos' || hasSource)) abandoned.preDispatchReleases = (abandoned.preDispatchReleases ?? 0) + 1;
                }
              }
              transaction.set(priorEvent, { status: 'interrupted', endedAt: now, errorCode: 'worker_interrupted' }, { merge: true });
            }
            const slot = batch.transcriptReady ? batch.slots.find((entry) => entry.status === 'pending') ?? null : null;
            const attempts = batch.transcriptReady ? slot?.attempts ?? 3 : batch.transcriptionAttempts;
            const chargedAttempts = attempts - (batch.transcriptReady ? slot?.preDispatchReleases ?? 0 : batch.transcriptionPreDispatchReleases ?? 0);
            if ((chargedAttempts >= 3 || slot?.lengthCorrectionStarted) && batch.transcriptReady && slot && allowed && reserved && project.status !== 'deleted' && hasTranscript && batch.deadline > now) {
              slot.status = 'failed'; slot.errorCode = slot.lengthCorrectionStarted ? 'length_correction_interrupted' : 'attempts_exhausted';
              releaseSlotFunding(usage, slot, batch);
              if (batch.slots.every((entry) => entry.status !== 'pending')) finishBatch(transaction, batch, project, usage, processing, now);
              else {
                writeLedgers(transaction, db, job.uid, usage);
                transaction.set(batchRef(job.uid, job.projectId), batch, { merge: true });
                transaction.set(candidate.ref, { ...job, availableAt: now, claimId: null, workerId: null });
              }
              return null;
            }
            if (project.status === 'deleted' || (batch.transcriptReady ? !hasTranscript || !slot : !hasSource) || batch.deadline <= now || !allowed || !reserved || chargedAttempts >= 3) {
              const code = !allowed ? 'subscription_required' : !reserved ? 'allowance_exceeded'
                : batch.intent === 'import_transcription' && !batch.transcriptReady && batch.deadline <= now ? 'transcription_expired'
                : batch.intent === 'import_transcription' && !batch.transcriptReady && chargedAttempts >= 3 ? 'transcription_attempts_exhausted' : 'generation_expired';
              if (batch.intent === 'import_transcription' && !batch.transcriptReady && ['subscription_required', 'allowance_exceeded', 'transcription_expired', 'transcription_attempts_exhausted'].includes(code)) batch.transcriptionFailure = { code, retryable: true };
              failPending(batch, usage, code);
              if (processing.active !== project.id) processing.queued = Math.max(0, processing.queued - 1);
              finishBatch(transaction, batch, project, usage, processing, now);
              return null;
            }
            const stage = batch.transcriptReady ? 'generate' as const : 'transcribe' as const;
            const attempt = attempts + 1;
            if (slot) slot.attempts = attempt;
            else batch.transcriptionAttempts = attempt;
            if (processing.active !== project.id) processing.queued = Math.max(0, processing.queued - 1);
            processing.active = project.id;
            batch.status = stage === 'transcribe' ? 'transcribing' : 'generating';
            if (stage === 'transcribe') batch.transcriptionStage = 'preparing_audio';
            batch.updatedAt = now;
            const claimId = createId();
            const leaseUntil = now + leaseMilliseconds;
            const claim: GenerationClaim = { project: { ...project, sourceExpiresAt: sourceExpiry(project, retention) }, batch, workerId, claimId, stage, slot, attempt, startedAt: now, leaseUntil, transcriptExpiresAt: hasTranscript ? transcriptExpiry(transcript!, batch, retention) : null };
            if (!hasSource) writeLedgers(transaction, db, job.uid, usage);
            transaction.set(runtimeRef(job.uid), processing);
            transaction.set(batchRef(job.uid, job.projectId), batch, { merge: true });
            transaction.set(candidate.ref, { ...job, importOwner: null, claimId, workerId, availableAt: leaseUntil, stage, slotId: slot?.id ?? null, attempt, startedAt: now });
            if (project.preparation && stage === 'transcribe') transaction.update(projectRef(project.uid, project.id), { preparation: 'transcribing', transcriptionStage: 'preparing_audio', updatedAt: now });
            transaction.set(eventRef(claim), { uid: job.uid, projectId: job.projectId, batchId: batch.id ?? 'batch', stage, outputId: slot?.id ?? null, attempt, status: 'running', providerInvoked: false, startedAt: now, endedAt: null, credentialSource: 'platform', cost: { status: 'unknown', amountMicros: null, currency: 'USD', rateSnapshot: null } });
            return claim;
          }));
          if (result) return result;
        }
        if (candidates.size < 50) { cursor = undefined; return null; }
      }
      return null;
    },
    async markProviderInvoked(claim, metadata, now) {
      return db.runTransaction(async (transaction) => {
        const job = (await transaction.get(jobs.doc(generationJobId(claim.project.id, claim.batch.id)))).data() as Job | undefined;
        const resources = await claimResources(transaction, claim, now);
        if (!validClaim(job, claim, now) || !resources.available) return false;
        if (claim.stage === 'transcribe') {
          transaction.set(batchRef(claim.project.uid, claim.project.id), { transcriptionStage: 'transcribing', updatedAt: now }, { merge: true });
          if (resources.project?.preparation) transaction.update(projectRef(claim.project.uid, claim.project.id), { transcriptionStage: 'transcribing', updatedAt: now });
        }
        const slot = resources.batch?.slots.find(entry => entry.id === claim.slot?.id);
        if (slot?.lengthCorrectionStarted) return false;
        // Reserve the single correction before dispatch, including crash/lease recovery.
        if (metadata.lengthCorrection) {
          if (!slot || claim.stage !== 'generate') return false;
          slot.lengthCorrectionStarted = true;
          transaction.set(batchRef(claim.project.uid, claim.project.id), { slots: resources.batch!.slots }, { merge: true });
        }
        // Keep observed call details, but the in-flight correction makes totals unknown.
        transaction.set(eventRef(claim), {
          ...(metadata.lengthCorrection ? { units: { ...metadata.lengthCorrection.usage, inputTokens: null, outputTokens: null, nonCachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, lengthCorrectionStarted: true } : {}),
          providerInvoked: true, providerStartedAt: now, provider: metadata.provider, model: metadata.model, promptVersion: metadata.promptVersion ?? null,
          cost: { status: 'unknown', amountMicros: null, currency: 'USD', rateSnapshot: metadata.rates },
        }, { merge: true });
        return true;
      });
    },
    async renew(claim, now, leaseMilliseconds) {
      return db.runTransaction(async (transaction) => {
        const job = (await transaction.get(jobs.doc(generationJobId(claim.project.id, claim.batch.id)))).data() as Job | undefined;
        const resources = await claimResources(transaction, claim, now);
        if (!validClaim(job, claim, now) || !resources.available) return false;
        if (claim.importOwner) return true;
        claim.project.sourceExpiresAt = sourceExpiry(resources.project!, resources.retention);
        claim.transcriptExpiresAt = resources.transcript ? transcriptExpiry(resources.transcript, resources.batch, resources.retention) : null;
        transaction.update(jobs.doc(generationJobId(claim.project.id, claim.batch.id)), { availableAt: now + leaseMilliseconds });
        return true;
      });
    },
    async saveTranscript(claim, result, now) {
      const transcript = validateTranscript(result.value, claim.project.source.durationSeconds!);
      return db.runTransaction(async (transaction) => {
        const jobRef = jobs.doc(generationJobId(claim.project.id, claim.batch.id));
        const job = (await transaction.get(jobRef)).data() as Job | undefined;
        const { project, batch, available, authorized, reserved, retention, usage } = await claimResources(transaction, claim, now);
        if (validClaim(job, claim, now) && project && batch && (batch.id ?? 'batch') === (claim.batch.id ?? 'batch')) {
          if (!authorized) throw new GenerationError(403, 'subscription_required', 'Access to this generation was removed.');
          if (!reserved) throw new GenerationError(403, 'allowance_exceeded', 'The original generation reservation is unavailable.');
        }
        if (!validClaim(job, claim, now) || !project || !batch || !available) {
          const existing = (await transaction.get(eventRef(claim))).data();
          if (existing?.status !== 'succeeded') recordEvent(transaction, claim, now, 'discarded', result, 'stale_generation');
          return false;
        }
        const processing = batch.intent ? runtime((await transaction.get(runtimeRef(project.uid))).data()) : undefined;
        const policy = retentionPolicy('transcript', batch.retentionOrigin, retention);
        transaction.set(transcriptRef(project.uid, project.id), { ...transcript, ...(claim.importOwner ? { stagedImport: { operationId: claim.importOwner.operationId, sourceSha256: claim.project.sourceSha256!, durationSeconds: claim.project.source.durationSeconds! } } : {}), ...(claim.project.sourceSha256 ? { sourceSha256: claim.project.sourceSha256 } : {}), ...(policy ? { retention: policy } : {}), createdAt: now, expiresAt: policy?.promisedUntil ?? now + operationalLimits.transcriptRetentionDays * 86_400_000, cleanupAt: policy?.promisedUntil ?? now + operationalLimits.transcriptRetentionDays * 86_400_000 });
        if (batch.intent) {
          batch.transcriptReady = true;
          batch.transcriptionFailure = null;
          batch.errorCode = null;
          finishBatch(transaction, batch, project, usage, processing!, now);
        } else {
          transaction.set(batchRef(project.uid, project.id), { transcriptReady: true, transcriptionFailure: null, status: 'generating', updatedAt: now }, { merge: true });
          transaction.set(jobRef, { ...job, availableAt: now, claimId: null, workerId: null });
        }
        recordEvent(transaction, claim, now, 'succeeded', result, null);
        return true;
      });
    },
    async saveOutput(claim, result, now) {
      const feature = claim.slot!.feature;
      const transcript = feature === 'short_videos' ? await this.transcript(claim.project.uid, claim.project.id, now) : undefined;
      if (feature === 'short_videos' && !transcript) throw new GenerationError(502, 'transcript_unavailable', 'The saved transcript is unavailable.');
      const video = transcript ? validateShortVideo(result.value, transcript, claim.project.source.durationSeconds!, claim.batch.controls) : null;
      const carousel = feature === 'carousels' ? validateCarousel(result.value, claim.batch.controls) : null;
      const longForm = feature === 'blogs' || feature === 'newsletters' ? validateLongForm(result.value, feature) : null;
      const threadSettings = feature === 'x_posts' && claim.batch.controls?.formats.x_posts?.mode === 'thread' ? claim.batch.controls.formats.x_posts : undefined;
      const thread = threadSettings ? validateXThread(result.value, threadSettings) : null;
      const text = thread?.text ?? video?.text ?? carousel?.text ?? longForm?.text ?? validatePost({ text: result.value }, feature as 'x_posts' | 'linkedin_posts');
      const content = { text, data: thread?.content ?? longForm?.content ?? carousel?.content ?? video?.content };
      if (carousel && (!Array.isArray(result.assets) || result.assets.length !== carouselLimits.slides || result.assets.some((asset, index) => asset.id !== `slide-${index + 1}` || asset.storagePath !== assetPath(claim.project.uid, claim.project.id, claim.slot!.id, claim.attempt, index + 1) || asset.contentType !== 'image/png' || asset.width !== carouselLimits.width || asset.height !== carouselLimits.height || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > carouselLimits.maxImageBytes))) throw new GenerationError(502, 'carousel_render_failed', 'All five carousel images are required before delivery.');
      if (video && (!Array.isArray(result.assets) || result.assets.length !== 1 || result.assets.some((asset) => asset.id !== 'clip' || asset.storagePath !== videoPath(claim.project.uid, claim.project.id, claim.slot!.id, claim.attempt) || asset.contentType !== 'video/mp4' || asset.width !== shortVideoLimits.width || asset.height !== shortVideoLimits.height || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes >= shortVideoLimits.maxBytes || !Number.isFinite(asset.durationSeconds) || Math.abs(asset.durationSeconds! - shortVideoDuration(video.content)) > 0.1))) throw new GenerationError(502, 'video_render_failed', 'A validated video file is required before delivery.');
      return db.runTransaction(async (transaction) => {
        const jobRef = jobs.doc(generationJobId(claim.project.id, claim.batch.id));
        const job = (await transaction.get(jobRef)).data() as Job | undefined;
        const { project, batch, available, authorized, reserved, retention, usage } = await claimResources(transaction, claim, now);
        if (validClaim(job, claim, now) && project && batch && (batch.id ?? 'batch') === (claim.batch.id ?? 'batch')) {
          if (!authorized) throw new GenerationError(403, 'subscription_required', 'Access to this generation was removed.');
          if (!reserved) throw new GenerationError(403, 'allowance_exceeded', 'The original generation reservation is unavailable.');
        }
        if (!validClaim(job, claim, now) || !project || !batch || !available) {
          const existing = (await transaction.get(eventRef(claim))).data();
          if (!finalAttemptRecorded(existing)) recordEvent(transaction, claim, now, 'discarded', result, 'stale_generation');
          return false;
        }
        const slot = batch.slots.find((entry) => entry.id === claim.slot!.id)!;
        if (slot.status !== 'pending') return false;
        const processing = runtime((await transaction.get(runtimeRef(project.uid))).data());
        const contentFingerprint = outputFingerprint(feature, content);
        const sameFeature = outputRefs(project.uid, project.id).where('feature', '==', feature);
        const previous = await transaction.get(project.dedupVersion === 1 && contentFingerprint !== null ? sameFeature.where('contentFingerprint', '==', contentFingerprint) : sameFeature);
        const priorRetention = await readRetentionContext(db, project.uid, (await transaction.get(db.collection('subscriptionGrants').doc(project.uid))).data(), previous.docs.map(doc => (doc.data() as GeneratedOutput).retention), transaction);
        const canonical = canonicalOutput(feature, content);
        const duplicate = previous.docs.some(document => {
          const saved = document.data() as GeneratedOutput;
          return retainedOutput(saved, now, priorRetention) !== null && canonical !== null && canonicalOutput(feature, saved) === canonical;
        });
        if (duplicate) {
          releaseSlotFunding(usage, slot, batch);
          slot.status = 'failed'; slot.errorCode = 'duplicate_generated_output';
          batch.updatedAt = now;
          recordEvent(transaction, claim, now, 'failed', result, 'duplicate_generated_output');
          if (batch.slots.every(entry => entry.status !== 'pending')) finishBatch(transaction, batch, project, usage, processing, now);
          else {
            queueUnusedAssets(transaction, batch, now);
            writeLedgers(transaction, db, project.uid, usage);
            transaction.set(batchRef(project.uid, project.id), batch, { merge: true });
            transaction.set(jobRef, { ...job, availableAt: now, claimId: null, workerId: null });
          }
          return false;
        }
        const charge = slotCharge(slot, batch);
        const delivered = thread ? thread.content.posts.length : charge.amount;
        if (thread && (!batch.accounting || delivered > charge.amount)) throw new GenerationError(502, 'invalid_generation_controls', 'The delivered thread exceeds its accepted reservation.');
        settleFunding(usage, slotOwners(slot, batch), charge.key, delivered);
        if (thread) { slot.deliveredCredits = delivered; slot.deliveredPosts = delivered; }
        // Imports accepted before import-time settlement can still hold a legacy reservation.
        if (!project.sourceAllowanceConsumed && project.reservedSourceSeconds > 0) {
          for (const owner of sourceOwners(project)) {
            const ledger = usage.get(owner.period)!;
            ledger.reserved.sourceSeconds = Math.max(0, ledger.reserved.sourceSeconds! - owner.amount);
            ledger.consumed.sourceSeconds! += owner.amount;
          }
          transaction.update(projectRef(project.uid, project.id), { reservedSourceSeconds: 0, sourceAllowanceConsumed: true });
        }
        const policy = retentionPolicy('output', batch.retentionOrigin, retention);
        slot.status = 'ready'; slot.errorCode = null;
        batch.updatedAt = now;
        transaction.set(outputRefs(project.uid, project.id).doc(slot.id), { id: slot.id, feature: slot.feature, text, ...(contentFingerprint ? { contentFingerprint } : {}), ...(thread ? { data: thread.content, deliveredPosts: delivered, credits: delivered, requestedMaxPosts: threadSettings!.maxPosts } : {}), ...(longForm ? { data: longForm.content } : {}), ...(carousel ? { data: carousel.content, assets: result.assets } : {}), ...(video ? { data: video.content, assets: result.assets } : {}), createdAt: now, expiresAt: policy?.promisedUntil ?? now + operationalLimits.outputRetentionDays * 86_400_000, cleanupAt: policy?.promisedUntil ?? now + operationalLimits.outputRetentionDays * 86_400_000, ...(policy ? { retention: policy } : {}), model: result.model, promptVersion: result.promptVersion ?? 'unknown' });
        recordEvent(transaction, claim, now, 'succeeded', result, null);
        if (batch.slots.every((entry) => entry.status !== 'pending')) finishBatch(transaction, batch, { ...project, reservedSourceSeconds: 0 }, usage, processing, now);
        else {
          writeLedgers(transaction, db, project.uid, usage);
          transaction.set(batchRef(project.uid, project.id), batch, { merge: true });
          transaction.set(jobRef, { ...job, availableAt: now, claimId: null, workerId: null });
        }
        return true;
      });
    },
    async fail(claim, failure, now) {
      return db.runTransaction(async (transaction) => {
        const jobRef = jobs.doc(generationJobId(claim.project.id, claim.batch.id));
        const job = (await transaction.get(jobRef)).data() as Job | undefined;
        if (!validClaim(job, claim, now)) {
          const existing = (await transaction.get(eventRef(claim))).data();
          if (!finalAttemptRecorded(existing)) recordEvent(transaction, claim, now, 'discarded', failure, failure.code);
          return false;
        }
        const resources = await claimResources(transaction, claim, now);
        if (!resources.project || !resources.batch || !resources.importOwned || (resources.batch.id ?? 'batch') !== (claim.batch.id ?? 'batch')) {
          const existing = (await transaction.get(eventRef(claim))).data();
          if (!finalAttemptRecorded(existing)) recordEvent(transaction, claim, now, 'discarded', failure, failure.code);
          return false;
        }
        const project = resources.project;
        const batch = resources.batch;
        const usage = resources.usage;
        const processing = runtime((await transaction.get(runtimeRef(project.uid))).data());
        const event = (await transaction.get(eventRef(claim))).data();
        const slot = batch.slots.find(entry => entry.id === claim.slot?.id);
        // Only durable proof of no dispatch can waive a shutdown attempt. Keep its
        // ordinal unique so stale claims, usage events and asset paths stay fenced.
        if (failure.code === 'worker_shutdown' && event?.providerInvoked === false && resources.available && !slot?.lengthCorrectionStarted) {
          if (slot) slot.preDispatchReleases = (slot.preDispatchReleases ?? 0) + 1;
          else batch.transcriptionPreDispatchReleases = (batch.transcriptionPreDispatchReleases ?? 0) + 1;
          recordEvent(transaction, claim, now, 'interrupted', failure, failure.code);
          transaction.set(jobRef, { ...job, availableAt: now, claimId: null, workerId: null });
          transaction.set(batchRef(project.uid, project.id), { ...batch, updatedAt: now }, { merge: true });
          return true;
        }
        const chargedAttempt = claim.attempt - (slot ? slot.preDispatchReleases ?? 0 : batch.transcriptionPreDispatchReleases ?? 0);
        recordEvent(transaction, claim, now, 'failed', failure, failure.code);
        if (failure.retryable && !batch.slots.find(slot => slot.id === claim.slot?.id)?.lengthCorrectionStarted && (!batch.intent || batch.intent === 'import_transcription' && event?.providerInvoked === false) && resources.available && chargedAttempt < 3 && batch.deadline > now) {
          transaction.set(jobRef, { ...job, availableAt: now + 1000 * 2 ** chargedAttempt, claimId: null, workerId: null });
          transaction.set(batchRef(project.uid, project.id), { errorCode: failure.code, updatedAt: now }, { merge: true });
          return true;
        }
        if (claim.stage === 'transcribe') batch.transcriptionFailure = { code: failure.code, retryable: failure.retryable, ...(rejectsTranscriptionSource(failure.code, failure.validation) ? { sourceRejectedVersion: transcriptionSourceRulesVersion } : {}) };
        if (claim.stage === 'transcribe' || !resources.authorized || !resources.reserved) failPending(batch, usage, failure.code);
        else {
          const slot = batch.slots.find((entry) => entry.id === claim.slot!.id)!;
          slot.status = 'failed'; slot.errorCode = failure.code;
          releaseSlotFunding(usage, slot, batch);
        }
        if (batch.slots.every((entry) => entry.status !== 'pending')) finishBatch(transaction, batch, project, usage, processing, now);
        else {
          batch.updatedAt = now;
          writeLedgers(transaction, db, project.uid, usage);
          transaction.set(batchRef(project.uid, project.id), batch, { merge: true });
          transaction.set(jobRef, { ...job, availableAt: now, claimId: null, workerId: null });
        }
        return true;
      });
    },
    async cleanup(now) {
      for (const kind of ['transcripts', 'outputs', 'generation'] as const) {
        const candidateField = kind === 'generation' ? 'snapshotCleanupAt' : 'cleanupAt';
        const due = await db.collectionGroup(kind).where(candidateField, '<=', now).limit(50).get();
        let legacyQuery = db.collectionGroup(kind).orderBy('__name__').limit(50);
        const cursor = retentionCursors.get(kind);
        if (cursor) legacyQuery = legacyQuery.startAfter(cursor);
        const legacy = await legacyQuery.get();
        if (legacy.size === 50) retentionCursors.set(kind, legacy.docs.at(-1)!); else retentionCursors.delete(kind);
        const candidates = new Map([...due.docs, ...legacy.docs.filter(doc => doc.data()[candidateField] === undefined)].map(doc => [doc.ref.path, doc]));
        for (const candidate of candidates.values()) {
          const match = /^accounts\/([^/]+)\/projects\/([^/]+)\/(?:transcripts|outputs|generation)\/([^/]+)$/.exec(candidate.ref.path);
          if (!match) continue;
          const [, uid, projectId, id] = match;
          await db.runTransaction(async transaction => {
            const saved = await transaction.get(candidate.ref);
            if (!saved.exists) return;
            const value = saved.data()!;
            const project = (await transaction.get(projectRef(uid, projectId))).data() as Project | undefined;
            const access = (await transaction.get(db.collection('subscriptionGrants').doc(uid))).data();
            const batch = kind === 'transcripts' ? (await transaction.get(batchRef(uid, projectId))).data() as GenerationBatch | undefined : undefined;
            const policy = kind === 'generation' ? value.snapshotRetention : value.retention;
            const retention = await readRetentionContext(db, uid, access, [policy], transaction);
            const deadline = kind === 'generation' ? value.snapshotExpiresAt ?? value.createdAt + operationalLimits.outputRetentionDays * 86_400_000
              : kind === 'transcripts' ? transcriptExpiry(value as SavedTranscript, batch, retention) : value.expiresAt;
            const state = resolveRetention({ kind: kind === 'transcripts' ? 'transcript' : 'output', expiresAt: deadline, retention: policy }, now, retention);
            if (project && project.status !== 'deleted' && !state.valid) {
              transaction.update(candidate.ref, { [candidateField]: null, retentionCleanupError: 'retention_facts_unavailable' });
              workerEvent('cleanup.quarantined', { code: 'retention_facts_unavailable' }, 'error');
              return;
            }
            if (project && project.status !== 'deleted' && state.available) {
              transaction.update(candidate.ref, { [candidateField]: state.expiresAt, ...(kind === 'generation' ? { snapshotExpiresAt: state.expiresAt } : { expiresAt: state.expiresAt }) });
              return;
            }
            if (kind === 'generation') {
              transaction.update(candidate.ref, { brand: FieldValue.delete(), controls: FieldValue.delete(), snapshotCleanupAt: null });
            } else {
              transaction.delete(candidate.ref);
              transaction.set(projectRef(uid, projectId).collection('retentionDeletions').doc(`${kind === 'outputs' ? 'output' : 'transcript'}-${id}`), { kind, deletedAt: now, expiredAt: state.expiresAt });
              if (kind === 'outputs') queueStorageCleanup(transaction, db.collection('assetCleanup').doc(digest(candidate.ref.path)), (value.assets ?? []).map((asset: OutputAsset) => asset.storagePath), now);
            }
          });
        }
      }
      const deleted = await db.collectionGroup('projects').where('payloadCleanupPending', '==', true).limit(50).get();
      for (const entry of deleted.docs) {
        await db.runTransaction(async transaction => {
          const project = (await transaction.get(entry.ref)).data();
          if (project?.status !== 'deleted') return;
          const children = await Promise.all(['outputs', 'transcripts', 'generation', 'generationRequests', 'retentionDeletions', 'maintenance'].map(name => transaction.get(entry.ref.collection(name).limit(50))));
          const paths = children[0].docs.flatMap(doc => (doc.data().assets ?? []).map((asset: OutputAsset) => asset.storagePath));
          queueStorageCleanup(transaction, db.collection('assetCleanup').doc(`${entry.id}-deleted-payload`), paths, now);
          for (const page of children) for (const doc of page.docs) transaction.delete(doc.ref);
          if (children.every(page => page.empty)) transaction.delete(entry.ref);
        });
      }
      if (storage) await runStorageCleanup(db, storage, now, async (owner, paths) => {
        return db.runTransaction(async transaction => {
          const project = (await transaction.get(projectRef(owner.uid, owner.projectId))).data() as Project | undefined;
          const batch = (await transaction.get(batchRef(owner.uid, owner.projectId))).data() as GenerationBatch | undefined;
          const outputIds = [...new Set(paths.map(path => /\/outputs\/([^/]+)\//.exec(path)?.[1]).filter((id): id is string => !!id))];
          const outputs = await Promise.all(outputIds.map(id => transaction.get(outputRefs(owner.uid, owner.projectId).doc(id))));
          if (outputs.some(doc => doc.exists && (doc.data()!.assets ?? []).some((asset: OutputAsset) => paths.includes(asset.storagePath)))) return false;
          if (project && project.status !== 'deleted') {
            if (project.storagePath && paths.includes(project.storagePath) && project.status === 'source_ready') return false;
            if (['queued', 'importing'].includes(project.status) && project.importUpload && project.importUpload.operationId === project.importOperationId && paths.includes(project.importUpload.storagePath)) return false;
            if (['queued', 'importing'].includes(project.status) && paths.some(path => path.includes(`/source/attempt-${project.attempts}.`))) return false;
          }
          if (batch && ['queued', 'transcribing', 'generating'].includes(batch.status) && batch.slots.some(slot => slot.status === 'pending' && paths.some(path => path.includes(`/outputs/${slot.id}/attempt-${slot.attempts}/`)))) return false;
          return true;
        });
      });
    },
  };
}
