import { traceWorkerAwait } from './worker-trace.js';
import { safeWorkerCode, workerEvent } from './worker-health.js';

type WorkerStep = 'temporary-file cleanup' | 'source cleanup' | 'output cleanup' | 'intake work' | 'generation work';

export async function runWorkerStep<T>(step: WorkerStep, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await traceWorkerAwait(step, run, {}, true);
  } catch (error) {
    workerEvent('step.failed', { phase: step, elapsedMilliseconds: Date.now() - startedAt, code: safeWorkerCode(error) }, 'error');
    throw error;
  }
}
