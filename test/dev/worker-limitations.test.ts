import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { Firestore } from 'firebase-admin/firestore';
import { createProjectStore } from '../../src/projects/firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { runWorkerPass } from '../../src/worker-pass.js';
import { runWorkerLoop } from '../../src/worker-loop.js';

// Only the read-only query surface is simulated. Any transaction fails closed.
function database(legacySources = 0) {
  const calls: string[] = [];
  const rows = Array.from({ length: legacySources }, (_, i) => ({
    index: i,
    data: () => ({ uid: 'fixture', id: `source-${i}`, attempts: 1, sourceExpiresAt: 1, storagePath: null }),
  }));
  function query(path: string, filter = '', after = -1, size = 50): object {
    return {
      where: (field: string) => query(path, field, after, size),
      orderBy: () => query(path, filter, after, size),
      limit: (limit: number) => query(path, filter, after, limit),
      startAfter: (cursor: { index: number }) => query(path, filter, cursor.index, size),
      get: async () => {
        calls.push(`${path}:${filter || 'legacy'}`);
        const docs = path === 'projects' && filter === 'sourceExpiresAt' ? rows.slice(after + 1, after + 1 + size) : [];
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }
  return {
    calls,
    db: { collection: query, collectionGroup: query, runTransaction: () => { throw Error('Unexpected transaction'); } } as unknown as Firestore,
  };
}

test('generation stays unclaimed while one intake attempt is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const started = performance.now();
  const pass = runWorkerPass({
    sources: { youtube: { configured: true }, drive: { configured: true } },
    runOnce: async () => { events.push('intake:start'); await blocked; events.push('intake:end'); return true; },
  }, { runOnce: async () => { events.push('generation:start'); return true; } });
  await setTimeout(250);
  assert.deepEqual(events, ['intake:start']);
  const heldMilliseconds = performance.now() - started;
  release();
  assert.equal(await pass, true);
  assert.deepEqual(events, ['intake:start', 'intake:end', 'generation:start']);
  console.log(JSON.stringify({ experiment: 'serial-intake-hold', heldMilliseconds, events }));
});

test('three idle passes count six queue queries; empty cleanup counts eleven queries', async () => {
  const { db, calls } = database();
  const intake = createProjectStore(db);
  const generation = createGenerationStore(db, { remove: async () => { throw Error('Unexpected storage deletion'); } });
  const shutdown = new AbortController();
  let passes = 0;
  const started = performance.now();
  await runWorkerLoop(async () => {
    await intake.claim('fixture', 1, 60_000);
    await generation.claim('fixture', 1, 60_000);
    if (++passes === 3) shutdown.abort();
    return false;
  }, shutdown.signal);
  assert.equal(calls.length, 6);
  const queueCalls = [...calls];
  calls.length = 0;
  assert.deepEqual(await intake.expiredSources(1), []);
  await generation.cleanup(1);
  assert.equal(calls.length, 11);
  console.log(JSON.stringify({ experiment: 'idle-query-count', passes, elapsedMilliseconds: performance.now() - started, queueCalls, cleanupCalls: calls }));
});

test('legacy source cleanup reaches row 151 in four passes and wraps on pass five', async () => {
  const { db, calls } = database(151);
  const store = createProjectStore(db);
  const pages = [];
  for (let pass = 0; pass < 5; pass++) pages.push(await store.expiredSources(1));
  assert.deepEqual(pages.map(page => page.length), [50, 50, 50, 1, 50]);
  assert.equal(pages[3][0].id, 'source-150');
  assert.equal(pages[4][0].id, 'source-0');
  assert.equal(new Set(pages.slice(0, 4).flat().map(row => row.id)).size, 151);
  assert.equal(calls.length, 10);
  console.log(JSON.stringify({ experiment: 'legacy-source-pagination', rows: 151, pageSizes: pages.map(page => page.length), queryCalls: calls.length }));
});
