import { createFirebaseIntakeWorker, createFirebaseGenerationWorker, createFirebaseGenerationCleanup } from './firebase.js';
import { readDriveConfig } from './sources/drive/config.js';
import { verifyVideoProbe } from './projects/adapters.js';
import { cleanupAbandonedSources } from './projects/source.js';
import { readGenerationConfig } from './generation/config.js';
import { verifyAudioExtractor } from './generation/audio.js';
import { runWorkerPass } from './worker-pass.js';
import { runWorkerLoop } from './worker-loop.js';
import { runWorkerStep } from './worker-step.js';
import { readYouTubeConfig } from './sources/config.js';
import { disposeStorageDeletions } from './storage/delete.js';
import { verifyYouTubeTools } from './sources/youtube.js';

if (Object.keys(process.env).some((key) => key.endsWith('_EMULATOR_HOST')) && !['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
  throw new Error('Firebase emulators require NODE_ENV=development or test.');
}
const projectId = process.env.FIREBASE_PROJECT_ID;
const bucket = process.env.FIREBASE_STORAGE_BUCKET;
const probePath = process.env.FFPROBE_PATH;
const driveConfig = readDriveConfig(process.env);
if (!projectId || !bucket || !probePath) throw new Error('The worker requires Firebase project/bucket and FFPROBE_PATH.');
await verifyVideoProbe(probePath);
const youtubeConfig = readYouTubeConfig(process.env);
if (youtubeConfig) await verifyYouTubeTools(youtubeConfig);
const generationConfig = readGenerationConfig(process.env);
if (generationConfig) await verifyAudioExtractor(generationConfig.ffmpegPath);
const worker = createFirebaseIntakeWorker(projectId, driveConfig, bucket, probePath, youtubeConfig, process.env.FFMPEG_PATH, generationConfig);
const generation = generationConfig ? createFirebaseGenerationWorker(projectId, generationConfig, bucket, probePath) : undefined;
const outputCleanup = createFirebaseGenerationCleanup(projectId, bucket);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown.abort());
console.log('Riflo intake worker started.');
console.log(`Generation processing is ${generation ? 'enabled' : 'disabled (provider configuration is missing)'}.`);
let cleanupAt = 0;
let cleanupPending: Promise<void> | undefined;
try {
await runWorkerLoop(async () => {
  if (!cleanupPending && Date.now() >= cleanupAt) {
    cleanupAt = Date.now() + 60_000;
    // A single bounded cleanup pass runs alongside normal admission and delivery.
    cleanupPending = (async () => {
      await runWorkerStep('temporary-file cleanup', cleanupAbandonedSources).catch(() => undefined);
      await runWorkerStep('source cleanup', () => worker.cleanup()).catch(() => undefined);
      await runWorkerStep('output cleanup', () => outputCleanup.cleanup()).catch(() => undefined);
    })()
      .finally(() => { cleanupPending = undefined; });
  }
  return runWorkerPass(worker, generation, shutdown.signal);
}, shutdown.signal);
} finally {
  await cleanupPending;
  await disposeStorageDeletions();
}
