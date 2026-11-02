import { traceWorkerAwait, workerTrace } from '../worker-trace.js';
import { workerEvent } from '../worker-health.js';
import { safeValidationIssue } from './diagnostics.js';
import { createId } from '../shared/id.js';
import { GenerationError, unknownUsage, type GenerationProviders, type GenerationStore, type RateSnapshot, type GenerationUsage, type ShortVideoContent, type Transcript, type CarouselContent, type GenerationClaim, type OutputAsset, type ProviderRequest } from './service.js';

export function createGenerationWorker({ store, providers, now = Date.now, workerId = createId(), leaseMilliseconds = 60_000, stageTimeoutMilliseconds = 180_000, renderCarousel, renderVideo, deleteAsset }: {
  store: GenerationStore; providers: GenerationProviders; now?: () => number; workerId?: string; leaseMilliseconds?: number; stageTimeoutMilliseconds?: number;
  renderCarousel?: (plan: CarouselContent, claim: GenerationClaim, signal: AbortSignal) => Promise<OutputAsset[]>;
  renderVideo?: (plan: ShortVideoContent, claim: GenerationClaim, transcript: Transcript, signal: AbortSignal) => Promise<OutputAsset[]>;
  deleteAsset?: (path: string) => Promise<void>;
}) {
    async function runClaim(claim: GenerationClaim, shutdown?: AbortSignal, localSource?: string) {
      const started = Date.now();
      const trace = { projectId: claim.project.id, batchId: claim.batch.id ?? 'batch', slotId: claim.slot?.id ?? 'transcript', stage: claim.stage, attempt: claim.attempt };
      workerTrace('generation:claimed', trace);
      workerEvent('generation.claimed', trace);
      const controller = new AbortController();
      const stop = () => controller.abort();
      shutdown?.addEventListener('abort', stop, { once: true });
      if (shutdown?.aborted) controller.abort();
      let finished = false;
      let pendingRenewal: Promise<void> | undefined;
      let metadata: ProviderRequest = { provider: claim.stage === 'transcribe' ? 'deepgram' : 'anthropic', model: 'unknown', rates: null, promptVersion: null };
      let completed: { usage: GenerationUsage; provider: string; model: string; rates: RateSnapshot | null; promptVersion: string | null } | undefined;
      let rendered: OutputAsset[] = [];
      const cleanupAssets = async () => {
        if (!store.referencesAssets) return;
        try { if (await traceWorkerAwait('generation.check-saved-assets', () => store.referencesAssets!(claim.project.uid, claim.project.id, claim.slot!.id, rendered.map(asset => asset.storagePath)), trace)) return; }
        catch { return; }
        for (const asset of rendered) {
          await traceWorkerAwait('generation.delete-unused-asset', async () => deleteAsset?.(asset.storagePath), trace).catch(() => undefined);
        }
      };
      const fixedDeadline = Math.min(claim.batch.deadline, now() + stageTimeoutMilliseconds);
      const timeout = setTimeout(() => controller.abort(), Math.max(1, fixedDeadline - now()));
      let resourceTimeout: ReturnType<typeof setTimeout> | undefined;
      const armResources = () => {
        if (resourceTimeout) clearTimeout(resourceTimeout);
        if (finished || controller.signal.aborted) return;
        const sourceDeadline = claim.stage === 'transcribe' || claim.slot?.feature === 'short_videos' ? claim.project.sourceExpiresAt ?? claim.batch.deadline : claim.batch.deadline;
        const transcriptDeadline = claim.stage === 'generate' ? claim.transcriptExpiresAt ?? claim.batch.deadline : claim.batch.deadline;
        resourceTimeout = setTimeout(renewResources, Math.max(1, Math.min(fixedDeadline, sourceDeadline, transcriptDeadline) - now()));
      };
      const renewResources = () => {
        if (finished || controller.signal.aborted || pendingRenewal) return;
        pendingRenewal = (async () => {
          try {
            if (!await traceWorkerAwait('generation.renew', () => store.renew(claim, now(), leaseMilliseconds), trace, true)) controller.abort();
            else {
              const sourceDeadline = claim.stage === 'transcribe' || claim.slot?.feature === 'short_videos' ? claim.project.sourceExpiresAt ?? claim.batch.deadline : claim.batch.deadline;
              const transcriptDeadline = claim.stage === 'generate' ? claim.transcriptExpiresAt ?? claim.batch.deadline : claim.batch.deadline;
              if (Math.min(sourceDeadline, transcriptDeadline, fixedDeadline) <= now()) controller.abort();
              else armResources();
            }
          } catch { controller.abort(); }
        })().finally(() => { pendingRenewal = undefined; });
      };
      // Local import work shares the intake lease; it never starts another heartbeat.
      if (!claim.importOwner) armResources();
      const heartbeat = claim.importOwner ? undefined : setInterval(renewResources, Math.max(10, Math.floor(leaseMilliseconds / 3)));
      const onRequest = async (value: typeof metadata) => {
        metadata = value;
        if (controller.signal.aborted || !await traceWorkerAwait('generation.mark-provider', () => store.markProviderInvoked(claim, value, now()), trace)) throw new GenerationError(409, 'stale_generation', 'This processing attempt is no longer active.');
      };
      try {
        if (shutdown?.aborted) throw new GenerationError(503, 'worker_shutdown', 'Worker is shutting down.', true);
        if (claim.stage === 'transcribe') {
          const result = await traceWorkerAwait('generation.transcribe', () => providers.transcribe(claim.project, controller.signal, onRequest, localSource), trace, false, stageTimeoutMilliseconds + 10_000);
          completed = result;
          const saved = await traceWorkerAwait('generation.save-transcript', () => store.saveTranscript(claim, result, now()), trace);
          workerEvent(saved ? 'generation.transcript_saved' : 'generation.result_discarded', { ...trace, elapsedMilliseconds: Date.now() - started });
        } else {
          const transcript = await traceWorkerAwait('generation.read-transcript', () => store.transcript(claim.project.uid, claim.project.id, now()), trace);
          if (!transcript) throw new GenerationError(502, 'transcript_unavailable', 'The saved transcript is unavailable.');
          const previousOutputs = await traceWorkerAwait('generation.read-previous-outputs', () => store.outputs(claim.project.uid, claim.project.id, now(), claim.slot!.feature), trace);
          if (controller.signal.aborted) throw new GenerationError(409, 'stale_generation', 'This processing attempt is no longer active.');
          const result = await traceWorkerAwait('generation.provider', () => providers.generate(transcript, claim.slot!, claim.batch.selection, controller.signal, onRequest, { controls: claim.batch.controls, actualDurationSeconds: claim.project.source.durationSeconds ?? undefined, brand: claim.slot!.feature === 'short_videos' ? undefined : claim.batch.brand?.profile, previousOutputs }), trace, false, stageTimeoutMilliseconds + 10_000);
          completed = result;
          if (claim.slot!.feature === 'carousels' || claim.slot!.feature === 'short_videos') {
            if (controller.signal.aborted || !await traceWorkerAwait('generation.renew', () => store.renew(claim, now(), leaseMilliseconds), trace, true)) throw new GenerationError(409, 'stale_generation', 'This processing attempt is no longer active.');
          }
          if (claim.slot!.feature === 'carousels') {
            if (!renderCarousel) throw new GenerationError(503, 'carousel_not_configured', 'Carousel rendering is not configured.');
            rendered = await traceWorkerAwait('generation.render-carousel', () => renderCarousel!(result.value as CarouselContent, claim, controller.signal), trace, false, stageTimeoutMilliseconds + 10_000);
            result.assets = rendered;
          }
          if (claim.slot!.feature === 'short_videos') {
            if (!renderVideo) throw new GenerationError(503, 'video_not_configured', 'Video rendering is not configured.');
            rendered = await traceWorkerAwait('generation.render-video', () => renderVideo!(result.value as ShortVideoContent, claim, transcript, controller.signal), trace, false, stageTimeoutMilliseconds + 10_000);
            result.assets = rendered;
          }
          const saved = await traceWorkerAwait('generation.save-output', () => store.saveOutput(claim, result, now()), trace);
          workerEvent(saved ? 'generation.output_saved' : 'generation.result_discarded', { ...trace, elapsedMilliseconds: Date.now() - started });
          if (!saved && rendered.length) await cleanupAssets();
        }
      } catch (error) {
        const validation = error instanceof GenerationError ? safeValidationIssue(Object.getOwnPropertyDescriptor(error, 'validation')?.value) : undefined;
        const failure = { code: shutdown?.aborted && !completed ? 'worker_shutdown' : error instanceof GenerationError ? error.code : 'generation_failed', retryable: error instanceof GenerationError ? error.retryable : true, usage: completed?.usage ?? (error instanceof GenerationError ? error.usage : unknownUsage()), ...(validation ? { validation } : {}), ...(completed ? { provider: completed.provider, model: completed.model, rates: completed.rates, promptVersion: completed.promptVersion } : { ...metadata, model: error instanceof GenerationError ? error.model ?? metadata.model : metadata.model }) };
        workerTrace('generation:attempt-failed', { ...trace, code: failure.code });
        const saved = await traceWorkerAwait('generation.save-failure', () => store.fail(claim, failure, now()), trace);
        // Resolve an ambiguous delivery commit before retiring its immutable media paths.
        if (rendered.length) await cleanupAssets();
        workerEvent('generation.attempt_failed', { ...trace, code: failure.code, ...(validation ? { validationReason: validation.reason, validationField: validation.field } : {}), worked: saved, elapsedMilliseconds: Date.now() - started }, 'warn');
      } finally {
        finished = true;
        clearInterval(heartbeat); clearTimeout(timeout); if (resourceTimeout) clearTimeout(resourceTimeout);
        shutdown?.removeEventListener('abort', stop);
        await pendingRenewal;
        workerTrace('generation:attempt-finished', trace);
      }
      return true;
    }
  return {
    runClaim,
    async runOnce(shutdown?: AbortSignal) {
      if (shutdown?.aborted) return false;
      const claim = await traceWorkerAwait('generation.claim', () => store.claim(workerId, now(), leaseMilliseconds), {}, true);
      return claim ? runClaim(claim, shutdown) : false;
    },
    async cleanup() { await store.cleanup(now()); },
  };
}
