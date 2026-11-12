import type { RetentionPolicy } from '../../src/access/retention.js';

// A real trial clock ending at the test boundary, independent of current access.
export function trialPolicy(expiresAt: number, days = 30): RetentionPolicy {
  return { version: 1, kind: 'trial', startsAt: expiresAt - days * 86_400_000, promisedUntil: expiresAt };
}
export function sourceDeadline(sourceExpiresAt: number) {
  return { sourceExpiresAt, sourceCleanupAt: sourceExpiresAt, sourceRetention: trialPolicy(sourceExpiresAt, 14) };
}
export function contentDeadline(expiresAt: number) {
  return { expiresAt, cleanupAt: expiresAt, retention: trialPolicy(expiresAt) };
}
