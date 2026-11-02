import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupSourceScratch, reserveSourceScratch } from '../../src/projects/source.js';
import { createSourcePreparer, decodedMediaLimitsFromEnvironment, validateDecodedMedia } from '../../src/projects/adapters.js';
import type { statfs } from 'node:fs/promises';

const video = { codec_type: 'video', width: 4096, height: 2160, avg_frame_rate: '120/1', r_frame_rate: '120/1' };
test('decoded media permits DCI 4K120 and portrait and bounds every stream before packet scanning', () => {
  validateDecodedMedia({ streams: [video] });
  const cover = { ...video, disposition: { attached_pic: 1 }, avg_frame_rate: '0/0', r_frame_rate: '90000/1' };
  validateDecodedMedia({ streams: [cover, video] });
  assert.throws(() => validateDecodedMedia({ streams: [cover] }), { code: 'invalid_video' });
  assert.throws(() => validateDecodedMedia({ streams: [video, { ...cover, width: 9000 }] }), { code: 'source_decode_limits_exceeded' });
  validateDecodedMedia({ streams: [{ ...video, width: 2160, height: 4096 }] });
  validateDecodedMedia({ streams: [{ ...video, avg_frame_rate: '0/0', r_frame_rate: '30000/1001' }] });
  for (const change of [{ width: 8193, height: 1 }, { width: 4096, height: 2161 }, { avg_frame_rate: '121/1' }, { r_frame_rate: '121/1' }]) {
    assert.throws(() => validateDecodedMedia({ streams: [video, { ...video, ...change }] }), { code: 'source_decode_limits_exceeded', retryable: false });
  }
  assert.throws(() => validateDecodedMedia({ streams: Array.from({ length: 33 }, () => video) }), { code: 'source_decode_limits_exceeded' });
  for (const change of [{ width: 0 }, { height: NaN }, { avg_frame_rate: '0/0', r_frame_rate: '0/0' }, { avg_frame_rate: '1/0' }, { r_frame_rate: '-1/1' }]) {
    assert.throws(() => validateDecodedMedia({ streams: [{ ...video, ...change }] }), { code: 'invalid_video' });
  }
  const configured = decodedMediaLimitsFromEnvironment({ RIFLO_MEDIA_MAX_DIMENSION: '10000', RIFLO_MEDIA_MAX_PIXELS: '40000000', RIFLO_MEDIA_MAX_FPS: '240', RIFLO_MEDIA_MAX_STREAMS: '64' });
  validateDecodedMedia({ streams: [{ ...video, width: 7680, height: 4320, r_frame_rate: '240/1' }] }, configured);
  assert.throws(() => createSourcePreparer('unused', undefined, decodedMediaLimitsFromEnvironment({ RIFLO_MEDIA_MAX_FPS: 'NaN' })), /Invalid decoded media limits/);
});

test('scratch admission reserves input plus remux and headroom and releases idempotently', async () => {
  const required = 2n * 100n + 256n * 1024n ** 2n;
  let available = required - 1n;
  const inspect = (async () => ({ bavail: available, bsize: 1n })) as unknown as typeof statfs;
  await assert.rejects(reserveSourceScratch('unused', 100, inspect), { code: 'scratch_capacity_unavailable', retryable: true });
  await assert.rejects(reserveSourceScratch('unused', 100, (async () => { throw Object.assign(Error('private path'), { code: 'EACCES' }); }) as unknown as typeof statfs), { code: 'scratch_capacity_unavailable', retryable: true });
  available = required;
  const release = await reserveSourceScratch('unused', 100, inspect);
  try {
    await assert.rejects(reserveSourceScratch('unused', 100, inspect), { code: 'scratch_capacity_unavailable' });
  } finally { release(); release(); }
  (await reserveSourceScratch('unused', 100, inspect))();
});

test('failed scratch cleanup cannot replace a completed result or original failure and logs no paths', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const remove = async () => { throw Error('secret-local-path'); };
  const original = Error('original import failure');
  for (const fail of [false, true]) {
    const operation = async () => {
      try { if (fail) throw original; return 'committed-storage-path'; }
      finally { await cleanupSourceScratch('secret-local-path', remove); }
    };
    if (fail) await assert.rejects(operation(), error => error === original);
    else assert.equal(await operation(), 'committed-storage-path');
  }
  assert.deepEqual(warnings, [['[worker] source_scratch_cleanup_failed'], ['[worker] source_scratch_cleanup_failed']]);
  t.mock.method(console, 'warn', () => { throw Error('logging failed'); });
  await cleanupSourceScratch('secret-local-path', remove);
});

test('unavailable scratch root is a retryable capacity failure in import, audio and video', async () => {
  const { createSourceImporter } = await import('../../src/projects/source.js');
  const { createAudioExtractor } = await import('../../src/generation/audio.js');
  const { createVideoRenderer } = await import('../../src/generation/video.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'riflo-missing-scratch-test-'));
  const previous = process.env.TMPDIR;
  const unexpected = () => { throw Error('No source or tool work should start.'); };
  try {
    process.env.TMPDIR = join(root, 'missing');
    const source = createSourceImporter({ files: { download: unexpected }, prepare: unexpected, storage: { upload: unexpected, remove: unexpected } });
    const project = { id: 'test', uid: 'test', storagePath: 'source', source: { durationSeconds: 12 } } as import('../../src/projects/service.js').Project;
    const signal = new AbortController().signal;
    await assert.rejects(source({ project } as import('../../src/projects/service.js').JobClaim, signal), { code: 'scratch_capacity_unavailable', retryable: true });
    await assert.rejects(createAudioExtractor({ ffmpegPath: 'unused', readSource: unexpected })(project, signal), { code: 'scratch_capacity_unavailable', retryable: true });
    const render = createVideoRenderer({ ffmpegPath: 'unused', ffprobePath: 'unused', readSource: unexpected, storage: { uploadFile: unexpected, remove: unexpected } });
    await assert.rejects(render({ status: 'ok', segments: [{ startSeconds: 1, endSeconds: 11 }] }, { project } as import('../../src/generation/service.js').GenerationClaim, { text: 'Complete speech.', words: [{ text: 'Complete', start: 1, end: 2 }, { text: 'speech.', start: 10, end: 11 }] }, signal), { code: 'scratch_capacity_unavailable', retryable: true });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
