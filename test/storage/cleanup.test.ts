import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { cleanupFailure, cleanupOwner, cleanupRetry, runStorageCleanup as runUnverifiedCleanup, storageCleanupLimits } from '../../src/storage/cleanup.js';
import { sourceAttemptPaths } from '../../src/projects/source.js';

const runStorageCleanup = (db: Firestore, storage: { remove(path: string): Promise<void> }, now: number) => runUnverifiedCleanup(db, storage, now, async () => true);

const path = (attempt: number) => `accounts/alice/projects/project/source/attempt-${attempt}.mp4`;

function fixture(initial: Record<string, Record<string, unknown>>) {
  const rows = new Map(Object.entries(initial));
  const apply = (id: string, update: Record<string, unknown>) => {
    const row = rows.get(id)!;
    for (const [key, value] of Object.entries(update)) {
      if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete row[key];
      else row[key] = value;
    }
  };
  const snapshot = (id: string) => ({ id, exists: rows.has(id), data: () => rows.get(id), updateTime: {}, ref: { id, update: async (update: Record<string, unknown>) => apply(id, update) } });
  const query = (field = '__name__', due?: number, after?: string, limit = Infinity): any => ({
    orderBy: (next: string) => query(next, due, after, limit),
    where: (_field: string, _op: string, now: number) => query(field, now, after, limit),
    limit: (next: number) => query(field, due, after, next),
    startAfter: (cursor: { id: string }) => query(field, due, cursor.id, limit),
    get: async () => {
      const docs = [...rows].filter(([id, data]) => (!after || id > after) && (due === undefined || typeof data.nextCheckAt === 'number' && data.nextCheckAt <= due))
        .sort(([a, x], [b, y]) => field === '__name__' ? a.localeCompare(b) : Number(x.nextCheckAt) - Number(y.nextCheckAt) || a.localeCompare(b))
        .slice(0, limit).map(([id]) => snapshot(id));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const db = { collection: () => query(), runTransaction: async (run: (transaction: any) => unknown) => run({
    get: async (ref: { id: string }) => snapshot(ref.id),
    update: (ref: { id: string }, update: Record<string, unknown>) => apply(ref.id, update),
    delete: (ref: { id: string }) => rows.delete(ref.id),
  }) } as unknown as Firestore;
  return { db, rows };
}

test('cleanup validates every supported source extension and rejects cross-owner or malformed paths', () => {
  assert.deepEqual(cleanupOwner(sourceAttemptPaths('alice', 'project', 1)), { uid: 'alice', projectId: 'project' });
  assert.deepEqual(cleanupOwner(['accounts/alice/projects/project/outputs/slot/attempt-1/slide-5.png']), { uid: 'alice', projectId: 'project' });
  for (const paths of [[], [path(1), path(1).replace('alice', 'bob')], ['drive/file'], [path(0)], [path(1).replace('alice', '..')], [path(1), null]]) assert.equal(cleanupOwner(paths), undefined);
  assert.equal(cleanupFailure({ code: 403 }).quarantine, true);
  assert.equal(cleanupFailure({ code: 503 }).quarantine, false);
  assert.equal(cleanupRetry(1), 1_000);
  assert.equal(cleanupRetry(100), storageCleanupLimits.maxRetryMilliseconds);
});

test('legacy manifests are scheduled, malformed manifests quarantined, successful empty fences acknowledged', async () => {
  const { db, rows } = fixture({ legacy: { paths: [path(1)] }, invalid: { paths: ['upstream/video'], nextCheckAt: 0 } });
  const removed: string[] = [];
  await runStorageCleanup(db, { remove: async value => { removed.push(value); } }, 10);
  assert.deepEqual(removed, [path(1)]);
  assert.equal(rows.has('legacy'), false);
  assert.equal(rows.get('invalid')!.status, 'quarantined');
  assert.equal(rows.get('invalid')!.nextCheckAt, undefined);
});

test('failures back off without starving later tasks; permission holds quarantine', async () => {
  const { db, rows } = fixture({ a: { paths: [path(1)], nextCheckAt: 0 }, b: { paths: [path(2)], nextCheckAt: 0 }, c: { paths: [path(3)], nextCheckAt: 0 } });
  const removed: string[] = [];
  const storage = { remove: async (value: string) => { removed.push(value); if (value === path(1)) throw { code: 503 }; if (value === path(2)) throw { code: 403 }; } };
  await runStorageCleanup(db, storage, 100);
  assert.equal(rows.get('a')!.nextCheckAt, 1100);
  assert.equal(rows.get('b')!.status, 'quarantined');
  assert.equal(rows.has('c'), false);
  await runStorageCleanup(db, storage, 101);
  assert.equal(removed.length, 3);
  await runStorageCleanup(db, { remove: async () => {} }, 1100);
  assert.equal(rows.has('a'), false);
});

test('concurrent path additions survive acknowledgment and leased jobs cannot be claimed twice', async () => {
  const { db, rows } = fixture({ a: { paths: [path(1)], nextCheckAt: 0 } });
  let calls = 0;
  await runStorageCleanup(db, { remove: async () => {
    calls++;
    await runStorageCleanup(db, { remove: async () => { throw Error('duplicate claim'); } }, 1);
    rows.get('a')!.paths = [path(1), path(2)];
  } }, 1);
  assert.equal(calls, 1);
  assert.equal(rows.has('a'), true);
  await runStorageCleanup(db, { remove: async () => { calls++; } }, 2);
  assert.equal(calls, 3);
  assert.equal(rows.has('a'), false);
});

test('late uploads are rechecked beyond their native request deadline and large manifests progress', async () => {
  const paths = Array.from({ length: 12 }, (_, index) => path(index + 1));
  const { db, rows } = fixture({ a: { paths, nextCheckAt: 0, recheckAt: 1000 } });
  const removed: string[] = [];
  const storage = { remove: async (value: string) => { removed.push(value); } };
  await runStorageCleanup(db, storage, 1);
  assert.equal(rows.get('a')!.nextPath, 10);
  await runStorageCleanup(db, storage, 2);
  assert.equal(removed.length, 12);
  assert.equal(rows.get('a')!.nextCheckAt, 16_000);
  await runStorageCleanup(db, storage, 15_999);
  assert.equal(removed.length, 12);
  await runStorageCleanup(db, storage, 16_000);
  await runStorageCleanup(db, storage, 16_001);
  assert.equal(removed.length, 24);
  assert.equal(rows.has('a'), false);
});

test('path ownership alone never authorizes deletion, including merged new markers', async () => {
  const { db, rows } = fixture({ a: { paths: [path(1)], nextCheckAt: 0, deletionClaimed: true } });
  await runUnverifiedCleanup(db, { remove: async () => { throw Error('must not delete'); } }, 1);
  assert.equal(rows.get('a')!.status, 'quarantined');
  assert.equal(rows.get('a')!.lastErrorCode, 'unverified_deletion');
});


test('more than a page of rescheduled quarantines cannot starve due deletion', async () => {
  const initial: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 101; index++) initial[`a-${String(index).padStart(3, '0')}`] = { paths: [path(1)], nextCheckAt: 0, status: 'quarantined' };
  initial.z = { paths: [path(2)], nextCheckAt: 1 };
  const { db, rows } = fixture(initial);
  const removed: string[] = [];
  for (let pass = 0; pass < 4; pass++) await runStorageCleanup(db, { remove: async value => { removed.push(value); } }, 10);
  assert.deepEqual(removed, [path(2)]);
  assert.ok([...rows.values()].every(row => row.nextCheckAt === undefined));
});

test('more than a page of active leases move to their lease deadline; nonfinite leases quarantine', async () => {
  const initial: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < 101; index++) initial[`a-${String(index).padStart(3, '0')}`] = { paths: [path(1)], nextCheckAt: 0, leaseUntil: 1000 };
  initial.invalid = { paths: [path(1)], nextCheckAt: 0, leaseUntil: Infinity };
  initial.z = { paths: [path(2)], nextCheckAt: 1 };
  const { db, rows } = fixture(initial);
  const removed: string[] = [];
  for (let pass = 0; pass < 4; pass++) await runStorageCleanup(db, { remove: async value => { removed.push(value); } }, 10);
  assert.deepEqual(removed, [path(2)]);
  assert.equal(rows.get('invalid')!.status, 'quarantined');
  assert.equal(rows.get('invalid')!.nextCheckAt, undefined);
  assert.ok([...rows.entries()].filter(([id]) => id.startsWith('a-')).every(([, row]) => row.nextCheckAt === 1000));
});


test('a missing bucket or failed fence PUT returning 404 cannot acknowledge a manifest', async () => {
  const { db, rows } = fixture({ task: { paths: [path(1)], nextCheckAt: 0 } });
  let calls = 0;
  await runStorageCleanup(db, { remove: async () => { calls++; throw { code: 404 }; } }, 1);
  assert.equal(rows.has('task'), true);
  assert.equal(rows.get('task')!.lastErrorCode, '404');
  assert.equal(rows.get('task')!.nextCheckAt, 1001);
  await runStorageCleanup(db, { remove: async () => { calls++; } }, 2);
  assert.equal(calls, 1);
  await runStorageCleanup(db, { remove: async () => { calls++; } }, 1001);
  assert.equal(calls, 2);
  assert.equal(rows.has('task'), false, 'only the successful empty fence save acknowledges retirement');
});
