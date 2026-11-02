import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkerPass } from '../../src/worker-pass.js';

test('the worker imports from a configured future source and still runs generation', async () => {
  const signal = new AbortController().signal;
  const calls: string[] = [];
  const worked = await runWorkerPass({
    sources: { drive: { configured: false }, youtube: { configured: true } },
    runOnce: async (received) => { assert.equal(received, signal); calls.push('intake'); return true; },
  }, { runOnce: async (received) => { assert.equal(received, signal); calls.push('generation'); return false; } }, signal);
  assert.equal(worked, true);
  assert.deepEqual(calls, ['intake', 'generation']);
});

test('unconfigured sources do not stop stored-source generation or claim intake jobs', async () => {
  let generations = 0;
  const intake = {
    sources: { drive: { configured: false }, youtube: { configured: false } },
    runOnce: async () => { throw Error('No source adapter may claim an import.'); },
  };
  assert.equal(await runWorkerPass(intake, { runOnce: async () => { generations++; return true; } }), true);
  assert.equal(generations, 1);
  assert.equal(await runWorkerPass(intake), false);
});

test('a configured idle source and idle generation report no work', async () => {
  assert.equal(await runWorkerPass({
    sources: { drive: { configured: true }, youtube: { configured: false } },
    runOnce: async () => false,
  }, { runOnce: async () => false }), false);
});

test('intake infrastructure failure still allows generation and shutdown prevents new work', async () => {
  let generations = 0;
  const shutdown = new AbortController();
  const intake = { sources: { drive: { configured: true }, youtube: { configured: false } }, runOnce: async () => { throw Error('database unavailable'); } };
  const generation = { runOnce: async () => { generations++; return true; } };
  assert.equal(await runWorkerPass(intake, generation, shutdown.signal), true);
  assert.equal(generations, 1);
  shutdown.abort();
  assert.equal(await runWorkerPass(intake, generation, shutdown.signal), false);
  assert.equal(generations, 1);
});
