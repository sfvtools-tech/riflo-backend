import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCost } from '../../src/generation/firestore.js';
import { unknownUsage, type RateSnapshot } from '../../src/generation/service.js';

const rates: RateSnapshot = { model: 'test-model', capturedAt: '2026-10-18T12:00:00Z', inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 10_000_000, cacheReadMicrosPerMillion: 200_000, cacheWriteMicrosPerMillion: null, transcriptionMicrosPerMinute: 1000 };

test('cost estimates use separate uncached and cached tokens while preserving the rate snapshot', () => {
  const usage = { ...unknownUsage(), inputTokens: 150, nonCachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 };
  assert.deepEqual(estimateCost(usage, rates, 'generate'), { status: 'estimated', amountMicros: 310, currency: 'USD', rateSnapshot: rates });
  assert.equal(estimateCost({ ...usage, nonCachedInputTokens: null }, rates, 'generate').status, 'unknown');
  assert.equal(estimateCost({ ...usage, cacheWriteTokens: 1 }, rates, 'generate').status, 'unknown');
  assert.equal(estimateCost(usage, null, 'generate').amountMicros, null);
});

test('transcription cost uses measured seconds and keeps absent measurements unknown', () => {
  assert.equal(estimateCost({ ...unknownUsage(), seconds: 30 }, rates, 'transcribe').amountMicros, 500);
  assert.equal(estimateCost(unknownUsage(), rates, 'transcribe').status, 'unknown');
  assert.equal(estimateCost({ ...unknownUsage(), seconds: 30 }, { ...rates, transcriptionMicrosPerMinute: null }, 'transcribe').amountMicros, null);
});
