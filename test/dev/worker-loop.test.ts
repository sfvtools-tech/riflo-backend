import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const workerLoop = new URL('../../src/worker-loop.ts', import.meta.url).href;

async function run(script: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    env: { PATH: process.env.PATH },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  const [code, signal] = await once(child, 'close');
  return { code, signal, output };
}

test('an awaited operation with only an unreferenced timer reproduces exit 13', async () => {
  const result = await run('await new Promise(resolve => setTimeout(resolve, 25).unref());');
  assert.equal(result.code, 13, result.output);
  assert.match(result.output, /unsettled top-level await/i);
});

test('the worker stays alive through unreferenced work and releases its lifetime handle on shutdown', async () => {
  const result = await run(`
    import { runWorkerLoop } from ${JSON.stringify(workerLoop)};
    const shutdown = new AbortController();
    await runWorkerLoop(async () => {
      await new Promise(resolve => setTimeout(resolve, 25).unref());
      shutdown.abort();
      return false;
    }, shutdown.signal);
    console.log('FINISHED');
  `);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null, result.output);
  assert.match(result.output, /FINISHED/);
});

test('shutdown drains the in-flight pass without starting another one', async () => {
  const result = await run(`
    import assert from 'node:assert/strict';
    import { runWorkerLoop } from ${JSON.stringify(workerLoop)};
    const shutdown = new AbortController();
    let calls = 0;
    await runWorkerLoop(async () => {
      calls++;
      setTimeout(() => shutdown.abort(), 10).unref();
      await new Promise(resolve => setTimeout(resolve, 40).unref());
      assert.equal(shutdown.signal.aborted, true);
      return true;
    }, shutdown.signal);
    assert.equal(calls, 1);
    console.log('DRAINED');
  `);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null, result.output);
  assert.match(result.output, /DRAINED/);
});

test('shutdown interrupts the idle delay and a failed pass remains retryable', async () => {
  const result = await run(`
    import assert from 'node:assert/strict';
    import { runWorkerLoop } from ${JSON.stringify(workerLoop)};
    const shutdown = new AbortController();
    let calls = 0;
    await runWorkerLoop(async () => {
      if (++calls === 1) throw Error('Synthetic pass failure');
      setTimeout(() => shutdown.abort(), 10).unref();
      return false;
    }, shutdown.signal);
    assert.equal(calls, 2);
    console.log('RECOVERED');
  `);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /RECOVERED/);
});
