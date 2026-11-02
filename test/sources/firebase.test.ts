import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirebaseDependencies, createFirebaseIntakeWorker } from '../../src/firebase.js';
import { readGenerationConfig } from '../../src/generation/config.js';
import { generationFeatures } from '../../src/generation/service.js';

test('Firebase wiring keeps project services and stored-source generation independent of Drive setup', async () => {
  const config = readGenerationConfig({ ANTHROPIC_API_KEY: 'fake-anthropic-key', DEEPGRAM_API_KEY: 'fake-deepgram-key', FFMPEG_PATH: '/not-invoked' });
  const dependencies = createFirebaseDependencies('demo-riflo', undefined, 'demo-riflo.appspot.com', config);
  try {
    assert.equal(dependencies.drive, undefined);
    assert.deepEqual(dependencies.sourceAvailability, { drive: { configured: false }, youtube: { configured: false } });
    assert.equal(dependencies.intakeConfigured, false);
    assert.ok(dependencies.projects);
    assert.ok(dependencies.generation);
    assert.deepEqual(dependencies.implementedFeatures, generationFeatures);
  } finally {
    const app = getApp('riflo-backend');
    await getFirestore(app).terminate();
    await deleteApp(app);
  }
});

test('the intake worker exposes source readiness without requiring Drive or executing a job', async () => {
  const worker = createFirebaseIntakeWorker('demo-riflo', undefined, 'demo-riflo.appspot.com', '/not-invoked');
  try {
    assert.deepEqual(worker.sources, { drive: { configured: false }, youtube: { configured: false } });
    assert.equal(typeof worker.cleanup, 'function');
  } finally {
    const app = getApp('riflo-worker');
    await getFirestore(app).terminate();
    await deleteApp(app);
  }
});

test('YouTube-only and Drive-only configurations expose independent source availability', async () => {
  for (const youtubeOnly of [true, false]) {
    const drive = youtubeOnly ? undefined : { clientId: 'fake-client', clientSecret: 'fake-secret', redirectUri: 'https://example.com/v1/drive/connection/callback', encryptionKey: Buffer.alloc(32, 1).toString('base64'), secureCookie: true };
    const youtube = youtubeOnly ? { executable: '/not-invoked/yt-dlp', nodePath: process.execPath, ffmpegPath: '/not-invoked/ffmpeg' } : undefined;
    const dependencies = createFirebaseDependencies('demo-riflo', drive, 'demo-riflo.appspot.com', undefined, youtube);
    const worker = createFirebaseIntakeWorker('demo-riflo', drive, 'demo-riflo.appspot.com', '/not-invoked/ffprobe', youtube);
    try {
      const availability = { drive: { configured: !youtubeOnly }, youtube: { configured: youtubeOnly } };
      assert.deepEqual(dependencies.sourceAvailability, availability);
      assert.deepEqual(worker.sources, availability);
      assert.equal(dependencies.intakeConfigured, true);
      assert.ok(dependencies.projects);
      assert.ok(dependencies.generation);
      assert.equal(dependencies.generationConfigured, false);
      assert.deepEqual(dependencies.implementedFeatures, []);
    } finally {
      for (const name of ['riflo-backend', 'riflo-worker']) {
        const app = getApp(name);
        await getFirestore(app).terminate();
        await deleteApp(app);
      }
    }
  }
});
