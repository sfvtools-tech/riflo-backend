import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceAccess, type SourceDetails } from '../../src/sources/source.js';

test('validation burst rejects excess work and fully recovers after mixed cancellation, failure and success', async () => {
  const input = { source: 'youtube' as const, videoId: 'abcdefghijk' };
  const metadata: SourceDetails = { ...input, name: 'fixture', mimeType: 'video/mp4', bytes: 1, durationSeconds: 1, requiresProbe: true };
  let active = 0, peak = 0, calls = 0;
  let pending: Array<{ resolve: () => void; reject: () => void }> = [];
  const access = createSourceAccess({ youtube: {
    validate: async (_uid, _input, _limits, signal) => {
      calls++; active++; peak = Math.max(peak, active);
      try {
        return await new Promise<SourceDetails>((resolve, reject) => {
          const abort = () => reject(signal!.reason);
          const finish = (error?: Error) => { signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(metadata); };
          pending.push({ resolve: () => finish(), reject: () => finish(Error('fixture failure')) });
          signal?.addEventListener('abort', abort, { once: true });
        });
      } finally { active--; }
    },
    download: async () => { throw Error('Not used'); },
  } }, { total: 4, perAccount: 1 });
  for (let round = 0; round < 25; round++) {
    pending = [];
    const abort = new AbortController();
    const accepted = Array.from({ length: 4 }, (_, index) => access.validate(`account-${index}`, input, undefined, index === 0 ? abort.signal : undefined));
    // Attach rejection handlers before settling any admitted operation.
    const settled = Promise.allSettled(accepted);
    const refused = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => access.validate(index < 50 ? 'account-0' : `excess-${index}`, input)));
    assert.deepEqual(refused.map(result => result.status === 'rejected' ? result.reason.status : 200), [...Array(50).fill(429), ...Array(50).fill(503)]);
    assert.equal(active, 4);
    abort.abort(); pending[1]!.reject(); pending[2]!.resolve(); pending[3]!.resolve();
    assert.deepEqual((await settled).map(result => result.status), ['rejected', 'rejected', 'fulfilled', 'fulfilled']);
    assert.equal(active, 0);
  }
  assert.equal(calls, 100);
  assert.equal(peak, 4);
});
