import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntakeWorker } from '../../src/projects/worker.js';
import { sourcePath } from '../../src/projects/source.js';
import type { JobClaim, ProjectStore } from '../../src/projects/service.js';

for (const outcome of ['saved', 'failed', 'unresolved'] as const) {
  test(`ambiguous import commit resolves ${outcome} before fencing its private source`, async () => {
    const path = sourcePath('fixture-owner', 'fixture-project', 1);
    const claim = { project: { uid: 'fixture-owner', id: 'fixture-project', deadline: 10000 }, workerId: 'fixture-worker', attempt: 1, leaseUntil: 5000, startedAt: 1000 } as JobClaim;
    let failureChecked = false;
    let canonical = false;
    const removed: string[] = [];
    const store = {
      claim: async () => claim,
      complete: async () => { throw Error('Import reply lost.'); },
      get: async () => canonical ? { storagePath: path, status: 'source_ready' } : null,
      fail: async () => { failureChecked = true; if (outcome === 'unresolved') throw Error('Failure reply lost.'); canonical = outcome === 'saved'; return !canonical; },
    } as unknown as ProjectStore;
    const run = createIntakeWorker({ store, now: () => 1000, importSource: async () => ({ bytes: 9, durationSeconds: 10, storagePath: path }), deleteSource: async value => { assert.equal(failureChecked, true); removed.push(value); } }).runOnce();
    if (outcome === 'unresolved') await assert.rejects(run, /Failure reply lost/); else assert.equal(await run, true);
    assert.equal(failureChecked, true);
    assert.deepEqual(removed, outcome === 'failed' ? [path] : []);
  });
}
