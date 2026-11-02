import type { SourceAccess } from './sources/source.js';
import { runWorkerStep } from './worker-step.js';

type Runnable = { runOnce: (signal?: AbortSignal) => Promise<boolean> };

export async function runWorkerPass(intake: Runnable & { sources: SourceAccess['availability'] }, generation?: Runnable, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  const imported = Object.values(intake.sources).some(source => source.configured)
    ? await runWorkerStep('intake work', () => intake.runOnce(signal)).catch(() => false) : false;
  const generated = generation && !signal?.aborted ? await runWorkerStep('generation work', () => generation.runOnce(signal)).catch(() => false) : false;
  return imported || Boolean(generated);
}
