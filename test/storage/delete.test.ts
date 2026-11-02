import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { boundedStorageBucket, deleteStorageObject, disposeStorageDeletions, StorageDeletionWorker } from '../../src/storage/delete.js';

async function localServer(run: (origin: string, nextClose: () => Promise<void>, requests: string[], setHeld: (headers?: boolean) => void) => Promise<void>) {
  let closed: (() => void) | undefined;
  let held = false, headers = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.once('close', () => { closed?.(); closed = undefined; });
    if (request.url?.includes('missing')) { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 404 } })); }
    else if (request.url?.includes('conflict')) { response.writeHead(412, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 412 } })); }
    else if (!held) { response.writeHead(204); response.end(); }
    else if (headers) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(origin, () => new Promise<void>(resolve => { closed = resolve; }), requests, value => { held = true; headers = value ?? false; }); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('isolated SDK payload fencing cancels held object requests before and after headers and replaces its worker', { timeout: 10_000 }, async () => {
  await localServer(async (origin, nextClose, requests, setHeld) => {
    const previous = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    const previousStorage = process.env.STORAGE_EMULATOR_HOST;
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = new URL(origin).host;
    process.env.STORAGE_EMULATOR_HOST = origin;
    const app = initializeApp({ projectId: 'demo-riflo' }, `delete-test-${randomUUID()}`);
    try {
      const bucket = boundedStorageBucket(app, 'demo-riflo.appspot.com');
      await deleteStorageObject(bucket, 'warmup', 3000);
      await deleteStorageObject(bucket, 'absent-object', 100);
      await assert.rejects(deleteStorageObject(bucket, 'conflict', 100), { code: 412 });
      const before = nextClose(); setHeld();
      await assert.rejects(deleteStorageObject(bucket, 'held', 100), { code: 'storage_cleanup_timeout' });
      await before;
      setHeld(true);
      const after = nextClose();
      await assert.rejects(deleteStorageObject(bucket, 'held-after-headers', 3000), { code: 'storage_cleanup_timeout' });
      await after;
      assert.equal(requests.length, 5, 'no SDK retries multiply the durable queue retry');
    } finally {
      await disposeStorageDeletions(); await deleteApp(app);
      if (previous === undefined) delete process.env.FIREBASE_STORAGE_EMULATOR_HOST; else process.env.FIREBASE_STORAGE_EMULATOR_HOST = previous;
      if (previousStorage === undefined) delete process.env.STORAGE_EMULATOR_HOST; else process.env.STORAGE_EMULATOR_HOST = previousStorage;
    }
  });
});

for (const mode of ['oauth', 'metadata']) test(`worker termination cancels held native ${mode} refresh without reaching object deletion`, { timeout: 6000 }, async () => {
  await localServer(async (origin, nextClose, requests, setHeld) => {
    const lane = new StorageDeletionWorker({ mode, tokenUrl: `${origin}/token`, objectUrl: `${origin}/object`, metadataHost: new URL(origin).host }, new URL('./delete-fixture.ts', import.meta.url));
    try {
      await lane.remove('warmup', 3000);
      const closed = nextClose(); setHeld();
      await assert.rejects(lane.remove('refresh', 100), { code: 'storage_cleanup_timeout' });
      await closed;
      assert.equal(requests.length, 1);
      assert.ok(!requests.includes('/object'));
      assert.match(requests[0], mode === 'oauth' ? /\/token/ : /service-accounts\/default\/token/);
      await lane.remove('warmup', 3000);
      await assert.rejects(lane.remove('fail', 100), { code: 412 });
      await assert.rejects(lane.remove('exit', 100), { code: 'storage_cleanup_worker_exited' });
    } finally { await lane.dispose(); }
  });
});

test('custom app credentials fail closed and workers bound pending requests and dispose them', { timeout: 5000 }, async () => {
  const app = initializeApp({ projectId: 'demo-riflo', credential: { getAccessToken: async () => ({ access_token: 'custom', expires_in: 3600 }) } }, `custom-${randomUUID()}`);
  try { assert.throws(() => boundedStorageBucket(app, 'demo-riflo.appspot.com'), { code: 'unsupported_cleanup_credentials' }); }
  finally { await deleteApp(app); }
  const lane = new StorageDeletionWorker({ mode: 'oauth' }, new URL('./delete-fixture.ts', import.meta.url));
  const pending = Array.from({ length: 50 }, () => lane.remove('warmup', 3000).catch(error => error.code));
  await assert.rejects(lane.remove('overflow'), { code: 'storage_cleanup_busy' });
  await lane.dispose();
  assert.ok((await Promise.all(pending)).every(code => code === 'storage_cleanup_closed'));
});


test('worker ignores parent V8 flags and uses its own TypeScript bootstrap', { timeout: 6000 }, async () => {
  const moduleUrl = new URL('../../src/storage/delete.ts', import.meta.url).href;
  const fixtureUrl = new URL('./delete-fixture.ts', import.meta.url).href;
  const script = `import { StorageDeletionWorker } from ${JSON.stringify(moduleUrl)};
    const lane = new StorageDeletionWorker({mode:'oauth'},new URL(${JSON.stringify(fixtureUrl)}));
    try {await lane.remove('warmup',3000);console.log('worker bootstrap passed');}
    finally {await lane.dispose();}`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--stack-trace-limit=10', '--input-type=module', '--import', 'tsx', '-e', script], { timeout: 5000 });
  assert.match(stdout, /worker bootstrap passed/);
});
