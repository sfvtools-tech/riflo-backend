import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceAccess, originalSourceUrl, parseSourceInput, type SourceAdapter, type SourceDetails, type YouTubeInput } from '../../src/sources/source.js';
import type { DriveFileInput } from '../../src/sources/drive/files.js';

test('shared YouTube admission bounds accounts and process, releases failures and aborts, and excludes worker downloads', async () => {
  let calls = 0;
  const pending: Array<(value?: SourceDetails) => void> = [];
  const input = { source: 'youtube' as const, videoId: 'abcdefghijk' };
  const metadata: SourceDetails = { ...input, name: 'video', mimeType: 'video/mp4', bytes: null, durationSeconds: 60, requiresProbe: true };
  const access = createSourceAccess({ youtube: {
    validate: async (_uid, _input, _limits, signal) => {
      calls++;
      return new Promise<SourceDetails>((resolve, reject) => {
        pending.push(value => value ? resolve(value) : reject(new Error('validation failed')));
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    download: async () => ({ body: new ReadableStream(), finished: Promise.resolve(), cleanup: async () => {} }),
  } }, { total: 2, perAccount: 1 });
  const first = access.validate('alice', input);
  const abort = new AbortController();
  const second = access.validate('bob', input, undefined, abort.signal);
  await assert.rejects(access.validate('alice', input), { status: 429, code: 'source_validation_busy', retryAfterSeconds: 5 });
  await assert.rejects(access.validate('carol', input), { status: 503, code: 'source_validation_busy' });
  assert.equal(calls, 2);
  await access.download('alice', input, new AbortController().signal);
  const rejected = assert.rejects(second, { name: 'AbortError' }); abort.abort(); await rejected;
  const third = access.validate('carol', input);
  pending[0]!(); await assert.rejects(first, /validation failed/);
  pending[2]!(metadata); await third;
  const fourth = access.validate('alice', input); pending[3]!(metadata); await fourth;
  await assert.rejects(access.validate('alice', input, undefined, abort.signal), { name: 'AbortError' });
  assert.equal(calls, 4);
});

test('source parsing preserves existing Drive fingerprints and accepts only bounded typed sources', () => {
  const drive = { fileId: 'video-id', resourceKey: 'private-resource-key' };
  assert.equal(JSON.stringify(parseSourceInput(drive)), JSON.stringify(drive));
  assert.equal(JSON.stringify(parseSourceInput({ source: 'drive', ...drive })), JSON.stringify(drive));
  assert.deepEqual(parseSourceInput({ videoId: 'abcdefghijk', source: 'youtube' }), { source: 'youtube', videoId: 'abcdefghijk' });
  for (const url of ['https://youtu.be/abcdefghijk?si=shared', 'https://www.youtube.com/watch?v=abcdefghijk&t=30']) {
    assert.equal(JSON.stringify(parseSourceInput({ source: 'youtube', url })), JSON.stringify({ source: 'youtube', videoId: 'abcdefghijk' }));
  }
  for (const input of [
    { source: 'youtube', videoId: 'short' }, { source: 'youtube', videoId: 'https://evil.example' },
    { source: 'youtube', videoId: 'abcdefghijk', uid: 'another-account' },
    { source: 'youtube', videoId: 'abcdefghijk', url: 'http://127.0.0.1' },
    { source: 'youtube', videoId: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk' },
    { source: 'youtube', url: 'https://youtu.be/abcdefghijk', title: 'Untrusted title' },
    { source: 'youtube', url: null }, { source: 'youtube', url: 123 },
    { source: 'youtube', url: '' }, { source: 'youtube', url: 'https://evil.example/watch?v=abcdefghijk' },
    { source: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk&list=playlist' },
    { source: 'unknown', videoId: 'abcdefghijk' }, { source: 'drive', ...drive, uid: 'another-account' },
  ]) assert.throws(() => parseSourceInput(input));
});

test('original source links use validated provider identifiers and retain required Drive resource keys', () => {
  assert.equal(originalSourceUrl({ source: 'youtube', videoId: 'abcdefghijk' }), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(originalSourceUrl({ fileId: 'drive-file' }), 'https://drive.google.com/file/d/drive-file/view');
  assert.equal(originalSourceUrl({ source: 'drive', fileId: 'drive-file', resourceKey: 'access-key' }), 'https://drive.google.com/file/d/drive-file/view?resourcekey=access-key');
  for (const input of [null, { source: 'upload', fileId: 'local-file' }, { fileId: 'https://evil.example' }, { source: 'youtube', videoId: 'abcdefghijk', url: 'https://evil.example' }, { fileId: 'drive-file', resourceKey: 'key&redirect=evil' }]) {
    assert.equal(originalSourceUrl(input), null);
  }
});

test('source adapters receive only their own input and verified account while metadata can remain unknown', async () => {
  const calls: string[] = [];
  const youtubeMetadata: SourceDetails = { source: 'youtube', videoId: 'abcdefghijk', name: 'Video', mimeType: 'video/mp4', bytes: null, durationSeconds: null, requiresProbe: true };
  const download = { body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), finished: Promise.resolve(), cleanup: async () => undefined };
  const drive: SourceAdapter<DriveFileInput> = {
    validate: async (uid, input) => { calls.push(`drive/${uid}/${input.fileId}`); return { fileId: input.fileId, name: 'Drive video', mimeType: 'video/mp4', bytes: 9, durationSeconds: 10, requiresProbe: true }; },
    download: async (uid, input) => { calls.push(`drive-download/${uid}/${input.fileId}`); return download; },
  };
  const youtube: SourceAdapter<YouTubeInput> = {
    validate: async (uid, input) => { calls.push(`youtube/${uid}/${input.videoId}`); return youtubeMetadata; },
    download: async (uid, input, signal) => { assert.equal(signal.aborted, false); calls.push(`youtube-download/${uid}/${input.videoId}`); return download; },
  };
  const access = createSourceAccess({ drive, youtube });
  assert.deepEqual(access.availability, { drive: { configured: true }, youtube: { configured: true } });
  assert.equal((await access.validate('alice', { fileId: 'drive-file' })).name, 'Drive video');
  assert.deepEqual(await access.validate('bob', { source: 'youtube', videoId: 'abcdefghijk' }), youtubeMetadata);
  assert.equal(await access.download('bob', { source: 'youtube', videoId: 'abcdefghijk' }, new AbortController().signal), download);
  assert.deepEqual(calls, ['drive/alice/drive-file', 'youtube/bob/abcdefghijk', 'youtube-download/bob/abcdefghijk']);
});

test('an unconfigured source fails before attempting another adapter', async () => {
  const access = createSourceAccess({});
  assert.deepEqual(access.availability, { drive: { configured: false }, youtube: { configured: false } });
  for (const input of [{ fileId: 'video-id' }, { source: 'youtube' as const, videoId: 'abcdefghijk' }]) {
    await assert.rejects(access.validate('alice', input), { status: 503, code: 'source_not_configured' });
    await assert.rejects(access.download('alice', input, new AbortController().signal), { status: 503, code: 'source_not_configured' });
  }
});
