import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerationWorker } from '../../src/generation/worker.js';
import type { GenerationClaim, GenerationStore } from '../../src/generation/service.js';
import { createIntakeWorker } from '../../src/projects/worker.js';
import type { JobClaim, ProjectStore } from '../../src/projects/service.js';

for (const stage of ['intake', 'generation'] as const) {
  test(`${stage} never claims after shutdown or dispatches after shutdown during claim`, async () => {
    const shutdown = new AbortController();
    let claims = 0;
    let failures = 0;
    let dispatches = 0;
    const claim = { project: { id: 'project', uid: 'owner', deadline: 10000 }, batch: { deadline: 10000 }, stage: 'transcribe', attempt: 1 } as unknown as JobClaim & GenerationClaim;
    const store = {
      claim: async () => { claims++; shutdown.abort(); return claim; },
      fail: async (_claim: unknown, failure: { code: string }) => { assert.equal(failure.code, 'worker_shutdown'); failures++; return true; },
    };
    const unexpected = async (): Promise<never> => { dispatches++; throw Error('Shutdown dispatched external work'); };
    const worker = stage === 'intake'
      ? createIntakeWorker({ store: store as unknown as ProjectStore, importSource: unexpected, now: () => 1000 })
      : createGenerationWorker({ store: store as unknown as GenerationStore, providers: { transcribe: unexpected, generate: unexpected }, now: () => 1000 });
    assert.equal(await worker.runOnce(shutdown.signal), true);
    assert.equal(claims, 1);
    assert.equal(failures, 1);
    assert.equal(dispatches, 0);
    assert.equal(await worker.runOnce(shutdown.signal), false);
    assert.equal(claims, 1);
  });
}

test('intake runOnce waits for an in-flight renewal before completing shutdown', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const shutdown = new AbortController();
  let finishRenewal!: (value: boolean) => void;
  let importStarted!: () => void;
  const started = new Promise<void>(resolve => { importStarted = resolve; });
  const store = {
    claim: async () => ({ project: { uid: 'owner', id: 'project', deadline: 10000 }, attempt: 1 }),
    renew: () => new Promise<boolean>(resolve => { finishRenewal = resolve; }),
    fail: async () => true,
  } as unknown as ProjectStore;
  const worker = createIntakeWorker({ store, leaseMilliseconds: 30, now: () => 1000, importSource: async (_claim, signal) => {
    importStarted();
    return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('shutdown')), { once: true }));
  } });
  let finished = false;
  const pending = worker.runOnce(shutdown.signal).then(value => { finished = true; return value; });
  await started;
  context.mock.timers.tick(10);
  shutdown.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  finishRenewal(true);
  assert.equal(await pending, true);
});
