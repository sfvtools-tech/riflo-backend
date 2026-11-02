import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorWorkerAwait, withWorkerHealth, workerEvent } from '../../src/worker-health.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import type { Project } from '../../src/projects/service.js';

test('health reports a blocked boundary once and its eventual completion without changing work', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  const warn = context.mock.method(console, 'warn', () => {});
  const info = context.mock.method(console, 'info', () => {});
  const shutdown = new AbortController();
  let finish!: (value: string) => void;
  const work = withWorkerHealth(async () => {
    assert.equal(await monitorWorkerAwait('generation.claim', () => new Promise<string>(resolve => { finish = resolve; }), { iteration: 2 }), 'saved');
  }, shutdown.signal);
  context.mock.timers.tick(60_000);
  assert.equal(warn.mock.callCount(), 0);
  context.mock.timers.tick(10_000);
  const warning = JSON.parse(String(warn.mock.calls[0].arguments[1]));
  assert.equal(warning.event, 'wait.overdue');
  assert.equal(warning.phase, 'generation.claim');
  assert.equal(warning.elapsedMilliseconds, 70_000);
  context.mock.timers.tick(300_000);
  assert.equal(warn.mock.callCount(), 1);
  finish('saved');
  await work;
  assert.equal(JSON.parse(String(info.mock.calls[0].arguments[1])).event, 'wait.ended');
  context.mock.timers.tick(300_000);
  assert.equal(warn.mock.callCount(), 1);
});

test('a healthy nested provider wait uses its configured budget rather than its outer polling budget', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  const warn = context.mock.method(console, 'warn', () => {});
  context.mock.method(console, 'info', () => {});
  let finish!: () => void;
  const work = withWorkerHealth(() => monitorWorkerAwait('loop.pass', () => monitorWorkerAwait('provider.anthropic', () => new Promise<void>(resolve => { finish = resolve; }), { slotId: 'output' }, 190_000), {}), new AbortController().signal);
  context.mock.timers.tick(180_000);
  assert.equal(warn.mock.callCount(), 0);
  context.mock.timers.tick(20_000);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(JSON.parse(String(warn.mock.calls[0].arguments[1])).phase, 'provider.anthropic');
  finish();
  await work;
});

test('streaming transcription responses retain the configured provider budget after response headers', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-health-test-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, 'audio.wav');
  await writeFile(path, 'synthetic audio');
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  const warn = context.mock.method(console, 'warn', () => {});
  context.mock.method(console, 'info', () => {});
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'test', DEEPGRAM_API_KEY: 'test', FFMPEG_PATH: '/test/ffmpeg' })!;
  let finish!: ReadableStreamDefaultController<Uint8Array>;
  let bodyEntered!: () => void;
  const reading = new Promise<void>(resolve => { bodyEntered = resolve; });
  const providers = createGenerationProviders({
    config,
    audio: async () => ({ path, cleanup: async () => {} }),
    request: async (_url, options) => {
      await new Response(options!.body).arrayBuffer();
      const body = new ReadableStream<Uint8Array>({ start(controller) { finish = controller; } });
      const response = new Response(body);
      Object.defineProperty(response, 'body', { get() { bodyEntered(); return body; } });
      return response;
    },
  });
  const work = withWorkerHealth(async () => {
    const result = await providers.transcribe({ id: 'project', source: { durationSeconds: 60 } } as Project, new AbortController().signal, async () => {});
    assert.equal(result.value.text, 'Hello world.');
  }, new AbortController().signal);
  await reading;
  context.mock.timers.tick(70_000);
  assert.equal(warn.mock.callCount(), 0);
  context.mock.timers.tick(130_000);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(JSON.parse(String(warn.mock.calls[0].arguments[1])).phase, 'transcription.response');
  finish.enqueue(new TextEncoder().encode(JSON.stringify({ metadata: { duration: 60 }, results: { channels: [{ alternatives: [{ transcript: 'Hello world.', words: [{ word: 'Hello', start: 0, end: 1 }, { word: 'world.', start: 1, end: 2 }] }] }] } })));
  finish.close();
  await work;
});

test('shutdown draining is not reported as an unhealthy polling loop', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  const warn = context.mock.method(console, 'warn', () => {});
  const shutdown = new AbortController();
  let finish!: () => void;
  const work = withWorkerHealth(() => monitorWorkerAwait('cleanup', () => new Promise<void>(resolve => { finish = resolve; }), {}), shutdown.signal);
  shutdown.abort();
  context.mock.timers.tick(300_000);
  assert.equal(warn.mock.callCount(), 0);
  finish();
  await work;
});

test('completed polling phases are removed instead of accumulating false overdue work', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  const warn = context.mock.method(console, 'warn', () => {});
  let finish!: () => void;
  const work = withWorkerHealth(async () => {
    for (let count = 0; count < 1000; count++) await monitorWorkerAwait('loop.pass', async () => false, {});
    await monitorWorkerAwait('provider.anthropic', () => new Promise<void>(resolve => { finish = resolve; }), {}, 300_000);
  }, new AbortController().signal);
  while (!finish) await Promise.resolve();
  context.mock.timers.tick(200_000);
  assert.equal(warn.mock.callCount(), 0);
  finish();
  await work;
});

test('operational events omit unknown fields and output failures cannot break processing', context => {
  const info = context.mock.method(console, 'info', () => {});
  workerEvent('generation.claimed', { projectId: 'project', transcript: 'private' } as never);
  assert.equal(JSON.parse(String(info.mock.calls[0].arguments[1])).transcript, undefined);
  context.mock.method(console, 'info', () => { throw Error('private sink'); });
  assert.doesNotThrow(() => workerEvent('generation.claimed', { projectId: 'project' }));
});
