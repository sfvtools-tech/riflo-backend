import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { createOutputStorage } from '../../src/generation/assets.js';
import { createSourceStorage } from '../../src/projects/adapters.js';
import { boundedStorageBucket, deleteStorageObject, disposeStorageDeletions } from '../../src/storage/delete.js';

test('emulated live fences strip private metadata from all three upload adapters without touching siblings', {
  skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST,
  timeout: 15_000,
}, async () => {
  const app = initializeApp({ projectId: 'demo-riflo' }, `fence-acceptance-${randomUUID()}`);
  const bucketName = 'demo-riflo.appspot.com';
  const bucket = getStorage(app).bucket(bucketName);
  const source = createSourceStorage(app, `gs://${bucketName}/`);
  const output = createOutputStorage(app, bucketName);
  const directory = await mkdtemp(join(tmpdir(), 'riflo-fence-acceptance-'));
  const localPath = join(directory, 'private.mp4');
  const prefix = `accounts/fence-${randomUUID()}/projects/project`;
  const paths = [`${prefix}/source/attempt-1.mp4`, `${prefix}/outputs/slot/attempt-1/slide-1.png`, `${prefix}/outputs/slot/attempt-1/clip.mp4`];
  const sibling = `${prefix}/source/attempt-2.mp4`;
  const signal = new AbortController().signal;
  const upload = (index: number) => index === 0 ? source.upload(localPath, paths[index]!, signal, 'video/mp4')
    : index === 1 ? output.uploadBytes(paths[index]!, Buffer.from('private-image'), signal)
      : output.uploadFile(paths[index]!, localPath, signal);
  try {
    await writeFile(localPath, 'private-video');
    await source.upload(localPath, sibling, signal, 'video/mp4');
    for (const [index, path] of paths.entries()) {
      await upload(index);
      await bucket.file(path).setMetadata({ metadata: { privateCaption: 'secret-caption', sourceUrl: 'https://example.invalid/private', firebaseStorageDownloadTokens: 'private-token' } });
      await source.remove(path);
      await output.remove(path);
      const [metadata] = await bucket.file(path).getMetadata();
      assert.equal(Number(metadata.size), 0);
      assert.equal(metadata.contentType, 'application/octet-stream');
      assert.equal(metadata.cacheControl, 'private, no-store');
      assert.deepEqual(metadata.metadata, { rifloPayloadDeleted: 'true' });
      assert.equal((await bucket.file(path).download())[0].length, 0, 'fence is a live empty object');
      // Storage emulator accepts repeated ifGenerationMatch=0 writes. The real-SDK
      // HTTP fence test covers late-upload exclusion against enforced preconditions.
    }
    assert.equal((await bucket.file(sibling).download())[0].toString(), 'private-video');
  } finally {
    await disposeStorageDeletions();
    await Promise.all([...paths, sibling].map(path => bucket.file(path).delete({ ignoreNotFound: true })));
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('real SDK propagates a missing-bucket fence-write 404 instead of acknowledging deletion', { timeout: 5_000 }, async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    requests.push(request.method!);
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 404, message: 'Missing local fixture bucket.' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const previousStorage = process.env.STORAGE_EMULATOR_HOST;
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.STORAGE_EMULATOR_HOST = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, `fence-missing-bucket-${randomUUID()}`);
  try {
    await assert.rejects(deleteStorageObject(boundedStorageBucket(app, 'demo-riflo.appspot.com'), 'accounts/fixture/projects/project/source/attempt-1.mp4', 3_000), { code: 404 });
    assert.deepEqual(requests, ['POST'], 'a single nonresumable object-write request, with no hidden retries or physical DELETE');
  } finally {
    await disposeStorageDeletions();
    await deleteApp(app);
    if (previous === undefined) delete process.env.FIREBASE_STORAGE_EMULATOR_HOST; else process.env.FIREBASE_STORAGE_EMULATOR_HOST = previous;
    if (previousStorage === undefined) delete process.env.STORAGE_EMULATOR_HOST; else process.env.STORAGE_EMULATOR_HOST = previousStorage;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
