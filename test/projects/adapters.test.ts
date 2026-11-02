import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { createSourceStorage } from '../../src/projects/adapters.js';
import { createDriveSourceAccess } from '../../src/sources/drive/adapter.js';
import { createDriveCodec } from '../../src/sources/drive/tokens.js';
import { driveScope } from '../../src/sources/drive/service.js';

function createDownloadFixture(request: typeof fetch) {
  const codec = createDriveCodec(Buffer.alloc(32, 8).toString('base64'));
  const token = codec.seal('private-refresh-token', 'alice');
  const refreshes: string[] = [];
  const access = createDriveSourceAccess({
    codec, request,
    store: { read: async (uid) => uid === 'alice' ? { version: 1, token } : null },
    google: { refresh: async (token) => { refreshes.push(token); return { accessToken: 'private-access-token', expiresIn: 3600, scope: driveScope }; }, metadata: async () => { throw Error('must not fetch metadata'); } },
  });
  return { access, refreshes };
}

test('source download uses the fixed media endpoint and the owner credentials', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const fixture = createDownloadFixture(async (input, options) => {
    requests.push({ url: String(input), options: options! });
    return new Response('video');
  });
  const download = await fixture.access.download('alice', { fileId: 'video-id', resourceKey: 'private-resource-key' }, new AbortController().signal);
  assert.equal(await new Response(download.body).text(), 'video');
  await download.finished;
  await download.cleanup();
  assert.equal(requests[0]!.url, 'https://www.googleapis.com/drive/v3/files/video-id?alt=media&supportsAllDrives=true');
  assert.equal(requests[0]!.options.redirect, 'error');
  const headers = new Headers(requests[0]!.options.headers);
  assert.equal(headers.get('authorization'), 'Bearer private-access-token');
  assert.equal(headers.get('x-goog-drive-resource-keys'), 'video-id/private-resource-key');
  assert.deepEqual(fixture.refreshes, ['private-refresh-token']);
  await assert.rejects(fixture.access.download('bob', { fileId: 'video-id' }, new AbortController().signal), { retryable: false, code: 'drive_reconnect_required' });
  await assert.rejects(fixture.access.download('alice', { fileId: 'https://evil.example/video' }, new AbortController().signal));
  assert.equal(requests.length, 1);
});

test('source download cancels oversized responses and identifies temporary failures', async () => {
  let cancelled = false;
  const oversized = createDownloadFixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(2 * 1024 ** 3 + 1) } }));
  await assert.rejects(oversized.access.download('alice', { fileId: 'video-id' }, new AbortController().signal), { retryable: false, code: 'source_too_large' });
  assert.equal(cancelled, true);
  for (const status of [403, 404, 429, 500]) {
    for (const rejectCancellation of [false, true]) {
      let cancellations = 0;
      const fixture = createDownloadFixture(async () => new Response(new ReadableStream({
        cancel() {
          cancellations++;
          if (rejectCancellation) throw Error('private-cancellation-error');
        },
      }), { status }));
      await assert.rejects(fixture.access.download('alice', { fileId: 'video-id' }, new AbortController().signal), { retryable: status >= 500 || status === 429, code: 'drive_file_unavailable' });
      assert.equal(cancellations, 1);
    }
  }
  const failedCancellation = createDownloadFixture(async () => new Response(new ReadableStream({
    cancel() { throw Error('private-cancellation-error'); },
  }), { headers: { 'content-length': String(2 * 1024 ** 3 + 1) } }));
  await assert.rejects(failedCancellation.access.download('alice', { fileId: 'video-id' }, new AbortController().signal), { retryable: false, code: 'source_too_large' });
  const network = createDownloadFixture(async () => { throw Error('private-network-error'); });
  await assert.rejects(network.access.download('alice', { fileId: 'video-id' }, new AbortController().signal), { retryable: true, code: 'drive_unavailable' });
});

test('stored sources keep private cache settings and no public download token', {
  skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST,
}, async () => {
  const app = initializeApp({ projectId: 'demo-riflo' }, `source-test-${randomUUID()}`);
  const bucketName = 'demo-riflo.appspot.com';
  const storage = createSourceStorage(app, bucketName);
  const directory = await mkdtemp(join(tmpdir(), 'riflo-storage-test-'));
  const localPath = join(directory, 'video');
  const storagePath = `accounts/test-${randomUUID()}/projects/test/source/attempt-1.mp4`;
  const file = getStorage(app).bucket(bucketName).file(storagePath);
  try {
    await writeFile(localPath, 'original-video');
    await storage.upload(localPath, storagePath, new AbortController().signal, 'video/mp4');
    const [metadata] = await file.getMetadata();
    assert.equal(metadata.cacheControl, 'private, no-store');
    assert.equal(metadata.contentType, 'video/mp4');
    assert.equal(metadata.contentDisposition, 'inline; filename="attempt-1.mp4"');
    assert.equal(metadata.metadata?.expiresAt, undefined, 'Firestore completion sets the authoritative source expiry.');
    assert.equal(metadata.metadata?.firebaseStorageDownloadTokens, undefined);
    assert.equal((await file.download())[0].toString(), 'original-video');
  } finally {
    await storage.remove(storagePath);
    await rm(directory, { recursive: true, force: true });
    await deleteApp(app);
  }
});

test('source uploads require an unused object path and preserve storage precondition failures', async () => {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    requests.push(new URL(request.url!, 'http://localhost'));
    request.resume();
    response.writeHead(412, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 412, message: 'Object already exists.' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const previousStorageHost = process.env.STORAGE_EMULATOR_HOST;
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.STORAGE_EMULATOR_HOST = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, `precondition-test-${randomUUID()}`);
  const directory = await mkdtemp(join(tmpdir(), 'riflo-storage-precondition-'));
  try {
    const path = join(directory, 'video');
    await writeFile(path, 'video');
    const storage = createSourceStorage(app, 'demo-riflo.appspot.com');
    await assert.rejects(storage.upload(path, 'accounts/alice/projects/project/source/attempt-1.mp4', new AbortController().signal, 'video/mp4'), { code: 412 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.searchParams.get('ifGenerationMatch'), '0');
  } finally {
    if (previousHost === undefined) delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    else process.env.FIREBASE_STORAGE_EMULATOR_HOST = previousHost;
    if (previousStorageHost === undefined) delete process.env.STORAGE_EMULATOR_HOST;
    else process.env.STORAGE_EMULATOR_HOST = previousStorageHost;
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('Drive progress totals require valid unencoded response byte lengths', async () => {
  for (const [headers, expected] of [
    [{ 'content-length': '5' }, 5],
    [{ 'content-length': '5', 'content-encoding': 'gzip' }, null],
    [{ 'content-length': 'invalid' }, null],
    [{}, null],
  ] as Array<[Record<string, string>, number | null]>) {
    const fixture = createDownloadFixture(async () => new Response('video', { headers }));
    const download = await fixture.access.download('alice', { fileId: 'video-id' }, new AbortController().signal);
    assert.equal(download.totalBytes, expected);
    await download.cleanup();
  }
});
