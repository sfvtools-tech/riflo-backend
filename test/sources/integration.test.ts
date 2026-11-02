import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deleteApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { featureIds, quotaKeys } from '../../src/access/policy.js';
import { createFirebaseDependencies, createFirebaseIntakeWorker } from '../../src/firebase.js';
import { createHandler } from '../../src/http/app.js';
import { readGenerationConfig } from '../../src/generation/config.js';

const execute = promisify(execFile);

test('YouTube-only HTTP validation and project creation share the real private intake queue and allowance', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST || !process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH,
  timeout: 30_000,
}, async () => {
  const uid = `youtube-integration-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'riflo-youtube-integration-test-'));
  const sourcePath = join(directory, 'fixture.ts');
  const executable = join(directory, 'fake-downloader');
  const callsPath = join(directory, 'calls');
  const bucketName = 'demo-riflo.appspot.com';
  let server: ReturnType<typeof createServer> | undefined;
  let storagePath: string | undefined;
  const pendingTransactions = new Set<Promise<unknown>>();
  try {
    await execute(process.env.FFMPEG_PATH!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], { timeout: 10_000 });
    const bytes = await readFile(sourcePath);
    const metadata = { id: 'abcdefghijk', extractor_key: 'Youtube', title: 'Synthetic YouTube input', availability: 'public', live_status: 'not_live', age_limit: 0, duration: 2 };
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(callsPath)},'call\\n');process.stdout.write(process.argv.includes('--print')?${JSON.stringify(JSON.stringify(metadata))}:Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));\n`);
    await chmod(executable, 0o700);
    const youtube = { executable, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH! };
    const generation = readGenerationConfig({ ANTHROPIC_API_KEY: 'fake-anthropic-key', DEEPGRAM_API_KEY: 'fake-deepgram-key', FFMPEG_PATH: process.env.FFMPEG_PATH });
    const dependencies = createFirebaseDependencies('demo-riflo', undefined, bucketName, generation, youtube);
    const worker = createFirebaseIntakeWorker('demo-riflo', undefined, bucketName, process.env.FFPROBE_PATH!, youtube);
    const now = Date.now();
    const db = getFirestore(getApp('riflo-worker'));
    const runTransaction = db.runTransaction.bind(db);
    db.runTransaction = ((...args: Parameters<typeof db.runTransaction>) => {
      const work = runTransaction(...args);
      pendingTransactions.add(work);
      void work.then(() => pendingTransactions.delete(work), () => pendingTransactions.delete(work));
      return work;
    }) as typeof db.runTransaction;
    await db.collection('subscriptionGrants').doc(uid).set({ status: 'active', startsAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), features: [...featureIds], limits: Object.fromEntries(quotaKeys.map((key) => [key, key === 'sourceSeconds' ? 1800 : 1])) });
    server = createServer(createHandler({ ...dependencies, verifyToken: async (token) => ({ uid: token }) }));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (path: string, body?: unknown, owner = uid) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json', 'idempotency-key': 'youtube-intake-key' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const capabilities = (await request('/v1/capabilities')).body.data;
    assert.deepEqual(capabilities.services.sources, { drive: { configured: false }, youtube: { configured: true } });
    assert.equal(capabilities.services.intake.configured, true);
    for (const feature of featureIds) assert.equal(capabilities.features[feature].available, true);
    const checked = await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk?si=shared' });
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body.data.input, { source: 'youtube', videoId: 'abcdefghijk' });
    const created = await request('/v1/projects', checked.body.data.input);
    assert.equal(created.status, 202);
    assert.equal(created.body.data.status, 'queued');
    const callsBeforeReplay = await readFile(callsPath, 'utf8');
    assert.deepEqual((await request('/v1/projects', checked.body.data.input)).body, created.body);
    assert.equal(await readFile(callsPath, 'utf8'), callsBeforeReplay);
    const id = created.body.data.id;
    assert.equal((await request(`/v1/projects/${id}`, undefined, 'another-owner')).status, 404);
    assert.equal(await worker.runOnce(), true);
    const project = (await db.collection('accounts').doc(uid).collection('projects').doc(id).get()).data()!;
    storagePath = project.storagePath;
    assert.equal(project.status, 'source_ready');
    assert.equal(project.preparation, 'failed', 'This intake-only worker has no transcription provider configuration.');
    assert.equal(project.source.requiresProbe, false);
    assert.equal(project.source.mimeType, 'video/mp4');
    assert.ok(storagePath?.endsWith('.mp4'));
    assert.ok(!('fileId' in project.source));
    const stored = getStorage(getApp('riflo-worker')).bucket(bucketName).file(storagePath!);
    const storedBytes = (await stored.download())[0];
    assert.equal(storedBytes.subarray(4, 8).toString(), 'ftyp');
    assert.equal(project.source.bytes, storedBytes.length);
    const storedMetadata = (await stored.getMetadata())[0];
    assert.equal(storedMetadata.cacheControl, 'private, no-store');
    assert.equal(storedMetadata.contentType, 'video/mp4');
    assert.equal(storedMetadata.metadata?.firebaseStorageDownloadTokens, undefined);
    const usage = (await request('/v1/usage')).body.data;
    assert.equal(usage.consumed.sourceSeconds, Math.ceil(project.source.durationSeconds));
    assert.equal(usage.reserved.sourceSeconds, 0);
    assert.equal(project.reservedSourceSeconds, 0);
    assert.equal(project.sourceAllowanceConsumed, true);
    const event = (await db.collection('accounts').doc(uid).collection('usageEvents').where('stage', '==', 'source_import').get()).docs[0]!.data();
    assert.equal(event.provider, 'youtube');
    assert.equal(event.credentialSource, 'none');
    assert.equal(event.status, 'succeeded');
  } finally {
    // Wait for this fixture's advisory progress transactions before terminating its SDK.
    await Promise.all(pendingTransactions);
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    for (const name of ['riflo-backend', 'riflo-worker']) {
      let app;
      try { app = getApp(name); } catch { continue; }
      const db = getFirestore(app);
      if (name === 'riflo-worker') {
        if (storagePath) await getStorage(app).bucket(bucketName).file(storagePath).delete({ ignoreNotFound: true });
        const jobs = await db.collection('intakeJobs').where('uid', '==', uid).get();
        await Promise.all(jobs.docs.map((job) => job.ref.delete()));
        await db.recursiveDelete(db.collection('accounts').doc(uid));
        await db.collection('subscriptionGrants').doc(uid).delete();
      }
      await db.terminate();
      await deleteApp(app);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
