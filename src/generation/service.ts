import { builtinControls, type ControlsAvailability, controlsBodyLimit, controlChoices, generationControlsAvailable, parseGenerationControls, readGenerationDefaults, resolveGenerationControls, type ControlsContext, type ControlsSnapshot, type GenerationControls, type GenerationDefaultsService } from './controls.js';
import { parseBrandRequest, resolveGenerationBrand, type BrandRequest, type GenerationBrand, type GenerationBrandContext } from '../brand/generation.js';
import { brandBodyLimit, type BrandProfile, type BrandService } from '../brand/service.js';
import { traceWorkerAwait, workerTrace } from '../worker-trace.js';
import type { CreditAccounting, CreditCharge } from '../access/accounting.js';
import type { resolveAccess } from '../access/lifecycle.js';
import { generationBatchLimits } from '../access/policy.js';
import { ProjectError, type Project, type JobClaim, type ImportResult } from '../projects/service.js';
import type { ValidationIssue, LengthViolation } from './diagnostics.js';
import type { RetentionOrigin, RetentionPolicy } from './retention.js';

export const shortTextFeatures = ['x_posts', 'linkedin_posts'] as const;
export const generationFeatures = [...shortTextFeatures, 'blogs', 'newsletters', 'carousels', 'short_videos'] as const;
// Reserve the profile plus the generation envelope, even when JSON strings use Unicode escapes.
export const generationBodyLimit = controlsBodyLimit + brandBodyLimit + JSON.stringify({ outputs: generationBatchLimits, brand: { mode: 'saved', overrides: {} } }).length * 6;
export type GenerationFeature = typeof generationFeatures[number];
export type Selection = Record<typeof shortTextFeatures[number], number> & Partial<Record<'blogs' | 'newsletters' | 'carousels' | 'short_videos', number>>;
export type LongFormContent = { status: 'ok' | 'insufficient_source'; title: string; bodyMarkdown: string } | { status: 'ok' | 'insufficient_source'; subject: string; previewText: string; bodyMarkdown: string };
export type CarouselContent = { status: 'ok' | 'insufficient_source'; slides: Array<{ title: string; body: string }> };
export type ShortVideoSegment = { startSeconds: number; endSeconds: number };
export type ShortVideoContent = { status: 'ok' | 'insufficient_source'; segments: ShortVideoSegment[] };
export type LegacyShortVideoContent = { status: 'ok' | 'insufficient_source'; startSeconds: number | null; endSeconds: number | null };
export type OutputAsset = { id: string; storagePath: string; contentType: 'image/png' | 'video/mp4'; durationSeconds?: number; bytes: number; width: number; height: number };
export type XThreadContent = { status: 'ok'; kind: 'thread'; posts: string[]; numbering: 'include' | 'exclude' };
export type GenerationValue = string | XThreadContent | LongFormContent | CarouselContent | ShortVideoContent | LegacyShortVideoContent;
export type Transcript = { text: string; words: Array<{ text: string; start: number; end: number }> };
export type GenerationUsage = {
  inputTokens: number | null; outputTokens: number | null; nonCachedInputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; seconds: number | null;
  textCalls?: Array<{
    purpose: 'create' | 'length_repair'; model: string; promptVersion: string;
    elapsedMilliseconds: number; usage: GenerationUsage;
  }>;
};
export const unknownUsage = (): GenerationUsage => ({ inputTokens: null, outputTokens: null, nonCachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, seconds: null });
export type RateSnapshot = { model: string; capturedAt: string; inputMicrosPerMillion: number | null; outputMicrosPerMillion: number | null; cacheReadMicrosPerMillion: number | null; cacheWriteMicrosPerMillion: number | null; transcriptionMicrosPerMinute: number | null };
export type ProviderRequest = { lengthCorrection?: { usage: GenerationUsage };  provider: string; model: string; rates: RateSnapshot | null; promptVersion?: string | null };
export type AttemptResult<T> = { value: T; usage: GenerationUsage; provider: string; model: string; promptVersion: string | null; rates: RateSnapshot | null; assets?: OutputAsset[] };
export type Slot = { preDispatchReleases?: number; lengthCorrectionStarted?: boolean;  deliveredCredits?: number; deliveredPosts?: number; maxCredits?: number; charge?: CreditCharge; id: string; feature: GenerationFeature; ordinal: number; status: 'pending' | 'ready' | 'failed'; attempts: number; errorCode: string | null };
export type TranscriptionStage = 'preparing_audio' | 'transcribing';
export type GenerationBatch = {
  transcriptionStage?: TranscriptionStage;
  retentionOrigin?: RetentionOrigin;
  snapshotRetention?: RetentionPolicy;
  snapshotExpiresAt?: number;
  snapshotCleanupAt?: number | null;
  accounting?: CreditAccounting;
  intent?: 'transcription_retry' | 'import_transcription';
  importSource?: { operationId: string; result: ImportResult };
  id?: string; uid: string; projectId: string; status: 'queued' | 'transcribing' | 'generating' | 'completed' | 'partial' | 'failed';
  selection: Selection; slots: Slot[]; createdAt: number; updatedAt: number; deadline: number; period: string;
  brand?: GenerationBrand;
  controls?: ControlsSnapshot;
  transcriptionPreDispatchReleases?: number;
  transcriptionAttempts: number; transcriptReady: boolean; errorCode: string | null;
  transcriptionFailure?: { code: string; retryable: boolean; sourceRejectedVersion?: number } | null;
};
export type PublicGenerationBatch = {
  transcriptReady: boolean;
  transcriptionStage?: TranscriptionStage;
  id: string;
  intent?: GenerationBatch['intent'];
  status: GenerationBatch['status'];
  slots: Array<Pick<Slot, 'id' | 'feature' | 'status' | 'errorCode'> & { credits?: number; maxCredits?: number; deliveredPosts?: number }>;
  errorCode: string | null;
  brand?: Pick<GenerationBrand, 'status'>;
  controls?: ControlsSnapshot;
};
export type GeneratedOutput = { credits?: number; deliveredPosts?: number; requestedMaxPosts?: number; id: string; feature: GenerationFeature; text: string; createdAt: number; expiresAt: number; contentFingerprint?: string; retention?: RetentionPolicy; retentionMode?: 'fixed' | 'while_paid'; model: string; promptVersion: string; data?: XThreadContent | LongFormContent | CarouselContent | ShortVideoContent | LegacyShortVideoContent; assets?: OutputAsset[] };
export type ImportOwner = { workerId: string; attempt: number; operationId: string };
export type GenerationClaim = { importOwner?: ImportOwner; project: Project; batch: GenerationBatch; workerId: string; claimId: string; stage: 'transcribe' | 'generate'; slot: Slot | null; attempt: number; startedAt: number; leaseUntil: number; transcriptExpiresAt?: number | null };
export type GenerationProviders = {
  transcribe: (project: Project, signal: AbortSignal, onRequest: (metadata: ProviderRequest) => Promise<void>, localSource?: string) => Promise<AttemptResult<Transcript>>;
  generate: (transcript: Transcript, slot: Slot, selection: Selection, signal: AbortSignal, onRequest: (metadata: ProviderRequest) => Promise<void>, options?: { controls?: ControlsSnapshot; actualDurationSeconds?: number; brand?: BrandProfile; previousOutputs?: readonly GeneratedOutput[] }) => Promise<AttemptResult<GenerationValue>>;
};
export type GenerationAvailability = {
  controls?: ControlsAvailability;
  lifecycle?: ReturnType<typeof resolveAccess>['lifecycle'];
  access: { active: boolean; reason: string; expiresAt: string | null };
  sourceAvailable: boolean; transcriptAvailable: boolean; sourceExpiresAt: string | null; transcriptExpiresAt: string | null;
  transcriptRetentionMode?: 'fixed' | 'while_paid';
  credits?: { remaining: number; costs: Record<GenerationFeature, number> };
  activeBatch: boolean; outputs: Record<GenerationFeature, { available: boolean; reason: string }>;
  transcription?: { status: 'ready' | 'processing' | 'failed' | 'not_started' | 'unavailable'; retryAvailable: boolean; reason: string; errorCode?: string | null };
};
export function applyGenerationConfiguration(availability: GenerationAvailability, { configured = true, implementedFeatures }: { configured?: boolean; implementedFeatures?: readonly GenerationFeature[] }) {
  if (configured && implementedFeatures === undefined) return availability;
  for (const [feature, output] of Object.entries(availability.outputs)) {
    if (!output.available) continue;
    const reason = !configured ? 'generation_not_configured'
      : implementedFeatures && !implementedFeatures.includes(feature as GenerationFeature) ? 'feature_not_implemented' : 'available';
    Object.assign(output, { available: reason === 'available', reason });
  }
  if (!configured && availability.transcription?.retryAvailable) Object.assign(availability.transcription, { retryAvailable: false, reason: 'generation_not_configured' });
  return availability;
}
export const generationJobId = (projectId: string, batchId?: string) => !batchId || batchId === 'batch' ? projectId : `${projectId}-${batchId}`;
export const generationEventId = (projectId: string, batchId: string | undefined, stage: string, slotId: string | null, attempt: number) => `${generationJobId(projectId, batchId)}-${stage}-${slotId ?? 'shared'}-${attempt}`;
export type GenerationStore = {
  lookup?: (uid: string, projectId: string, key: string, selection: Selection, brandRequest?: BrandRequest, intent?: GenerationBatch['intent'], controls?: GenerationControls) => Promise<GenerationBatch | null>;
  availability?: (uid: string, projectId: string, now: number) => Promise<GenerationAvailability>;
  markProviderInvoked: (claim: GenerationClaim, metadata: ProviderRequest, now: number) => Promise<boolean>;
  start: (uid: string, projectId: string, key: string, selection: Selection, now: number, brand?: GenerationBrandContext, intent?: GenerationBatch['intent'], controls?: ControlsContext) => Promise<GenerationBatch>;
  batch: (uid: string, projectId: string) => Promise<GenerationBatch | null>;
  outputs: (uid: string, projectId: string, now: number, feature?: GenerationFeature) => Promise<GeneratedOutput[]>;
  output: (uid: string, projectId: string, outputId: string, now: number) => Promise<GeneratedOutput | null>;
  referencesAssets?: (uid: string, projectId: string, outputId: string, paths: readonly string[]) => Promise<boolean>;
  claim: (workerId: string, now: number, leaseMilliseconds: number) => Promise<GenerationClaim | null>;
  claimImport?: (claim: JobClaim, result: ImportResult, now: number) => Promise<GenerationClaim | null>;
  renew: (claim: GenerationClaim, now: number, leaseMilliseconds: number) => Promise<boolean>;
  transcript: (uid: string, projectId: string, now?: number) => Promise<Transcript | null>;
  saveTranscript: (claim: GenerationClaim, result: AttemptResult<Transcript>, now: number) => Promise<boolean>;
  saveOutput: (claim: GenerationClaim, result: AttemptResult<GenerationValue>, now: number) => Promise<boolean>;
  fail: (claim: GenerationClaim, error: { code: string; retryable: boolean; usage: GenerationUsage; provider: string; model: string; rates: RateSnapshot | null; promptVersion?: string | null; validation?: ValidationIssue }, now: number) => Promise<boolean>;
  cleanup: (now: number) => Promise<void>;
  asset: (uid: string, projectId: string, outputId: string, assetId: string, now: number) => Promise<OutputAsset | null>;
};
export class GenerationError extends ProjectError {
  model?: string;
  validation?: ValidationIssue;
  lengthViolations?: LengthViolation[];
  constructor(status: number, code: string, message: string, public retryable = false, public usage = unknownUsage()) { super(status, code, message); }
}

export function parseSelection(value: unknown): Selection {
  if (value === undefined) return { x_posts: generationBatchLimits.x_posts, linkedin_posts: generationBatchLimits.linkedin_posts };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GenerationError(400, 'invalid_outputs', 'Choose valid output counts.');
  const selection = value as Record<string, unknown>;
  if (Object.keys(selection).some((key) => !generationFeatures.includes(key as GenerationFeature))) throw new GenerationError(400, 'feature_unavailable', 'This output format is not available yet.');
  const x = selection.x_posts ?? 0;
  const linkedIn = selection.linkedin_posts ?? 0;
  const blogs = selection.blogs ?? 0;
  const newsletters = selection.newsletters ?? 0;
  const carousels = selection.carousels ?? 0;
  const videos = selection.short_videos ?? 0;
  const counts = generationFeatures.map((feature) => selection[feature] ?? 0);
  if (generationFeatures.some((feature, index) => !Number.isInteger(counts[index]) || (counts[index] as number) < 0 || (counts[index] as number) > generationBatchLimits[feature]) || counts.every((count) => count === 0)) {
    throw new GenerationError(400, 'invalid_outputs', 'Choose output counts within the generation batch limits.');
  }
  return { x_posts: x as number, linkedin_posts: linkedIn as number, ...(blogs ? { blogs: blogs as number } : {}), ...(newsletters ? { newsletters: newsletters as number } : {}), ...(carousels ? { carousels: carousels as number } : {}), ...(videos ? { short_videos: videos as number } : {}) };
}

export function createGenerationService({ store, now = Date.now, processingConfigured = true, readBrand, readDefaults }: { store: GenerationStore; now?: () => number; processingConfigured?: boolean; readBrand?: BrandService['get']; readDefaults?: GenerationDefaultsService['get'] }) {
  return {
    async retryTranscription(uid: string, projectId: string, key: string, authorizeNewRequest?: () => Promise<void>) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new GenerationError(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required.');
      const selection = { x_posts: 0, linkedin_posts: 0 };
      const existing = await store.lookup?.(uid, projectId, key, selection, undefined, 'transcription_retry');
      if (existing) return publicBatch(existing);
      if (!processingConfigured) throw new GenerationError(503, 'generation_not_configured', 'Transcription is not configured.');
      await authorizeNewRequest?.();
      return publicBatch(await store.start(uid, projectId, key, selection, now(), undefined, 'transcription_retry'));
    },
    async start(uid: string, projectId: string, value: unknown, key: string, authorizeNewRequest?: () => Promise<void>) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new GenerationError(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required.');
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((field) => !['outputs', 'brand', 'controls'].includes(field))) throw new GenerationError(400, 'invalid_request', 'Send an optional output selection and writing preferences.');
      const outputs = (value as { outputs?: unknown }).outputs;
      const selection = parseSelection(outputs);
      const brandRequest = parseBrandRequest((value as { brand?: unknown }).brand);
      const controlsRequest = parseGenerationControls((value as { controls?: unknown }).controls, selection);
      const existing = await traceWorkerAwait('request.lookup', async () => store.lookup?.(uid, projectId, key, selection, brandRequest, undefined, controlsRequest), { projectId });
      if (existing) return publicBatch(existing);
      // Historical null counts normalized to zero; preserve their accepted replay only.
      if (outputs && Object.values(outputs).some(count => count === null)) throw new GenerationError(400, 'invalid_outputs', 'Choose valid output counts.');
      if (!processingConfigured) throw new GenerationError(503, 'generation_not_configured', 'Generation is not configured.');
      await traceWorkerAwait('request.authorize', async () => authorizeNewRequest?.(), { projectId });
      const [defaults, snapshot] = await Promise.all([
        readGenerationDefaults(uid, readDefaults),
        resolveGenerationBrand(brandRequest, Object.entries(selection).some(([feature, count]) => feature !== 'short_videos' && count > 0), readBrand, uid),
      ]);
      const controls: ControlsContext = { request: controlsRequest, snapshot: resolveGenerationControls(controlsRequest, selection, defaults) };
      const batch = await traceWorkerAwait('request.accept', () => store.start(uid, projectId, key, selection, now(), { request: brandRequest, snapshot }, undefined, controls), { projectId });
      workerTrace('request:accepted', { projectId, batchId: batch.id ?? 'batch', status: batch.status });
      return publicBatch(batch);
    },
    async availability(uid: string, projectId: string) {
      if (!store.availability) throw new GenerationError(503, 'generation_not_configured', 'Generation availability is not configured.');
      const availability = applyGenerationConfiguration(await store.availability(uid, projectId, now()), { configured: processingConfigured });
      const saved = await readGenerationDefaults(uid, readDefaults);
      return { ...availability, controls: { version: 1 as const, available: generationControlsAvailable && processingConfigured, threadAvailable: generationControlsAvailable && processingConfigured && Boolean(availability.credits), choices: controlChoices, focusMaxCharacters: 500, defaults: saved.defaults, builtins: builtinControls, defaultsStatus: saved.status } };
    },
    async get(uid: string, projectId: string) {
      const batch = await store.batch(uid, projectId);
      if (!batch) throw new GenerationError(404, 'generation_not_found', 'Generation request not found.');
      return publicBatch(batch);
    },
    async outputs(uid: string, projectId: string) { return (await store.outputs(uid, projectId, now())).map((output) => publicOutput(output, projectId)); },
    async asset(uid: string, projectId: string, outputId: string, assetId: string) {
      const asset = await store.asset(uid, projectId, outputId, assetId, now());
      if (!asset) throw new GenerationError(404, 'asset_not_found', 'Output asset not found.');
      return asset;
    },
    async output(uid: string, projectId: string, outputId: string) {
      const output = await store.output(uid, projectId, outputId, now());
      if (!output) throw new GenerationError(404, 'output_not_found', 'Output not found.');
      return publicOutput(output, projectId);
    },
  };
}
function batchError(batch: GenerationBatch): string | null {
  if (batch.status !== 'failed') return null;
  if (batch.intent === 'transcription_retry' || batch.slots.length === 0) return batch.transcriptionFailure?.code ?? batch.errorCode ?? null;
  const code = batch.slots[0]?.errorCode;
  return code && batch.slots.every(slot => slot.status === 'failed' && slot.errorCode === code) ? code : null;
}
function publicBatch(batch: GenerationBatch): PublicGenerationBatch {
  return {
    id: batch.id ?? 'batch',
    transcriptReady: batch.transcriptReady,
    ...(batch.status === 'transcribing' && batch.transcriptionStage ? { transcriptionStage: batch.transcriptionStage } : {}),
    ...(batch.intent ? { intent: batch.intent } : {}),
    status: batch.status,
    slots: batch.slots.map(({ id, feature, status, errorCode, charge, maxCredits, deliveredCredits, deliveredPosts }) => ({ id, feature, status, errorCode: status === 'failed' ? errorCode ?? null : null, ...(charge ? { credits: maxCredits !== undefined && status === 'failed' ? 0 : deliveredCredits ?? charge.credits } : {}), ...(maxCredits !== undefined ? { maxCredits } : {}), ...(deliveredPosts !== undefined ? { deliveredPosts } : {}) })),
    errorCode: batchError(batch),
    ...(batch.brand ? { brand: { status: batch.brand.status } } : {}),
    ...(batch.controls ? { controls: batch.controls } : {}),
  };
}
function publicOutput(output: GeneratedOutput, projectId: string) {
  return {
    id: output.id,
    feature: output.feature,
    ...(output.deliveredPosts !== undefined ? { deliveredPosts: output.deliveredPosts, credits: output.credits, requestedMaxPosts: output.requestedMaxPosts } : {}),
    text: output.text,
    createdAt: new Date(output.createdAt).toISOString(),
    expiresAt: new Date(output.expiresAt).toISOString(),
    ...(output.retentionMode ? { retentionMode: output.retentionMode } : {}),
    ...(output.data !== undefined ? { data: output.data } : {}),
    ...(output.assets ? { assets: output.assets.map(asset => ({
      id: asset.id,
      contentType: asset.contentType,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      ...(asset.durationSeconds !== undefined ? { durationSeconds: asset.durationSeconds } : {}),
      downloadPath: `/v1/projects/${projectId}/outputs/${output.id}/assets/${asset.id}/download`,
    })) } : {}),
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
