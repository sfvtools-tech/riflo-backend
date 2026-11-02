import { AsyncLocalStorage } from 'node:async_hooks';

export type WorkerFields = Partial<Record<'projectId' | 'batchId' | 'slotId' | 'stage' | 'attempt' | 'worked' | 'status' | 'code' | 'iteration' | 'elapsedMilliseconds' | 'phase' | 'validationReason' | 'validationField' | 'backlog' | 'dueAgeMilliseconds', string | number | boolean>>;
const fieldNames = new Set(['projectId', 'batchId', 'slotId', 'stage', 'attempt', 'worked', 'status', 'code', 'iteration', 'elapsedMilliseconds', 'phase', 'validationReason', 'validationField', 'backlog', 'dueAgeMilliseconds']);
type Pending = { parent?: symbol; phase: string; fields: WorkerFields; started: number; expectedMilliseconds: number; reported: boolean };
const context = new AsyncLocalStorage<{ pending: Map<symbol, Pending>; parent?: symbol }>();

export function safeWorkerCode(error: unknown) {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'number' && Number.isSafeInteger(code)) return String(code);
    if (typeof code === 'string' && /^[a-zA-Z0-9_/-]{1,60}$/.test(code)) return code;
  } catch { /* Logging must preserve the original error. */ }
  return 'unknown';
}

export function workerEvent(event: string, fields: WorkerFields = {}, level: 'info' | 'warn' | 'error' = 'info') {
  try {
    const safe = Object.fromEntries(Object.entries(fields).filter(([key, value]) => fieldNames.has(key) && (
      typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'string' && /^[a-zA-Z0-9_ /.-]{1,100}$/.test(value))));
    console[level]('[worker]', JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
  } catch { /* Operational output must not change processing. */ }
}

export async function withWorkerHealth(run: () => Promise<void>, signal: AbortSignal) {
  const pending = new Map<symbol, Pending>();
  // This also keeps the service alive while a client awaits unreferenced I/O.
  const lifetime = setInterval(() => {
    if (signal.aborted) return;
    const parents = new Set(Array.from(pending.values(), value => value.parent));
    for (const [id, value] of pending) {
      if (parents.has(id) || value.reported || Date.now() - value.started <= value.expectedMilliseconds) continue;
      value.reported = true;
      workerEvent('wait.overdue', { ...value.fields, phase: value.phase, elapsedMilliseconds: Date.now() - value.started }, 'warn');
    }
  }, 10_000);
  try {
    await context.run({ pending }, run);
  } finally {
    clearInterval(lifetime);
  }
}

export async function monitorWorkerAwait<T>(phase: string, run: () => Promise<T>, fields: WorkerFields, expectedMilliseconds = 60_000): Promise<T> {
  const owner = context.getStore();
  if (!owner) return run();
  const id = Symbol(phase);
  const value: Pending = { parent: owner.parent, phase, fields, started: Date.now(), expectedMilliseconds, reported: false };
  owner.pending.set(id, value);
  try {
    return await context.run({ pending: owner.pending, parent: id }, run);
  } finally {
    owner.pending.delete(id);
    if (value.reported) workerEvent('wait.ended', { ...fields, phase, elapsedMilliseconds: Date.now() - value.started });
  }
}
