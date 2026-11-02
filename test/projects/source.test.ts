import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { cleanupAbandonedSources, createSourceImporter } from '../../src/projects/source.js';
import type { JobClaim } from '../../src/projects/service.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const claim = (): JobClaim => ({
  workerId: 'worker-a', attempt: 1, leaseUntil: now + 60_000, startedAt: now,
  project: {
    id: 'project-id', uid: 'alice', status: 'importing', input: { fileId: 'video-id', resourceKey: 'private-resource-key' },
    source: { fileId: 'video-id', name: 'video.mp4', mimeType: 'video/mp4', bytes: 8, durationSeconds: null, requiresProbe: true },
    createdAt: now, updatedAt: now, deadline: now + 86_400_000, sourceExpiresAt: null, storagePath: null,
    attempts: 1, errorCode: null, period: 'period-id', reservedSourceSeconds: 1800,
  },
});

function createImportFixture() {
  const uploaded: Array<{ path: string; content: Buffer; mimeType: string }> = [];
  const removed: string[] = [];
  const localPaths: string[] = [];
  let duration = 60;
  let failStream = false;
  let failUpload = false;
  let existingObject = false;
  let failCompletion = false;
  let cleanups = 0;
  let failCleanup = false;
  const importer = createSourceImporter({
    files: {
      download: async (uid, input) => {
        assert.equal(uid, 'alice');
        assert.deepEqual(input, { fileId: 'video-id', resourceKey: 'private-resource-key' });
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              if (failStream) controller.error(Error('private-stream-error'));
              else controller.close();
              return;
            }
            sent = true;
            controller.enqueue(Buffer.from('videobyte'));
          },
        });
        return { body, finished: failCompletion ? Promise.reject(Error('downloader-exited-unsuccessfully')) : Promise.resolve(), cleanup: async () => { cleanups++; if (failCleanup) throw Error('downloader-cleanup-failed'); } };
      },
    },
    prepare: async (path) => { localPaths.push(path); return { path, durationSeconds: duration, extension: 'mp4' }; },
    storage: {
      upload: async (localPath, storagePath, _signal, mimeType) => {
        uploaded.push({ path: storagePath, content: await readFile(localPath), mimeType });
        if (existingObject) throw Object.assign(Error('already exists'), { code: 412 });
        if (failUpload) throw Error('private-upload-error');
      },
      remove: async (path) => { removed.push(path); },
    },
  });
  return { importer, uploaded, removed, localPaths,
    setDuration: (seconds: number) => { duration = seconds; },
    failStream: () => { failStream = true; }, failUpload: () => { failUpload = true; },
    existingObject: () => { existingObject = true; },
    failCompletion: () => { failCompletion = true; }, cleanupCount: () => cleanups,
    failCleanup: () => { failCleanup = true; },
  };
}

test('validated upload and transcription overlap, checkpoint independently, and retain scratch until both settle', async () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const started = deferred();
  const finish = deferred();
  const checkpointed = deferred();
  let path = '';
  const removed: string[] = [];
  const stages: string[] = [];
  const importer = createSourceImporter({
    files: { download: async () => ({ body: new Response('video').body!, finished: Promise.resolve(), cleanup: async () => {} }) },
    prepare: async local => { path = local; return { path: local, extension: 'mp4', durationSeconds: 10 }; },
    storage: { upload: async () => { await started.promise; assert.equal(await readFile(path, 'utf8'), 'video'); }, remove: async value => { removed.push(value); } },
    checkpoint: async (_claim, result) => { assert.equal(result.bytes, 5); checkpointed.resolve(); },
    transcribe: async (_claim, result, _signal, local) => {
      assert.equal(local, path); assert.equal(result.bytes, 5); started.resolve();
      await finish.promise;
      assert.equal(await readFile(path, 'utf8'), 'video');
      throw new Error('simulated ambiguous transcript save');
    },
  });
  const task = importer(claim(), new AbortController().signal, progress => stages.push(progress.stage));
  await checkpointed.promise;
  await access(path);
  finish.resolve();
  await assert.rejects(task, { code: 'source_import_failed' });
  assert.deepEqual(removed, [], 'ASR failure must not delete the uploaded source');
  assert.ok(stages.includes('transcribe'));
  await assert.rejects(access(path));
});

test('a durable upload receipt resumes transcription without downloading or uploading again', async () => {
  const current = claim();
  current.project.importOperationId = 'operation';
  current.project.importUpload = { bytes: 5, durationSeconds: 10, storagePath: 'accounts/alice/projects/project-id/source/attempt-1.mp4', sourceSha256: 'a'.repeat(64), operationId: 'operation', attempt: 1 };
  current.attempt = 2;
  let transcribed = false;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected source I/O.'); };
  const importer = createSourceImporter({ files: { download: unexpected }, prepare: unexpected, storage: { upload: unexpected, remove: unexpected }, transcribe: async (_claim, result, _signal, local) => { transcribed = true; assert.equal(result, current.project.importUpload); assert.equal(local, undefined); } });
  assert.equal(await importer(current, new AbortController().signal), current.project.importUpload);
  assert.equal(transcribed, true);
});

test('upload failure waits for independent transcription before removing scratch', async () => {
  let uploaded!: () => void;
  const uploadFailed = new Promise<void>(resolve => { uploaded = resolve; });
  let path = '', transcriptSaved = false;
  const importer = createSourceImporter({
    files: { download: async () => ({ body: new Response('video').body!, finished: Promise.resolve(), cleanup: async () => {} }) },
    prepare: async local => { path = local; return { path: local, extension: 'mp4', durationSeconds: 10 }; },
    storage: { upload: async () => { uploaded(); throw new Error('upload interrupted'); }, remove: async () => {} },
    transcribe: async () => { await uploadFailed; assert.equal(await readFile(path, 'utf8'), 'video'); transcriptSaved = true; },
  });
  await assert.rejects(importer(claim(), new AbortController().signal), { code: 'source_import_failed' });
  assert.equal(transcriptSaved, true);
  await assert.rejects(access(path));
});

test('import probes actual bytes, uses a private attempt path, and removes its temporary file', async () => {
  const fixture = createImportFixture();
  const result = await fixture.importer(claim(), new AbortController().signal);
  assert.equal(result.bytes, 9);
  assert.equal(result.sourceSha256, createHash('sha256').update('videobyte').digest('hex'));
  assert.equal(result.durationSeconds, 60);
  assert.equal(fixture.uploaded.length, 1);
  assert.equal(fixture.uploaded[0]!.content.toString(), 'videobyte');
  assert.equal(fixture.uploaded[0]!.mimeType, 'video/mp4');
  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.storagePath.endsWith('attempt-1.mp4'));
  assert.ok(result.storagePath.includes('alice'));
  assert.ok(result.storagePath.includes('project-id'));
  assert.equal(fixture.uploaded[0]!.path, result.storagePath);
  assert.equal(fixture.cleanupCount(), 1);
  assert.ok(!result.storagePath.includes('private-resource-key'));
  await assert.rejects(access(fixture.localPaths[0]!));
  const next = claim();
  next.attempt = 2;
  const second = await fixture.importer(next, new AbortController().signal);
  assert.notEqual(second.storagePath, result.storagePath);
});

test('import benchmark tracing reports stored quantities without source credentials', async () => {
  const originalFlag = process.env.RIFLO_WORKER_TRACE;
  const originalInfo = console.info;
  const messages: string[] = [];
  process.env.RIFLO_WORKER_TRACE = '1';
  console.info = (...values: unknown[]) => { messages.push(values.join(' ')); };
  try {
    await createImportFixture().importer(claim(), new AbortController().signal);
    const metrics = messages.map(message => JSON.parse(message.slice(message.indexOf('{'))) as Record<string, unknown>);
    assert.ok(metrics.some(value => value.event === 'source.download-measured' && value.bytes === 9));
    for (const phase of ['source.open', 'source.copy', 'source.process-completion']) {
      assert.ok(metrics.some(value => value.event === `${phase}:begin`));
      assert.ok(metrics.some(value => value.event === `${phase}:end`));
    }
    assert.ok(metrics.some(value => value.event === 'source.stored-measured' && value.bytes === 9 && value.durationSeconds === 60 && value.extension === 'mp4'));
    assert.ok(!messages.join('\n').includes('private-resource-key'));
    assert.ok(!messages.join('\n').includes('videobyte'));
  } finally {
    console.info = originalInfo;
    if (originalFlag === undefined) delete process.env.RIFLO_WORKER_TRACE;
    else process.env.RIFLO_WORKER_TRACE = originalFlag;
  }
});

test('download progress reports bytes while copying and stops after completion', async (t) => {
  const originalFlag = process.env.RIFLO_WORKER_TRACE;
  const originalInfo = console.info;
  const metrics: Record<string, unknown>[] = [];
  let opened!: () => void;
  const copying = new Promise<void>(resolve => { opened = resolve; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  process.env.RIFLO_WORKER_TRACE = '1';
  console.info = (...values: unknown[]) => {
    const message = values.join(' ');
    const metric = JSON.parse(message.slice(message.indexOf('{'))) as Record<string, unknown>;
    metrics.push(metric);
    if (metric.event === 'source.copy:begin') opened();
  };
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    const importer = createSourceImporter({
      files: { download: async () => ({ body: new ReadableStream({ start(controller) { stream = controller; } }), finished: Promise.resolve(), cleanup: async () => {} }) },
      prepare: async path => ({ path, durationSeconds: 60, extension: 'mp4' }),
      storage: { upload: async () => {}, remove: async () => {} },
    });
    const pending = importer(claim(), new AbortController().signal);
    await copying;
    stream.enqueue(Buffer.from('video'));
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(15_000);
    assert.ok(metrics.some(value => value.event === 'source.download-progress' && value.bytes === 5));
    stream.close();
    await pending;
    const reports = metrics.filter(value => value.event === 'source.download-progress').length;
    t.mock.timers.tick(30_000);
    assert.equal(metrics.filter(value => value.event === 'source.download-progress').length, reports);
  } finally {
    console.info = originalInfo;
    if (originalFlag === undefined) delete process.env.RIFLO_WORKER_TRACE;
    else process.env.RIFLO_WORKER_TRACE = originalFlag;
  }
});

test('invalid actual durations are rejected before upload and temporary files are removed', async () => {
  for (const duration of [0, -1, NaN, Infinity, 1800.01]) {
    const fixture = createImportFixture();
    fixture.setDuration(duration);
    await assert.rejects(fixture.importer(claim(), new AbortController().signal));
    assert.equal(fixture.uploaded.length, 0);
    await assert.rejects(access(fixture.localPaths[0]!));
  }
});

test('failed streams never upload and failed uploads remove their attempted object', async () => {
  const stream = createImportFixture();
  stream.failStream();
  await assert.rejects(stream.importer(claim(), new AbortController().signal));
  assert.equal(stream.uploaded.length, 0);
  const upload = createImportFixture();
  upload.failUpload();
  await assert.rejects(upload.importer(claim(), new AbortController().signal));
  assert.deepEqual(upload.removed, [upload.uploaded[0]!.path]);
  await assert.rejects(access(upload.localPaths[0]!));
});

test('an aborted import does not publish an object', async () => {
  const fixture = createImportFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.importer(claim(), controller.signal));
  assert.equal(fixture.uploaded.length, 0);
  assert.equal(fixture.cleanupCount(), 1);
});

test('a clean media stream cannot hide a failed downloader process', async () => {
  const fixture = createImportFixture();
  fixture.failCompletion();
  await assert.rejects(fixture.importer(claim(), new AbortController().signal));
  assert.deepEqual(fixture.localPaths, []);
  assert.deepEqual(fixture.uploaded, []);
  assert.equal(fixture.cleanupCount(), 1);
});

test('adapter cleanup failure does not lose a stored source or its local cleanup', async () => {
  const fixture = createImportFixture();
  fixture.failCleanup();
  const result = await fixture.importer(claim(), new AbortController().signal);
  assert.equal(result.storagePath, fixture.uploaded[0]!.path);
  assert.equal(fixture.cleanupCount(), 1);
  await assert.rejects(access(fixture.localPaths[0]!));
});

test('cancellation after media EOF does not wait forever for downloader completion', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let cleanups = 0;
  let probes = 0;
  const importer = createSourceImporter({
    files: { download: async () => ({
      body: new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(Buffer.from('video')); stream.close(); } }),
      finished, cleanup: async () => { cleanups++; finish(); },
    }) },
    prepare: async (path) => { probes++; return { path, durationSeconds: 10, extension: 'mp4' }; },
    storage: { upload: async () => { throw Error('Cancelled media must not be uploaded.'); }, remove: async () => undefined },
  });
  const pending = importer(claim(), controller.signal);
  const abort = setTimeout(() => controller.abort(), 20);
  let timeout: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Downloader completion ignored cancellation.')), 1000); })]), { code: 'import_interrupted' });
    assert.equal(cleanups, 1);
    assert.equal(probes, 0);
  } finally {
    clearTimeout(abort);
    clearTimeout(timeout!);
    finish();
    await pending.catch(() => undefined);
  }
});

test('a retry cannot delete an object that already exists for its attempt', async () => {
  const fixture = createImportFixture();
  fixture.existingObject();
  await assert.rejects(fixture.importer(claim(), new AbortController().signal), { code: 'source_exists', retryable: false });
  assert.deepEqual(fixture.removed, []);
  await assert.rejects(access(fixture.localPaths[0]!));
});

test('the byte limit stops an oversized stream before probing or uploading', async () => {
  const fixture = createImportFixture();
  // A small limit exercises the real stream guard without writing gigabytes in a test.
  const boundedClaim = claim();
  boundedClaim.project.sourceLimits = { maxSourceSeconds: 1800, maxSourceBytes: 8 };
  try {
    await assert.rejects(fixture.importer(boundedClaim, new AbortController().signal), { code: 'source_too_large', retryable: false, bytes: 9 });
    assert.deepEqual(fixture.localPaths, []);
    assert.deepEqual(fixture.uploaded, []);
  } finally { /* The accepted snapshot is local to this attempt. */ }
});

test('normalized file size is checked and saved instead of trusting downloaded bytes', async () => {
  let uploads = 0;
  let preparedPath = '';
  const importer = createSourceImporter({
    files: { download: async () => ({ body: new Response('source').body!, finished: Promise.resolve(), cleanup: async () => undefined }) },
    prepare: async path => {
      preparedPath = path.replace('source.video', 'prepared.mp4');
      await writeFile(preparedPath, 'normalized-file');
      return { path: preparedPath, durationSeconds: 10, extension: 'mp4' };
    },
    storage: { upload: async () => { uploads++; }, remove: async () => undefined },
  });
  try {
    const boundedClaim = claim();
    boundedClaim.project.sourceLimits = { maxSourceSeconds: 1800, maxSourceBytes: 10 };
    await assert.rejects(importer(boundedClaim, new AbortController().signal), { code: 'source_too_large', bytes: 15 });
    assert.equal(uploads, 0);
    await assert.rejects(access(preparedPath));
    const result = await importer(claim(), new AbortController().signal);
    assert.equal(result.bytes, 15);
    assert.equal(result.sourceSha256, createHash('sha256').update('source').digest('hex'));
    assert.equal(uploads, 1);
    await assert.rejects(access(preparedPath));
  } finally { /* Temporary files are removed by the importer. */ }
});

test('abandoned source cleanup removes only old Riflo directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-cleanup-test-'));
  const expired = join(directory, 'riflo-source-expired');
  const fresh = join(directory, 'riflo-source-fresh');
  const unrelated = join(directory, 'other-app-source');
  const regularFile = join(directory, 'riflo-source-file');
  try {
    await Promise.all([mkdir(expired), mkdir(fresh), mkdir(unrelated), writeFile(regularFile, 'keep')]);
    for (const path of [expired, unrelated, regularFile]) {
      await utimes(path, new Date(now - 86_400_001), new Date(now - 86_400_001));
    }
    await utimes(fresh, new Date(now), new Date(now));
    await cleanupAbandonedSources(now, directory);
    await assert.rejects(access(expired));
    await Promise.all([access(fresh), access(unrelated), access(regularFile)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('restoration verifies original downloaded bytes before probing or upload', async () => {
  const fixture = createImportFixture();
  const restoring = claim();
  restoring.project.importIntent = 'source_restore';
  restoring.project.sourceSha256 = createHash('sha256').update('old-content').digest('hex');
  await assert.rejects(fixture.importer(restoring, new AbortController().signal), { code: 'source_changed', retryable: false });
  assert.equal(fixture.uploaded.length, 0);
  assert.equal(fixture.localPaths.length, 0);
  restoring.project.sourceSha256 = createHash('sha256').update('videobyte').digest('hex');
  assert.equal((await fixture.importer(restoring, new AbortController().signal)).sourceSha256, restoring.project.sourceSha256);
});

test('progress measures sequential download and upload separately and waits for provider completion', async () => {
  const updates: import('../../src/projects/service.js').ImportProgress[] = [];
  let finishDownload!: () => void, finishUpload!: () => void;
  const downloaded = new Promise<void>(resolve => { finishDownload = resolve; });
  const uploaded = new Promise<void>(resolve => { finishUpload = resolve; });
  let uploadStarted!: () => void;
  const uploadPending = new Promise<void>(resolve => { uploadStarted = resolve; });
  const importer = createSourceImporter({
    files: { download: async () => ({ totalBytes: 9, body: new Response('videobyte').body!, finished: downloaded, cleanup: async () => {} }) },
    prepare: async path => {
      assert.equal(updates.at(-1)!.stage, 'prepare');
      await writeFile(path, 'prepared');
      return { path, durationSeconds: 3, extension: 'mp4' };
    },
    storage: { remove: async () => {}, upload: async (_path, _destination, _signal, _type, progress) => {
      progress?.(8); uploadStarted(); await uploaded;
    } },
  });
  let done = false;
  const pending = importer(claim(), new AbortController().signal, update => updates.push(update)).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(updates.at(-1), { attempt: 1, stage: 'download', transferredBytes: 9, totalBytes: 9 });
  assert.ok(updates.every(update => update.stage === 'download'));
  finishDownload(); await uploadPending;
  assert.deepEqual(updates.filter(update => update.stage === 'prepare'), [{ attempt: 1, stage: 'prepare', transferredBytes: 0, totalBytes: null }]);
  assert.deepEqual(updates.at(-1), { attempt: 1, stage: 'upload', transferredBytes: 8, totalBytes: 8 });
  assert.equal(done, false, 'all bytes sent does not mean provider success');
  finishUpload(); assert.equal((await pending).bytes, 8);
});

test('unknown and inconsistent download totals never use metadata as a denominator', async () => {
  for (const totalBytes of [undefined, 3]) {
    const updates: import('../../src/projects/service.js').ImportProgress[] = [];
    const importer = createSourceImporter({
      files: { download: async () => ({ totalBytes, body: new Response('videobyte').body!, finished: Promise.resolve(), cleanup: async () => {} }) },
      prepare: async path => ({ path, durationSeconds: 3, extension: 'mp4' }),
      storage: { remove: async () => {}, upload: async () => {} },
    });
    await importer(claim(), new AbortController().signal, update => updates.push(update));
    assert.deepEqual(updates.filter(update => update.stage === 'download').at(-1), { attempt: 1, stage: 'download', transferredBytes: 9, totalBytes: null });
  }
});

test('worker coalesces chunk progress into bounded writes and closes reporting after completion', async () => {
  const { createIntakeWorker } = await import('../../src/projects/worker.js');
  type Progress = import('../../src/projects/service.js').ImportProgress;
  const saved: Progress[] = [];
  let report!: (progress: Progress) => void, release!: () => void, opened!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { opened = resolve; });
  const owned = claim(); owned.project.deadline = Date.now() + 60_000;
  const store = {
    claim: async () => owned,
    progress: async (_claim: unknown, progress: Progress) => { saved.push(progress); await gate; return true; },
    complete: async () => true,
    fail: async () => assert.fail('Unexpected import failure'),
  } as unknown as import('../../src/projects/service.js').ProjectStore;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const worker = createIntakeWorker({ store, importSource: async (_claim, _signal, callback) => {
    report = callback!;
    for (let bytes = 0; bytes < 10_000; bytes++) report({ attempt: 1, stage: 'download', transferredBytes: bytes, totalBytes: null });
    opened(); await done;
    return { bytes: 9, durationSeconds: 3, storagePath: 'accounts/alice/projects/project-id/source/attempt-1.mp4' };
  } });
  const running = worker.runOnce(); await started;
  assert.equal(saved.length, 1);
  release(); await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(saved.length, 2);
  assert.equal(saved[1]!.transferredBytes, 9999);
  finish(); await running;
  report({ attempt: 1, stage: 'upload', transferredBytes: 9, totalBytes: 9 });
  assert.equal(saved.length, 2);
});
