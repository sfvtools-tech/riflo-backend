import { setTimeout } from 'node:timers/promises';
import { traceWorkerAwait, workerTrace } from './worker-trace.js';
import { safeWorkerCode, withWorkerHealth, workerEvent } from './worker-health.js';

export async function runWorkerLoop(pass: () => Promise<boolean>, signal: AbortSignal) {
  let iteration = 0;
  workerTrace('loop:started');
  await withWorkerHealth(async () => {
    try {
      while (!signal.aborted) {
        try {
          const fields = { iteration: ++iteration };
          const worked = await traceWorkerAwait('loop.pass', pass, fields, true);
          if (!worked) await traceWorkerAwait('loop.idle', () => setTimeout(1000, undefined, { signal }), fields, true);
        } catch (error) {
          if (signal.aborted) break;
          workerEvent('pass.failed', { iteration, code: safeWorkerCode(error) }, 'error');
          await traceWorkerAwait('loop.error-idle', () => setTimeout(1000, undefined, { signal }), { iteration }, true).catch(() => undefined);
        }
      }
    } finally {
      workerTrace('loop:stopped', { iteration });
    }
  }, signal);
}
