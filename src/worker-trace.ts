import { monitorWorkerAwait, safeWorkerCode, type WorkerFields as Fields } from './worker-health.js';
const lastReported = new Map<string, number>();
type TraceFields = Fields & Partial<Record<'bytes' | 'sourceBytes' | 'audioBytes' | 'durationSeconds' | 'cuts', number>> & { extension?: string };

export function workerTrace(event: string, fields: TraceFields = {}) {
  if (process.env.RIFLO_WORKER_TRACE !== '1') return;
  try {
    const safe = Object.fromEntries(Object.entries(fields).filter(([, value]) =>
      typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'string' && /^[a-zA-Z0-9_/-]{1,100}$/.test(value)));
    console.info('[worker trace]', JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
  } catch { /* Diagnostic output must not change processing. */ }
}

// Detailed tracing is opt-in; health checks also run when tracing is disabled.
export function traceWorkerAwait<T>(phase: string, run: () => Promise<T>, fields: Fields = {}, quiet = false, expectedMilliseconds = 60_000): Promise<T> {
  return monitorWorkerAwait(phase, () => traceAwait(phase, run, fields, quiet), fields, expectedMilliseconds);
}

async function traceAwait<T>(phase: string, run: () => Promise<T>, fields: Fields, quiet: boolean): Promise<T> {
  if (process.env.RIFLO_WORKER_TRACE !== '1') return run();
  const started = Date.now();
  let reported = !quiet || started - (lastReported.get(phase) ?? 0) >= 30_000;
  const begin = () => {
    reported = true;
    lastReported.set(phase, Date.now());
    workerTrace(`${phase}:begin`, fields);
  };
  if (reported) begin();
  const pending = reported ? undefined : setTimeout(begin, 5000);
  pending?.unref();
  try {
    const result = await run();
    if (reported) workerTrace(`${phase}:end`, { ...fields, elapsedMilliseconds: Date.now() - started, ...(typeof result === 'boolean' ? { worked: result } : {}) });
    return result;
  } catch (error) {
    workerTrace(`${phase}:failed`, { ...fields, elapsedMilliseconds: Date.now() - started, code: safeWorkerCode(error) });
    throw error;
  } finally {
    clearTimeout(pending);
  }
}
