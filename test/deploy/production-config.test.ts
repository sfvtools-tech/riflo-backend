import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionConfig } from '../../src/validate-production-config.js';

const environment = {
  NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'riflo-test', FIREBASE_STORAGE_BUCKET: 'riflo-test.firebasestorage.app',
  CORS_ALLOWED_ORIGINS: 'https://riflo-test.web.app', ANTHROPIC_API_KEY: 'test-anthropic', DEEPGRAM_API_KEY: 'test-deepgram',
  FFMPEG_PATH: '/usr/bin/ffmpeg', FFPROBE_PATH: '/usr/bin/ffprobe', TRIAL_ENABLED: 'false', RETENTION_ENABLED: 'false',
};

test('production configuration validates without starting services or enabling optional features', () => {
  assert.doesNotThrow(() => validateProductionConfig(environment));
});

test('production deployment rejects disabled generation, incomplete integrations and invalid operational settings', () => {
  for (const override of [
    { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '' },
    { DEEPGRAM_API_KEY: '' },
    { GOOGLE_DRIVE_CLIENT_ID: 'partial' },
    { TRIAL_ENABLED: 'true' },
    { TRIAL_ENABLED: 'yes' },
    { GENERATION_MAX_OUTPUT_TOKENS: '1' },
    { CORS_ALLOWED_ORIGINS: 'http://unsafe.example' },
    { STREAM_MAX_ACTIVE: 'NaN' },
    { FIRESTORE_EMULATOR_HOST: 'localhost:8080' },
  ]) assert.throws(() => validateProductionConfig({ ...environment, ...override }));
});
