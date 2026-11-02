import { createId } from '../shared/id.js';
import { FieldValue, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { safeWorkerCode, workerEvent } from '../worker-health.js';

export const storageCleanupLimits = Object.freeze({ pageSize: 50, pathsPerClaim: 10, leaseMilliseconds: 180_000, retryMilliseconds: 1_000, maxRetryMilliseconds: 3_600_000, requestMilliseconds: 15_000 });
type Owner = { uid: string; projectId: string };

/** Only immutable, attempt-specific Riflo objects can enter the deletion queue. */
export function cleanupOwner(paths: unknown): Owner | undefined {
  if (!Array.isArray(paths) || !paths.length) return undefined;
  let owner: Owner | undefined;
  for (const path of paths) {
    if (typeof path !== 'string') return undefined;
    const match = /^accounts\/([^/]+)\/projects\/([^/]+)\/(?:source\/attempt-[1-9]\d*\.(?:video|mp4|mov|webm|mkv|avi|mpeg|ogv|flv|asf|3gp|3g2|ts)|outputs\/[^/]+\/attempt-[1-9]\d*\/(?:slide-[1-5]\.png|clip\.mp4))$/.exec(path);
    if (!match || [match[1], match[2]].some(id => id === '.' || id === '..')) return undefined;
    const next = { uid: match[1], projectId: match[2] };
    if (owner && (owner.uid !== next.uid || owner.projectId !== next.projectId)) return undefined;
    owner = next;
  }
  return owner;
}

export function queueStorageCleanup(write: { set: (ref: DocumentReference, data: Record<string, unknown>, options: { merge: true }) => unknown }, ref: DocumentReference, paths: string[], now: number, recheckAt?: number) {
  if (!paths.length) return;
  const owner = cleanupOwner(paths);
  // The calling transaction has already irreversibly removed these attempts.
  write.set(ref, {
    paths: FieldValue.arrayUnion(...new Set(paths)), createdAt: now, nextCheckAt: now, nextPath: 0, deletionClaimed: true,
    ...(owner ? { owner } : {}),
    ...(recheckAt !== undefined ? { recheckAt } : {}),
  }, { merge: true });
}

export function cleanupFailure(error: unknown): { code: string; quarantine: boolean } {
  const code = safeWorkerCode(error);
  return { code, quarantine: ['400', '401', '403', '409', '412', 'invalid_argument', 'permission-denied', 'failed-precondition'].includes(code) };
}

export function cleanupRetry(attempts: number) {
  return Math.min(storageCleanupLimits.maxRetryMilliseconds, storageCleanupLimits.retryMilliseconds * 2 ** Math.min(Math.max(0, attempts - 1), 12));
}

// One cursor per database; this also adopts pre-scheduling manifests in bounded pages.
const legacyCursors = new WeakMap<Firestore, QueryDocumentSnapshot>();
export async function runStorageCleanup(db: Firestore, storage: { remove(path: string): Promise<void> }, now: number, canDelete?: (owner: Owner, paths: string[]) => Promise<boolean>) {
  const queue = db.collection('assetCleanup');
  let legacyQuery = queue.orderBy('__name__').limit(storageCleanupLimits.pageSize);
  const cursor = legacyCursors.get(db);
  if (cursor) legacyQuery = legacyQuery.startAfter(cursor);
  const legacy = await legacyQuery.get();
  if (legacy.size === storageCleanupLimits.pageSize) legacyCursors.set(db, legacy.docs.at(-1)!);
  else legacyCursors.delete(db);
  for (const doc of legacy.docs) {
    const data = doc.data();
    if (data.status === 'quarantined') {
      if (data.nextCheckAt !== undefined) {
        try { await doc.ref.update({ nextCheckAt: FieldValue.delete() }, { lastUpdateTime: doc.updateTime }); }
        catch (error) { if (!['5', '9'].includes(safeWorkerCode(error))) throw error; }
      }
      continue;
    }
    if (Number.isFinite(data.nextCheckAt)) continue;
    const schedule = data.nextCheckAt === undefined ? { nextCheckAt: now } : { status: 'quarantined', lastErrorCode: 'invalid_manifest', nextCheckAt: FieldValue.delete() };
    if (data.nextCheckAt !== undefined) workerEvent('cleanup.quarantined', { code: 'invalid_manifest' }, 'error');
    try { await doc.ref.update(schedule, { lastUpdateTime: doc.updateTime }); }
    catch (error) { if (!['5', '9'].includes(safeWorkerCode(error))) throw error; }
  }
  const pending = await queue.where('nextCheckAt', '<=', now).orderBy('nextCheckAt').limit(storageCleanupLimits.pageSize).get();
  workerEvent('cleanup.backlog', { phase: 'storage cleanup', backlog: pending.size, dueAgeMilliseconds: pending.empty ? 0 : Math.max(0, now - pending.docs[0].data().nextCheckAt) });
  let remaining = storageCleanupLimits.pageSize;
  for (const entry of pending.docs) {
    if (remaining <= 0) break;
    const claimId = createId();
    const claim = await db.runTransaction(async transaction => {
      const doc = await transaction.get(entry.ref);
      if (!doc.exists) return undefined;
      const data = doc.data()!;
      if (data.status === 'quarantined') {
        transaction.update(doc.ref, { nextCheckAt: FieldValue.delete() });
        return undefined;
      }
      const owner = cleanupOwner(data.paths);
      const valid = owner && (!data.owner || (data.owner.uid === owner.uid && data.owner.projectId === owner.projectId))
        && Number.isFinite(data.nextCheckAt) && (data.recheckAt === undefined || Number.isFinite(data.recheckAt))
        && (data.attempts === undefined || Number.isSafeInteger(data.attempts) && data.attempts >= 0)
        && (data.leaseUntil === undefined || Number.isFinite(data.leaseUntil))
        && (data.nextPath === undefined || Number.isSafeInteger(data.nextPath) && data.nextPath >= 0 && data.nextPath < data.paths.length);
      if (!valid) {
        transaction.update(doc.ref, { status: 'quarantined', lastErrorCode: 'invalid_manifest', nextCheckAt: FieldValue.delete() });
        workerEvent('cleanup.quarantined', { code: 'invalid_manifest' }, 'error');
        return undefined;
      }
      if (data.nextCheckAt > now) return undefined;
      if ((data.leaseUntil ?? 0) > now) {
        transaction.update(doc.ref, { nextCheckAt: data.leaseUntil });
        return undefined;
      }
      // Move a leased record out of the due page so crashed workers cannot starve it.
      transaction.update(doc.ref, { claimId, leaseUntil: now + storageCleanupLimits.leaseMilliseconds, nextCheckAt: now + storageCleanupLimits.leaseMilliseconds });
      return { ...data, recheckAt: data.recheckAt as number | undefined, owner, paths: data.paths as string[], start: data.nextPath ?? 0, attempts: (data.attempts ?? 0) + 1 };
    });
    if (!claim) continue;
    // Even a new marker may have been merged with old path-only entries. The
    // store must prove every path belongs to an irreversibly abandoned attempt.
    if (!canDelete || !await canDelete(claim.owner, claim.paths)) {
      await db.runTransaction(async transaction => {
        const current = await transaction.get(entry.ref);
        if (current.data()?.claimId !== claimId) return;
        transaction.update(entry.ref, { status: 'quarantined', lastErrorCode: 'unverified_deletion', claimId: FieldValue.delete(), leaseUntil: FieldValue.delete(), nextCheckAt: FieldValue.delete() });
      });
      workerEvent('cleanup.quarantined', { code: 'unverified_deletion' }, 'error');
      continue;
    }
    const end = Math.min(claim.paths.length, claim.start + storageCleanupLimits.pathsPerClaim, claim.start + remaining);
    remaining -= end - claim.start;
    let failure: ReturnType<typeof cleanupFailure> | undefined;
    try {
      for (const path of claim.paths.slice(claim.start, end)) await storage.remove(path);
    } catch (error) { failure = cleanupFailure(error); }
    await db.runTransaction(async transaction => {
      const current = await transaction.get(entry.ref);
      const data = current.data();
      if (!data || data.claimId !== claimId) return;
      const changed = JSON.stringify(data.paths) !== JSON.stringify(claim.paths) || (data.nextPath ?? 0) !== claim.start || data.recheckAt !== claim.recheckAt;
      const release = { claimId: FieldValue.delete(), leaseUntil: FieldValue.delete() };
      if (changed) { transaction.update(entry.ref, { ...release, nextCheckAt: now, nextPath: 0 }); return; }
      if (failure) {
        transaction.update(entry.ref, { ...release, attempts: claim.attempts, lastErrorCode: failure.code,
          ...(failure.quarantine ? { status: 'quarantined', nextCheckAt: FieldValue.delete() } : { nextCheckAt: now + cleanupRetry(claim.attempts) }) });
        workerEvent(failure.quarantine ? 'cleanup.quarantined' : 'cleanup.retry', { code: failure.code, attempt: claim.attempts }, failure.quarantine ? 'error' : 'warn');
      } else if (end < claim.paths.length) transaction.update(entry.ref, { ...release, nextPath: end, nextCheckAt: now });
      else if ((claim.recheckAt ?? 0) + storageCleanupLimits.requestMilliseconds > now && claim.recheckAt !== undefined) {
        transaction.update(entry.ref, { ...release, nextPath: 0, nextCheckAt: claim.recheckAt + storageCleanupLimits.requestMilliseconds, attempts: 0, lastErrorCode: FieldValue.delete() });
      } else transaction.delete(entry.ref);
    });
  }
}
