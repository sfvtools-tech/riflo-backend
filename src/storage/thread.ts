import { Worker } from 'node:worker_threads';

/** Never inherit host CLI/V8 flags; source workers need their own TypeScript bootstrap. */
export function createStorageThread(config: Record<string, unknown>, entry: URL) {
  const options = { workerData: config, execArgv: [] };
  return entry.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))`, { ...options, eval: true })
    : new Worker(entry, options);
}
