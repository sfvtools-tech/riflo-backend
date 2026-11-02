import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { traceWorkerAwait, workerTrace } from '../../src/worker-trace.js';
import { runWorkerLoop } from '../../src/worker-loop.js';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { GenerationError, type GenerationClaim, type GenerationProviders, type GenerationStore } from '../../src/generation/service.js';

function tracing(context: TestContext, enabled = true) {
  const previous = process.env.RIFLO_WORKER_TRACE;
  if (enabled) process.env.RIFLO_WORKER_TRACE = '1';
  else delete process.env.RIFLO_WORKER_TRACE;
  context.after(() => {
    if (previous === undefined) delete process.env.RIFLO_WORKER_TRACE;
    else process.env.RIFLO_WORKER_TRACE = previous;
  });
  const log = context.mock.method(console, 'info', () => {});
  return () => log.mock.calls.map(call => JSON.parse(String(call.arguments[1])));
}

test('trace is off by default and preserves operation results', async context => {
  const logs = tracing(context, false);
  workerTrace('private-phase');
  assert.equal(await traceWorkerAwait('off', async () => 42), 42);
  assert.deepEqual(logs(), []);
});

test('trace identifies the pending boundary before it resolves and never records results', async context => {
  const logs = tracing(context);
  let resolve!: (value: string) => void;
  const work = traceWorkerAwait('pending', () => new Promise<string>(done => { resolve = done; }), { projectId: 'project' });
  assert.deepEqual(logs().map(entry => entry.event), ['pending:begin']);
  resolve('private generated content');
  assert.equal(await work, 'private generated content');
  assert.deepEqual(logs().map(entry => entry.event), ['pending:begin', 'pending:end']);
  assert.doesNotMatch(JSON.stringify(logs()), /private generated content/);
});

test('quiet polls remain quiet but a later stuck poll names its boundary', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const logs = tracing(context);
  await traceWorkerAwait('quiet-poll', async () => false, {}, true);
  await traceWorkerAwait('quiet-poll', async () => false, {}, true);
  assert.equal(logs().length, 2);
  let resolve!: () => void;
  const pending = traceWorkerAwait('quiet-poll', () => new Promise<void>(done => { resolve = done; }), {}, true);
  context.mock.timers.tick(4999);
  assert.equal(logs().length, 2);
  context.mock.timers.tick(1);
  assert.equal(logs().at(-1).event, 'quiet-poll:begin');
  resolve();
  await pending;
  assert.equal(logs().at(-1).elapsedMilliseconds, 5000);
});

test('trace preserves failure identity without exposing messages or unsafe fields', async context => {
  const logs = tracing(context);
  const error = Object.assign(new Error('Bearer private-provider-response'), { code: 'invalid_generated_output' });
  await assert.rejects(traceWorkerAwait('failed', async () => { throw error; }), actual => actual === error);
  assert.equal(logs().at(-1).code, 'invalid_generated_output');
  const unsafe = Object.assign(new Error('secret'), { code: 'Bearer private-token' });
  await assert.rejects(traceWorkerAwait('unsafe', async () => { throw unsafe; }));
  const throwingCode = Object.defineProperty(new Error('private'), 'code', { get() { throw new Error('private getter'); } });
  await assert.rejects(traceWorkerAwait('throwing-code', async () => { throw throwingCode; }), actual => actual === throwingCode);
  assert.doesNotMatch(JSON.stringify(logs()), /private|Bearer|secret/);
});

test('loop trace covers the idle continuation before another pass without changing scheduling', async context => {
  const logs = tracing(context);
  const shutdown = new AbortController();
  let calls = 0;
  await runWorkerLoop(async () => {
    if (++calls === 1) return false;
    shutdown.abort();
    return true;
  }, shutdown.signal);
  assert.equal(calls, 2);
  const events = logs().map(entry => entry.event);
  assert.ok(events.indexOf('loop.pass:end') < events.indexOf('loop.idle:begin'));
  assert.ok(events.indexOf('loop.idle:begin') < events.indexOf('loop.idle:end'));
  assert.equal(events.at(-1), 'loop:stopped');
});

test('failed diagnostic output cannot change a successful operation', async context => {
  tracing(context);
  context.mock.method(console, 'info', () => { throw new Error('Diagnostic sink failed'); });
  assert.equal(await traceWorkerAwait('broken-sink', async () => true), true);
});

test('generation traces distinguish provider failure from saved terminal failure', async context => {
  const logs = tracing(context);
  const claim = {
    project: { uid: 'owner', id: 'project', source: { durationSeconds: 60 } },
    batch: { id: 'batch', deadline: 10000, selection: { x_posts: 1, linkedin_posts: 0 } },
    stage: 'generate', slot: { id: 'output', feature: 'x_posts' }, attempt: 1,
  } as GenerationClaim;
  let failures = 0;
  const store = {
    claim: async () => claim,
    transcript: async () => ({ text: 'private source transcript', words: [] }),
    outputs: async () => [],
    markProviderInvoked: async () => true,
    fail: async () => { failures++; return true; },
  } as unknown as GenerationStore;
  const providers: GenerationProviders = {
    transcribe: async () => { throw new Error('Unexpected transcription'); },
    generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
      await onRequest({ provider: 'anthropic', model: 'model', rates: null, promptVersion: 'version' });
      throw new GenerationError(502, 'invalid_generated_output', 'private generated content');
    },
  };
  assert.equal(await createGenerationWorker({ store, providers, now: () => 1000 }).runOnce(), true);
  assert.equal(failures, 1);
  const events = logs().map(entry => entry.event);
  assert.ok(events.indexOf('generation:claimed') < events.indexOf('generation.provider:failed'));
  assert.ok(events.indexOf('generation.provider:failed') < events.indexOf('generation.save-failure:begin'));
  assert.ok(events.indexOf('generation.save-failure:end') < events.indexOf('generation:attempt-finished'));
  assert.doesNotMatch(JSON.stringify(logs()), /private|owner/);
});
