import { workerData } from 'node:worker_threads';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { OAuth2Client, Compute } from 'google-auth-library';
import { serveStorageRead } from '../../src/storage/read-worker.js';

delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
delete process.env.STORAGE_EMULATOR_HOST;
const app = initializeApp({ projectId: 'demo-riflo', credential: applicationDefault() });
const bucket = getStorage(app).bucket('demo-riflo.appspot.com');
bucket.storage.apiEndpoint = workerData.origin;
bucket.storage.interceptors.push({ request: options => {
  const target = new URL('uri' in options ? options.uri : options.url);
  if (target.hostname === 'storage.googleapis.com') return { ...options, uri: workerData.origin + target.pathname + target.search };
  if (target.origin !== workerData.origin) throw new Error('nonlocal_fixture_request');
  return { ...options, uri: target.href };
} });
bucket.storage.retryOptions.autoRetry = false;
const client = workerData.mode === 'metadata' ? new Compute() : new OAuth2Client({ endpoints: { oauth2TokenUrl: `${workerData.origin}/token` } });
client.setCredentials({ access_token: 'local-token', refresh_token: 'local-refresh', expiry_date: workerData.mode === 'valid' ? Date.now() + 3600000 : 1 });
if (workerData.mode === 'metadata') process.env.GCE_METADATA_HOST = new URL(workerData.origin).host;
bucket.storage.authClient.getClient = async () => client;
serveStorageRead(bucket);
