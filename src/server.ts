import { createServer } from 'node:http';
import { createHandler } from './http/app.js';
import { withCors } from './http/cors.js';
import { createFirebaseDependencies } from './firebase.js';
import { readDriveConfig } from './sources/drive/config.js';
import { readGenerationConfig } from './generation/config.js';
import { readYouTubeConfig } from './sources/config.js';
import { verifyYouTubeTools } from './sources/youtube.js';
import { readTrialConfig, readRetentionConfig, readTrialAbuseKey } from './config.js';

const environment = process.env.NODE_ENV;
if (Object.keys(process.env).some((key) => key.endsWith('_EMULATOR_HOST')) && !['development', 'test'].includes(environment ?? '')) {
  throw new Error('Firebase emulators require NODE_ENV=development or test.');
}
const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId?.trim()) throw new Error('FIREBASE_PROJECT_ID is required.');
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const youtubeConfig = readYouTubeConfig(process.env);
if (youtubeConfig) await verifyYouTubeTools(youtubeConfig);
const shutdown = new AbortController();
const trialEnabled = readTrialConfig(process.env);
const retentionEnabled = readRetentionConfig(process.env);
if (trialEnabled && !retentionEnabled) throw new Error('Trial intake requires RETENTION_ENABLED.');
const dependencies = createFirebaseDependencies(projectId, readDriveConfig(process.env), process.env.FIREBASE_STORAGE_BUCKET, readGenerationConfig(process.env), youtubeConfig, trialEnabled, retentionEnabled, readTrialAbuseKey(process.env));
dependencies.streamMaxMilliseconds = Number(process.env.STREAM_MAX_MILLISECONDS ?? 300_000);
dependencies.streamMaxActive = Number(process.env.STREAM_MAX_ACTIVE ?? 100);
dependencies.streamMaxPerAccount = Number(process.env.STREAM_MAX_PER_ACCOUNT ?? 5);
dependencies.shutdown = shutdown.signal;
const server = createServer(withCors(createHandler(dependencies), process.env.CORS_ALLOWED_ORIGINS));
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, () => console.log(`Riflo backend listening on port ${port}.`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { shutdown.abort(); server.close(); });
