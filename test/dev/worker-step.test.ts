import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkerStep } from '../../src/worker-step.js';

test('idle worker steps stay quiet and preserve their return value', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {});
  const info = context.mock.method(console, 'info', () => {});
  assert.equal(await runWorkerStep('generation work', async () => false), false);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(info.mock.callCount(), 0);
});

test('ordinary twelve-second generation does not announce a stalled worker', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const warn = context.mock.method(console, 'warn', () => {});
  const info = context.mock.method(console, 'info', () => {});
  let finish!: (value: boolean) => void;
  const pending = runWorkerStep('output cleanup', () => new Promise<boolean>(resolve => { finish = resolve; }));
  context.mock.timers.tick(12_000);
  assert.equal(warn.mock.callCount(), 0);
  finish(true);
  assert.equal(await pending, true);
  assert.equal(info.mock.callCount(), 0);
});

test('failed steps preserve errors but never log provider messages or unsafe codes', async (context) => {
  const log = context.mock.method(console, 'error', () => {});
  const failure = Object.assign(new Error('Bearer private-token'), { code: 'secret=private-token' });
  await assert.rejects(runWorkerStep('intake work', async () => { throw failure; }), error => error === failure);
  assert.equal(JSON.parse(String(log.mock.calls[0].arguments[1])).code, 'unknown');
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /private-token/);
  const coded = Object.assign(new Error('private response body'), { code: 9 });
  await assert.rejects(runWorkerStep('source cleanup', async () => { throw coded; }), error => error === coded);
  assert.equal(JSON.parse(String(log.mock.calls[1].arguments[1])).code, '9');
  const throwingCode = Object.defineProperty(new Error('secret'), 'code', { get() { throw Error('secret'); } });
  await assert.rejects(runWorkerStep('generation work', async () => { throw throwingCode; }), error => error === throwingCode);
});
