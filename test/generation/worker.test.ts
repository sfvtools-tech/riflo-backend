import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerationWorker } from '../../src/generation/worker.js';
import { GenerationError, unknownUsage, type GeneratedOutput, type GenerationClaim, type GenerationProviders, type GenerationStore } from '../../src/generation/service.js';
import { validateShortPost } from '../../src/generation/validation.js';
import { priorOutputContext } from '../../src/generation/history.js';

test('worker requests complete feature history, retaining standalone and thread context and omitted count', async () => {
  const records: GeneratedOutput[] = Array.from({ length: 17 }, (_, index) => ({
    id: `x-${index}`, feature: 'x_posts', text: `Previous ${index}`, createdAt: index, expiresAt: 10000,
    model: 'fixture', promptVersion: 'fixture',
    ...(index % 2 ? { data: { status: 'ok' as const, kind: 'thread' as const, posts: [`Previous ${index}`, 'Another point'], numbering: 'exclude' as const } } : {}),
  }));
  records.push(
    { ...records[0]!, id: 'expired', text: 'Expired', createdAt: 100, expiresAt: 1000 },
    { ...records[1]!, id: 'malformed', text: 'Invalid thread', createdAt: 101, data: { status: 'ok', kind: 'thread', posts: [], numbering: 'exclude' } },
    { ...records[0]!, id: 'linkedin', feature: 'linkedin_posts', text: 'Other format', createdAt: 102 },
    { ...records[0]!, id: 'blog', feature: 'blogs', text: 'Other long format', createdAt: 103, data: { status: 'ok', title: 'Title', bodyMarkdown: 'Body' } },
  );
  const claim = { project: { uid: 'worker-fixture', id: 'project', source: { durationSeconds: 60 } }, batch: { deadline: 10000, selection: { x_posts: 1, linkedin_posts: 0 } }, stage: 'generate', slot: { id: 'new', feature: 'x_posts' } } as GenerationClaim;
  let received: readonly GeneratedOutput[] | undefined;
  let saved = false;
  const store = {
    claim: async () => claim,
    transcript: async () => ({ text: 'Source', words: [] }),
    outputs: async (uid: string, projectId: string, now: number, feature?: GeneratedOutput['feature']) => {
      assert.deepEqual([uid, projectId, now, feature], ['worker-fixture', 'project', 1000, 'x_posts']);
      return records.filter(output => output.feature === feature);
    },
    saveOutput: async () => { saved = true; return true; },
    fail: async () => { assert.fail('History generation must succeed.'); },
  } as unknown as GenerationStore;
  const providers = {
    generate: async (_transcript, _slot, _selection, _signal, _onRequest, options) => {
      received = options!.previousOutputs;
      assert.deepEqual(received, records.filter(output => output.feature === 'x_posts'));
      const history = priorOutputContext(received!, 'x_posts', 1000);
      assert.deepEqual(history, priorOutputContext(records, 'x_posts', 1000));
      assert.equal(history.previous_outputs.length, 12);
      assert.equal(history.omitted_outputs, 5);
      assert.deepEqual(history.previous_outputs[0], { excerpt: 'Previous 16' });
      assert.deepEqual(history.previous_outputs[1], { excerpt: 'Previous 15' });
      return { value: 'New output', usage: unknownUsage(), provider: 'fixture', model: 'fixture', promptVersion: null, rates: null };
    },
  } as GenerationProviders;
  assert.equal(await createGenerationWorker({ store, providers, now: () => 1000 }).runOnce(), true);
  assert.ok(received);
  assert.equal(saved, true);
});

for (const scenario of [
  { stage: 'transcribe', feature: null, abortAfter: 100 },
  { stage: 'generate', feature: 'short_videos', abortAfter: 100 },
  { stage: 'generate', feature: 'x_posts', abortAfter: 300 },
  { stage: 'generate', feature: 'carousels', abortAfter: 300 },
] as const) {
  test(`${scenario.stage}/${scenario.feature ?? 'audio'} aborts at its required resource expiry`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1000;
    let signal: AbortSignal | undefined;
    let failures = 0;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const claim = {
      project: { uid: 'worker-fixture', id: 'project', sourceExpiresAt: 1100, source: { durationSeconds: 10 } },
      batch: { deadline: 2000 }, stage: scenario.stage,
      slot: scenario.feature ? { id: 'output', feature: scenario.feature } : null,
      transcriptExpiresAt: 1300,
    } as GenerationClaim;
    const store = {
      claim: async () => claim,
      transcript: async () => ({ text: 'Source text', words: [] }),
      outputs: async () => [],
      markProviderInvoked: async () => true,
      renew: async () => true,
      fail: async () => { failures++; return true; },
    } as unknown as GenerationStore;
    const waitForAbort = async (requestSignal: AbortSignal) => {
      signal = requestSignal;
      ready();
      return new Promise<never>((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(Error('Aborted at expiry.')), { once: true }));
    };
    const providers: GenerationProviders = {
      transcribe: async (_project, requestSignal) => waitForAbort(requestSignal),
      generate: async (_transcript, _slot, _selection, requestSignal) => waitForAbort(requestSignal),
    };
    const worker = createGenerationWorker({ store, providers, now: () => clock, stageTimeoutMilliseconds: 1000 });
    const work = worker.runOnce();
    await started;
    clock += scenario.abortAfter - 1;
    context.mock.timers.tick(scenario.abortAfter - 1);
    assert.equal(signal!.aborted, false);
    clock++;
    context.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal!.aborted, true);
    assert.equal(await work, true);
    assert.equal(failures, 1);
  });
}

for (const stageTimeoutMilliseconds of [1000, 400]) {
  test(`retention extension rechecks the resource without extending the ${stageTimeoutMilliseconds}ms stage budget`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1000;
    let signal!: AbortSignal;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const claim = { project: { uid: 'worker-fixture', id: 'project', sourceExpiresAt: 1100, source: { durationSeconds: 10 } }, batch: { deadline: 5000 }, stage: 'generate', slot: { id: 'output', feature: 'x_posts' }, transcriptExpiresAt: 1300 } as GenerationClaim;
    const store = {
      claim: async () => claim, transcript: async () => ({ text: 'Source', words: [] }), outputs: async () => [],
      renew: async () => { claim.transcriptExpiresAt = 1800; return true; }, fail: async () => true,
    } as unknown as GenerationStore;
    const providers: GenerationProviders = { transcribe: async () => { throw Error('Unexpected transcription.'); }, generate: async (_transcript, _slot, _selection, requestSignal) => {
      signal = requestSignal; ready();
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('Expired.')), { once: true }));
    } };
    const work = createGenerationWorker({ store, providers, now: () => clock, stageTimeoutMilliseconds }).runOnce();
    await started;
    clock = 1300; context.mock.timers.tick(300);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, false, 'A renewed transcript must survive its old deadline.');
    const end = stageTimeoutMilliseconds === 400 ? 1400 : 1800;
    clock = end; context.mock.timers.tick(end - 1300);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(await work, true);
  });
}


for (const scenario of ['transport', 'validation', 'render', 'before_request', 'transcription'] as const) {
  test(`failed ${scenario} attempt retains known provider metadata without inventing usage`, async () => {
    const claim = {
      project: { uid: 'worker-fixture', id: 'project', sourceExpiresAt: 10000, source: { durationSeconds: 60 } },
      batch: { deadline: 10000, selection: { x_posts: 1, linkedin_posts: 0 } },
      stage: scenario === 'transcription' ? 'transcribe' : 'generate',
      slot: { id: 'output', feature: scenario === 'render' ? 'carousels' : 'x_posts' },
    } as GenerationClaim;
    let failed: Parameters<GenerationStore['fail']>[1] | undefined;
    let invoked: Parameters<GenerationStore['markProviderInvoked']>[1] | undefined;
    const store = {
      claim: async () => claim,
      transcript: async () => scenario === 'before_request' ? null : { text: 'Source text', words: [] },
      outputs: async () => [],
      markProviderInvoked: async (_claim: GenerationClaim, metadata: Parameters<GenerationStore['markProviderInvoked']>[1]) => { invoked = metadata; return true; },
      renew: async () => true,
      fail: async (_claim: GenerationClaim, failure: Parameters<GenerationStore['fail']>[1]) => { failed = failure; return true; },
    } as unknown as GenerationStore;
    const measured = { ...unknownUsage(), inputTokens: 100, outputTokens: 20 };
    const providers: GenerationProviders = {
      transcribe: async (_project, _signal, onRequest) => {
        await onRequest({ provider: 'deepgram', model: 'transcription-model', rates: null, promptVersion: null });
        throw new GenerationError(503, 'transcription_failed', 'Unavailable.', true);
      },
      generate: async (_transcript, _slot, _selection, _signal, onRequest) => {
        await onRequest({ provider: 'anthropic', model: 'configured-model', rates: null, promptVersion: 'test-prompt-v2' });
        if (scenario === 'render') return { value: { status: 'ok', slides: [] }, usage: measured, provider: 'anthropic', model: 'resolved-model', promptVersion: 'test-prompt-v2', rates: null };
        const error = new GenerationError(502, 'text_generation_failed', 'Unavailable.', scenario === 'transport', scenario === 'validation' ? measured : unknownUsage());
        if (scenario === 'validation') error.model = 'resolved-model';
        throw error;
      },
    };
    const worker = createGenerationWorker({ store, providers, now: () => 1000, renderCarousel: async () => { throw Error('Render failed.'); } });
    assert.equal(await worker.runOnce(), true);
    assert.ok(failed);
    if (scenario === 'before_request') {
      assert.equal(invoked, undefined);
      assert.equal(failed.model, 'unknown');
      assert.equal(failed.promptVersion, null);
    } else if (scenario === 'transcription') {
      assert.equal(invoked!.promptVersion, null);
      assert.equal(failed.promptVersion, null);
      assert.equal(failed.model, 'transcription-model');
    } else {
      assert.equal(invoked!.promptVersion, 'test-prompt-v2');
      assert.equal(failed.promptVersion, 'test-prompt-v2');
      assert.equal(failed.model, scenario === 'transport' ? 'configured-model' : 'resolved-model');
    }
    assert.equal(failed.usage.inputTokens, scenario === 'validation' || scenario === 'render' ? 100 : null);
  });
}

for (const outcome of ['saved', 'failed', 'unresolved'] as const) {
  test(`ambiguous media delivery resolves durable ${outcome} ownership before any orphan fence`, async () => {
    let failureChecked = false;
    let canonical = false;
    const removed: string[] = [];
    const claim = { project: { uid: 'worker-fixture', id: 'project', sourceExpiresAt: 10000, source: { durationSeconds: 10 } }, batch: { deadline: 10000, selection: { carousels: 1 } }, stage: 'generate', slot: { id: 'output', feature: 'carousels' } } as GenerationClaim;
    const asset = { id: 'slide-1', storagePath: 'owned-attempt', contentType: 'image/png', bytes: 1, width: 1080, height: 1350 } as const;
    const store = {
      claim: async () => claim, transcript: async () => ({ text: 'Source', words: [] }), outputs: async () => [], renew: async () => true,
      saveOutput: async () => { throw Error('Delivery reply lost.'); },
      fail: async () => { failureChecked = true; if (outcome === 'unresolved') throw Error('Failure reply lost.'); canonical = outcome === 'saved'; return !canonical; },
      referencesAssets: async () => { assert.equal(failureChecked, true); return canonical; },
      output: async () => { throw Error('Availability is not canonical ownership.'); },
    } as unknown as GenerationStore;
    const providers: GenerationProviders = { transcribe: async () => { throw Error('Unexpected transcription.'); }, generate: async () => ({ value: { status: 'ok', slides: [] }, usage: unknownUsage(), provider: 'fixture', model: 'fixture', promptVersion: null, rates: null }) };
    const run = createGenerationWorker({ store, providers, now: () => 1000, renderCarousel: async () => [asset], deleteAsset: async path => { removed.push(path); } }).runOnce();
    if (outcome === 'unresolved') await assert.rejects(run, /Failure reply lost/); else assert.equal(await run, true);
    assert.equal(failureChecked, true);
    assert.deepEqual(removed, outcome === 'failed' ? ['owned-attempt'] : []);
  });
}

test('worker persists safe validation measurements and logs only rule labels', async context => {
  const warnings = context.mock.method(console, 'warn', () => {});
  context.mock.method(console, 'info', () => {});
  const claim = {
    project: { uid: 'worker-fixture', id: 'project', sourceExpiresAt: 10000, source: { durationSeconds: 60 } },
    batch: { deadline: 10000, selection: { x_posts: 1, linkedin_posts: 0 } },
    stage: 'generate', slot: { id: 'output', feature: 'x_posts' },
  } as GenerationClaim;
  let failed: Parameters<GenerationStore['fail']>[1] | undefined;
  const store = {
    claim: async () => claim,
    transcript: async () => ({ text: 'Source text', words: [] }),
    outputs: async () => [],
    fail: async (_claim: GenerationClaim, failure: Parameters<GenerationStore['fail']>[1]) => { failed = failure; return true; },
  } as unknown as GenerationStore;
  const providers = {
    generate: async () => validateShortPost({ status: 'ok', text: '界'.repeat(141) }, 'x_posts'),
  } as unknown as GenerationProviders;
  assert.equal(await createGenerationWorker({ store, providers, now: () => 1000 }).runOnce(), true);
  assert.deepEqual(failed!.validation, { reason: 'character_limit', field: 'text', actual: 282, limit: 280 });
  assert.equal(failed!.retryable, false);
  assert.match(JSON.stringify(warnings.mock.calls), /validationReason.*character_limit/);
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls), /界/);

  providers.generate = async () => {
    const error = new GenerationError(502, 'invalid_generated_output', 'private-output');
    Object.defineProperty(error, 'validation', { get() { throw Error('private-output'); } });
    throw error;
  };
  assert.equal(await createGenerationWorker({ store, providers, now: () => 1000 }).runOnce(), true);
  assert.equal(failed!.validation, undefined);
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls), /private-output/);
});

for (const outcome of ['success', 'failure', 'fixed-timeout'] as const) {
  test(`worker drains an in-flight resource renewal on ${outcome} without scheduling work after teardown`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    let releaseRenew!: (value: boolean) => void;
    let releaseProvider!: () => void;
    let renewals = 0;
    let finished = false;
    let clock = 1000;
    const claim = { project: { uid: 'renewal-fixture', id: 'project', sourceExpiresAt: 5000, source: { durationSeconds: 10 } }, batch: { deadline: 5000 }, stage: 'generate', slot: { id: 'output', feature: 'x_posts' }, transcriptExpiresAt: 5000 } as GenerationClaim;
    const store = {
      claim: async () => claim, transcript: async () => ({ text: 'source', words: [] }), outputs: async () => [],
      renew: () => { renewals++; return new Promise<boolean>(resolve => { releaseRenew = resolve; }); },
      saveOutput: async () => true, fail: async () => true,
    } as unknown as GenerationStore;
    const providers = { generate: async (_transcript: unknown, _slot: unknown, _selection: unknown, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        releaseProvider = () => outcome === 'failure' ? reject(Error('Provider failed.')) : resolve();
        signal.addEventListener('abort', () => reject(Error('Fixed stage deadline.')), { once: true });
      });
      return { value: { status: 'ok', text: 'output' }, usage: unknownUsage(), provider: 'fixture', model: 'fixture', rates: null, promptVersion: null };
    } } as unknown as GenerationProviders;
    const work = createGenerationWorker({ store, providers, now: () => clock, leaseMilliseconds: 30, stageTimeoutMilliseconds: 100 }).runOnce().then(value => { finished = true; return value; });
    await flush();
    context.mock.timers.tick(10);
    await flush();
    assert.equal(renewals, 1);
    if (outcome === 'fixed-timeout') { clock = 1100; context.mock.timers.tick(90); }
    else releaseProvider();
    await flush();
    assert.equal(finished, false, 'Teardown must wait for the already-running SDK request.');
    releaseRenew(true);
    assert.equal(await work, true);
    clock = 6000; context.mock.timers.tick(10000);
    await flush();
    assert.equal(renewals, 1, 'A late renewal must not recreate timers or access the SDK.');
  });
}
