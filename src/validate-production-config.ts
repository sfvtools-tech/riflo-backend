import { readTrialConfig, readRetentionConfig, readTrialAbuseKey } from './config.js';
import { readGenerationConfig } from './generation/config.js';
import { readDriveConfig } from './sources/drive/config.js';
import { readYouTubeConfig } from './sources/config.js';
import { withCors } from './http/cors.js';

// Deployment runs this without starting services or contacting providers.
export function validateProductionConfig(env: NodeJS.ProcessEnv): void {
  for (const name of ['FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET', 'CORS_ALLOWED_ORIGINS', 'FFMPEG_PATH', 'FFPROBE_PATH']) {
    if (!env[name]?.trim()) throw new Error(`${name} is required.`);
  }
  if (env.NODE_ENV !== 'production' || Object.keys(env).some(name => name.endsWith('_EMULATOR_HOST'))) {
    throw new Error('Production environment is required.');
  }
  if (!readGenerationConfig(env)) throw new Error('Production requires generation provider keys.');
  readDriveConfig(env);
  readYouTubeConfig(env);
  const abuseKey = readTrialAbuseKey(env);
  if (readTrialConfig(env) && (!readRetentionConfig(env) || !abuseKey)) throw new Error('Trial intake requires retention and an abuse key.');
  readRetentionConfig(env);
  withCors(() => undefined, env.CORS_ALLOWED_ORIGINS);
  for (const name of ['STREAM_MAX_MILLISECONDS', 'STREAM_MAX_ACTIVE', 'STREAM_MAX_PER_ACCOUNT', 'SOURCE_VALIDATION_MAX_ACTIVE', 'SOURCE_VALIDATION_MAX_PER_ACCOUNT', 'RIFLO_MEDIA_MAX_DIMENSION', 'RIFLO_MEDIA_MAX_PIXELS', 'RIFLO_MEDIA_MAX_FPS', 'RIFLO_MEDIA_MAX_STREAMS']) {
    if (env[name] !== undefined && (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) < 1)) {
      throw new Error(`${name} must be a positive whole number.`);
    }
  }
}

if (process.argv[1]?.endsWith('/validate-production-config.js')) {
  try {
    validateProductionConfig(process.env);
  } catch {
    // Parser errors can contain user input; never send it to deployment logs.
    console.error('Production configuration validation failed. Check the configured settings.');
    process.exitCode = 1;
  }
}
