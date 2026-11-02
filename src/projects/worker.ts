import { acceptedSourceLimits } from '../access/source-limits.js';
import { createId } from '../shared/id.js';
import { ProjectError, type ProjectStore, type JobClaim, type ImportResult, type ImportProgress } from './service.js';
import { SourceImportError, sourceAttemptPaths } from './source.js';
import { traceWorkerAwait } from '../worker-trace.js';
import { workerEvent } from '../worker-health.js';

export function createIntakeWorker({ store, importSource, deleteSource, now = Date.now, workerId = createId(), leaseMilliseconds = 60_000 }: {
  store: ProjectStore;
  importSource: (claim: JobClaim, signal: AbortSignal, onProgress?: (progress: ImportProgress) => void) => Promise<ImportResult>;
  deleteSource?: (path: string) => Promise<void>;
  now?: () => number;
  workerId?: string;
  leaseMilliseconds?: number;
}) {
  return {
    async runOnce(shutdown?: AbortSignal) {
      if (shutdown?.aborted) return false;
      const claim = await traceWorkerAwait('intake.claim', () => store.claim(workerId, now(), leaseMilliseconds), {}, true);
      if (!claim) return false;
      if (shutdown?.aborted) {
        await store.fail(claim, { code: 'worker_shutdown', retryable: true, bytes: 0 }, now());
        return true;
      }
      const started = Date.now();
      const trace = { projectId: claim.project.id, attempt: claim.attempt };
      workerEvent('intake.claimed', trace);
      const controller = new AbortController();
      const stop = () => controller.abort();
      shutdown?.addEventListener('abort', stop, { once: true });
      if (shutdown?.aborted) controller.abort();
      let leaseLost = false;
      let result: ImportResult | undefined;
      let pendingRenewal: Promise<void> | undefined;
      let latest: ImportProgress | undefined;
      let savingProgress = false;
      let progressClosed = false;
      let lastStage: ImportProgress['stage'] | undefined;
      const flushProgress = async () => {
        if (!store.progress || !latest || savingProgress || progressClosed || controller.signal.aborted) return;
        const snapshot = latest;
        latest = undefined;
        savingProgress = true;
        lastStage = snapshot.stage;
        try { await store.progress(claim, snapshot, now()); }
        catch { /* Progress is advisory; the existing heartbeat owns lease failure handling. */ }
        finally { savingProgress = false; }
      };
      const reportProgress = (progress: ImportProgress) => {
        if (progressClosed) return;
        latest = progress;
        if (progress.stage !== lastStage) void flushProgress();
      };
      // Keep one snapshot and one write in flight, independent of source chunk count.
      const progressTimer = setInterval(() => { void flushProgress(); }, 2000);
      const deadline = setTimeout(() => controller.abort(), Math.max(1, claim.project.deadline - now()));
      const heartbeat = setInterval(() => {
        if (pendingRenewal || controller.signal.aborted) return;
        pendingRenewal = (async () => {
          try {
            if (!await traceWorkerAwait('intake.renew', () => store.renew(claim, now(), leaseMilliseconds), trace, true)) { leaseLost = true; controller.abort(); }
          } catch { leaseLost = true; controller.abort(); }
        })().finally(() => { pendingRenewal = undefined; });
      }, Math.max(10, Math.floor(leaseMilliseconds / 3)));
      try {
        const limits = acceptedSourceLimits(claim.project);
        result = await traceWorkerAwait('intake.import', () => importSource(claim, controller.signal, reportProgress), trace, false, Math.max(1, claim.project.deadline - now()) + 10_000);
        const receipt = claim.project.importUpload;
        const resumed = receipt?.operationId === claim.project.importOperationId && receipt?.storagePath === result.storagePath && receipt?.bytes === result.bytes && receipt?.durationSeconds === result.durationSeconds && receipt?.sourceSha256 === result.sourceSha256;
        if (!Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > limits.maxSourceBytes || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > limits.maxSourceSeconds || (!resumed && !sourceAttemptPaths(claim.project.uid, claim.project.id, claim.attempt).includes(result.storagePath))) {
          throw new SourceImportError('invalid_video', false, result.bytes);
        }
        if (leaseLost) throw new SourceImportError('stale_import', true, result.bytes);
        progressClosed = true;
        const saved = await traceWorkerAwait('intake.save-source', () => store.complete(claim, result!, now()), trace);
        workerEvent(saved ? 'intake.source_saved' : 'intake.result_discarded', { ...trace, elapsedMilliseconds: Date.now() - started });
        if (!saved) {
          const current = await store.get(claim.project.uid, claim.project.id);
          if (current?.storagePath !== result.storagePath && current?.importUpload?.storagePath !== result.storagePath) await deleteSource?.(result.storagePath);
        }
      } catch (error) {
        progressClosed = true;
        if (result) {
          let current;
          try { current = await store.get(claim.project.uid, claim.project.id); }
          catch { return true; }
          // A lost database reply can hide a successful save; keep its file intact.
          if (current?.storagePath === result.storagePath && current.status === 'source_ready') return true;
        }
        // The store rejects stale ownership but can release a claim whose access was removed.
        const code = error instanceof SourceImportError || error instanceof ProjectError ? error.code : 'source_import_failed';
        const retryable = error instanceof SourceImportError ? error.retryable : !(error instanceof ProjectError);
        const saved = await traceWorkerAwait('intake.save-failure', () => store.fail(claim, { code, retryable, bytes: error instanceof SourceImportError ? error.bytes : result?.bytes ?? 0 }, now()), trace);
        if (result && sourceAttemptPaths(claim.project.uid, claim.project.id, claim.attempt).includes(result.storagePath)) {
          try {
            const current = await store.get(claim.project.uid, claim.project.id);
            if (current?.storagePath !== result.storagePath && current?.importUpload?.storagePath !== result.storagePath) await deleteSource?.(result.storagePath);
          } catch { /* Keep uncertain canonical ownership for the durable cleanup pass. */ }
        }
        workerEvent('intake.attempt_failed', { ...trace, code, worked: saved, elapsedMilliseconds: Date.now() - started }, 'warn');
      } finally {
        progressClosed = true;
        clearInterval(progressTimer);
        clearInterval(heartbeat);
        clearTimeout(deadline);
        shutdown?.removeEventListener('abort', stop);
        await pendingRenewal;
      }
      return true;
    },
    async cleanup() {
      for (const expired of await store.expiredSources(now())) {
        // Invalidate pending work before removing any file it could still refer to.
        const path = await store.remove(expired.uid, expired.id, now(), true, expired);
        if (path === undefined) continue;
        // Physical deletion is durable and leased through the shared storage queue.
      }
    },
  };
}
