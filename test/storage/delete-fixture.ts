import { workerData } from 'node:worker_threads';
import { Compute, OAuth2Client } from 'google-auth-library';
import { serveStorageDeletion } from '../../src/storage/io-worker.js';

// Fabricated credentials and localhost endpoints only; never discover ADC.
const client = workerData.mode === 'metadata' ? new Compute() : new OAuth2Client({ endpoints: { oauth2TokenUrl: workerData.tokenUrl } });
client.setCredentials({ access_token: 'expired-local-token', expiry_date: 1, refresh_token: 'local-refresh-token' });
if (workerData.mode === 'metadata') {
  process.env.GCE_METADATA_HOST = workerData.metadataHost;
  process.env.GCE_METADATA_IP = workerData.metadataHost;
}
serveStorageDeletion(async path => {
  if (path === 'warmup') return;
  if (path === 'exit') process.exit(1);
  if (path === 'fail') throw { code: 412 };
  await client.request({ url: workerData.objectUrl, method: 'DELETE' });
});
