import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential, signOut } from 'firebase/auth';
import { deleteApp as deleteAdminApp, getApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirebaseDependencies } from '../../src/firebase.js';
import { createHandler } from '../../src/http/app.js';
import { trialOwnerKey, trialSubjectKey, type RequestIdentity } from '../../src/access/trial-abuse.js';

test('actual Firebase Google claims bind trial across auth deletion/recreation and HTTP provider budgets', {
  skip: !process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-trial-auth-'));
  const executable = join(directory, 'provider'); const calls = join(directory, 'calls');
  const key = Buffer.alloc(32, 0x35);
  const subject = `trial-google-${randomUUID()}`;
  const tokenPayload = { sub: subject, email: `${randomUUID()}@example.test`, email_verified: true, name: 'Emulated Google identity' };
  // Emulator-only fake Google credentials; never sent to a real Google endpoint.
  const credential = GoogleAuthProvider.credential(JSON.stringify(tokenPayload));
  const client = initializeApp({ apiKey: 'emulator-only', projectId: 'demo-riflo' }, `trial-client-${randomUUID()}`);
  const auth = getAuth(client);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  let server: ReturnType<typeof createServer> | undefined;
  let admin: ReturnType<typeof getApp> | undefined;
  const uids: string[] = [];
  let verified: RequestIdentity | undefined;
  try {
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'call\\n');process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'abcdefghijk', extractor_key: 'Youtube', title: 'Fixture', availability: 'public', live_status: 'not_live', age_limit: 0, duration: 30 }))});\n`);
    await chmod(executable, 0o700);
    const dependencies = createFirebaseDependencies('demo-riflo', undefined, 'demo-riflo.appspot.com', undefined, { executable, nodePath: process.execPath, ffmpegPath: process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg' }, true, true, key);
    let user = (await signInWithCredential(auth, credential)).user;
    uids.push(user.uid);
    let token = await user.getIdToken();
    verified = await dependencies.verifyToken(token);
    assert.equal(verified.email_verified, true);
    assert.equal(verified.firebase!.sign_in_provider, 'google.com');
    assert.deepEqual(verified.firebase!.identities!['google.com'], [subject]);
    admin = getApp('riflo-backend');
    const db = getFirestore(admin);
    server = createServer(createHandler(dependencies));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, body?: unknown, requestKey = 'trial_auth_import_01') => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': requestKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await request('/v1/capabilities')).status, 200);
    assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk', firebase: tokenPayload })).status, 400);
    assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' })).status, 200);
    assert.equal((await db.collection('subscriptionGrants').doc(user.uid).get()).exists, false);
    const imported = await request('/v1/projects', { source: 'youtube', videoId: 'abcdefghijk' });
    assert.equal(imported.status, 202);
    const accepted = (await imported.json()).data;
    for (let count = 0; count < 8; count++) assert.equal((await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' })).status, 200);
    const blocked = await request('/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, 'trial_rate_limited');
    assert.equal(Number(blocked.headers.get('Retry-After')), body.error.retryAfterSeconds);
    assert.ok(body.error.retryAfterSeconds > 0 && body.error.retryAfterSeconds <= 60);
    const replay = await request('/v1/projects', { source: 'youtube', videoId: 'abcdefghijk' });
    assert.equal(replay.status, 202); assert.deepEqual((await replay.json()).data, accepted);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 10);
    await getAdminAuth(admin).deleteUser(user.uid);
    await db.recursiveDelete(db.collection('accounts').doc(user.uid));
    await db.collection('subscriptionGrants').doc(user.uid).delete();
    await signOut(auth);
    user = (await signInWithCredential(auth, credential)).user; uids.push(user.uid);
    assert.notEqual(user.uid, uids[0]); token = await user.getIdToken();
    const denied = await request('/v1/projects', { source: 'youtube', videoId: 'abcdefghijk' }, 'trial_auth_import_02');
    assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'trial_already_used');
    assert.equal((await db.collection('subscriptionGrants').doc(user.uid).get()).exists, false);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 10);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    if (admin) {
      const db = getFirestore(admin);
      for (const uid of uids) {
        await getAdminAuth(admin).deleteUser(uid).catch(error => { if (error.code !== 'auth/user-not-found') throw error; });
        await db.recursiveDelete(db.collection('accounts').doc(uid));
        await db.collection('subscriptionGrants').doc(uid).delete();
        await db.collection('trialAbuseBindings').doc(trialOwnerKey(uid)).delete();
        const jobs = await db.collection('intakeJobs').where('uid', '==', uid).get();
        await Promise.all(jobs.docs.map(doc => doc.ref.delete()));
      }
      if (verified) {
        await db.collection('trialAbuseClaims').doc(trialSubjectKey(verified, key)).delete();
        await db.collection('trialAbuseRates').doc(trialSubjectKey(verified, key)).delete();
      }
      await db.terminate(); await deleteAdminApp(admin);
    }
    await deleteApp(client); await rm(directory, { recursive: true, force: true });
  }
});

test('production Firebase wiring with missing dedicated key fails new trial readiness before clock or providers', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const uid = `missing-trial-key-${randomUUID()}`;
  const dependencies = createFirebaseDependencies('demo-riflo', undefined, 'demo-riflo.appspot.com', undefined, { executable: '/does-not-exist-controlled-provider', nodePath: process.execPath, ffmpegPath: '/does-not-exist-controlled-ffmpeg' }, true, true);
  const identity: RequestIdentity = { uid, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': [randomUUID()] } } };
  const server = createServer(createHandler({ ...dependencies, verifyToken: async () => identity }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [path, body] of [['/v1/sources/youtube/validate', { url: 'https://youtu.be/abcdefghijk' }], ['/v1/projects', { source: 'youtube', videoId: 'abcdefghijk' }]] as const) {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': 'missing_trial_key_01' }, body: JSON.stringify(body) });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'trial_not_configured');
    }
    const db = getFirestore(getApp('riflo-backend'));
    assert.equal((await db.collection('subscriptionGrants').doc(uid).get()).exists, false);
    assert.equal((await db.collection('trialAbuseBindings').doc(trialOwnerKey(uid)).get()).exists, false);
    assert.equal((await db.collection('accounts').doc(uid).collection('projects').get()).size, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const admin = getApp('riflo-backend'); await getFirestore(admin).terminate(); await deleteAdminApp(admin);
  }
});
