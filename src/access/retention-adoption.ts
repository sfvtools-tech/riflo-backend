import { createHash } from 'node:crypto';
import { FieldPath, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { isLifecycle } from './lifecycle.js';
import { createId } from '../shared/id.js';
import { outputFingerprint } from '../generation/history.js';
import { featureIds } from './policy.js';
import { readRetentionContext } from './retention-firestore.js';
import { isPaidTenure, resolveRetention, validDeadline, type PaidTenure, type RetentionOrigin, type RetentionKind, type RetentionPolicy } from './retention.js';

const day = 86_400_000;
const identity = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const adoptionLimits = Object.freeze({ outputs: 20, history: 50, events: 50 });
type Item = { path: string; kind: RetentionKind; reason: string; expiresAt?: number };

/** Trusted maintenance seam only. No reader, worker, HTTP route or startup calls this. */
export function createRetentionAdoption(db: Firestore, { now = Date.now }: { now?: () => number } = {}) {
  return {
    /** Call only after every output writer is upgraded; keep that deployment fence for the entire proof. */
    async backfillOutputFingerprints(input: { uid: string; projectId: string; apply?: boolean; pageSize?: number; proofId?: string; writersUpgraded: boolean }) {
      const size = input.pageSize ?? adoptionLimits.outputs;
      if (!identity(input.uid) || !identity(input.projectId) || input.proofId !== undefined && !identity(input.proofId)
        || !Number.isSafeInteger(size) || size < 1 || size > adoptionLimits.outputs || input.writersUpgraded !== true) {
        throw new Error('Invalid bounded hash proof or upgraded writers not confirmed.');
      }
      return db.runTransaction(async transaction => {
        const projectRef = db.collection('accounts').doc(input.uid).collection('projects').doc(input.projectId);
        const proofRef = projectRef.collection('maintenance').doc('output-fingerprint-proof');
        const [projectDoc, proofDoc] = await Promise.all([transaction.get(projectRef), transaction.get(proofRef)]);
        const project = projectDoc.data();
        if (!project || project.uid !== input.uid || project.id !== input.projectId || project.status === 'deleted') throw new Error('Project unavailable.');
        const savedProof = proofDoc.data();
        if (input.proofId && (savedProof?.id !== input.proofId || savedProof.version !== 1 || savedProof.uid !== input.uid || savedProof.projectId !== input.projectId
          || savedProof.afterOutputId !== null && !identity(savedProof.afterOutputId)
          || !Number.isSafeInteger(savedProof.checked) || savedProof.checked < 0 || typeof savedProof.complete !== 'boolean')) throw new Error('Hash proof does not match server state.');
        const proof = input.proofId ? savedProof! : { id: createId(), uid: input.uid, projectId: input.projectId, version: 1, afterOutputId: null, checked: 0, complete: false };
        if (proof.complete) return { proofId: proof.id as string, checked: proof.checked as number, pageChecked: 0, fingerprintsApplied: 0, complete: true, applied: input.apply === true };
        let query = projectRef.collection('outputs').orderBy(FieldPath.documentId()).limit(size + 1);
        if (proof.afterOutputId) query = query.startAfter(proof.afterOutputId);
        const outputs = await transaction.get(query);
        const page = outputs.docs.slice(0, size);
        const patches = page.map(doc => {
          const output = doc.data();
          const fingerprint = featureIds.includes(output.feature) && typeof output.text === 'string'
            ? outputFingerprint(output.feature, { text: output.text, data: output.data }) : null;
          if (!fingerprint || output.id !== doc.id) throw new Error(`Noncanonical output blocks hash proof: ${doc.id}`);
          return { ref: doc.ref, fingerprint, changed: output.contentFingerprint !== fingerprint };
        });
        const complete = outputs.size <= size;
        const next = { ...proof, afterOutputId: page.at(-1)?.id ?? proof.afterOutputId, checked: proof.checked + page.length, complete };
        if (input.apply === true) {
          for (const patch of patches) if (patch.changed) transaction.update(patch.ref, { contentFingerprint: patch.fingerprint });
          transaction.set(proofRef, next);
          if (complete && project.dedupVersion !== 1) transaction.update(projectRef, { dedupVersion: 1 });
        }
        return { proofId: proof.id as string, checked: next.checked as number, pageChecked: page.length,
          fingerprintsApplied: input.apply === true ? patches.filter(patch => patch.changed).length : 0, complete, applied: input.apply === true };
      }, { maxAttempts: 3 });
    },
    async adoptProject(input: { uid: string; projectId: string; apply?: boolean; pageSize?: number; afterOutputId?: string; writersUpgraded?: boolean }) {
      const size = input.pageSize ?? adoptionLimits.outputs;
      if (!identity(input.uid) || !identity(input.projectId) || input.afterOutputId !== undefined && !identity(input.afterOutputId)
        || !Number.isSafeInteger(size) || size < 1 || size > adoptionLimits.outputs) throw new Error('Invalid bounded adoption request.');
      return db.runTransaction(async transaction => {
        const at = now();
        if (!validDeadline(at)) throw new Error('Invalid adoption time.');
        const account = db.collection('accounts').doc(input.uid);
        const projectRef = account.collection('projects').doc(input.projectId);
        let query = projectRef.collection('outputs').orderBy(FieldPath.documentId()).limit(size);
        if (input.afterOutputId) query = query.startAfter(input.afterOutputId);
        const [projectDoc, accessDoc, history, events, outputs, transcriptDoc, sourceDelete, projectDelete, audit] = await Promise.all([
          transaction.get(projectRef), transaction.get(db.collection('subscriptionGrants').doc(input.uid)),
          transaction.get(projectRef.collection('generation').limit(adoptionLimits.history + 1)),
          transaction.get(account.collection('usageEvents').where('projectId', '==', input.projectId).limit(adoptionLimits.events + 1)),
          transaction.get(query), transaction.get(projectRef.collection('transcripts').doc('shared')),
          transaction.get(db.collection('assetCleanup').doc(`${input.projectId}-expired`)),
          transaction.get(db.collection('assetCleanup').doc(`${input.projectId}-deleted`)),
          input.writersUpgraded === true ? transaction.get(projectRef.collection('outputs').limit(adoptionLimits.outputs + 1)) : Promise.resolve(undefined),
        ]);
        const project = projectDoc.data();
        let access = accessDoc.data();
        let newTenure: PaidTenure | undefined;
        let authorityWouldChange = false;
        if (isLifecycle(access) && !access.retention && !access.withdrawn && access.revision < Number.MAX_SAFE_INTEGER) {
          const paid = access.paid?.grant;
          if (paid) newTenure = { id: createId(), uid: input.uid, startsAt: Date.parse(paid.startsAt), activatedAt: at, paidAccessEndsAt: Date.parse(paid.expiresAt), revision: 0 };
          const paidActive = paid && Date.parse(paid.startsAt) <= at && Date.parse(paid.expiresAt) > at;
          if (!newTenure || isPaidTenure(newTenure)) {
            access = { ...access, revision: access.revision + 1, retention: { version: 1, paidTenureId: newTenure?.id ?? null,
              ...(paidActive && access.trial ? { trialPromotion: { at, tenureId: newTenure!.id } } : {}) } };
            authorityWouldChange = true;
          } else newTenure = undefined;
        }
        const items: Item[] = [];
        const pending: Array<{ ref: DocumentReference; patch: Record<string, unknown> }> = [];
        const fingerprints = new Map<string, { ref: DocumentReference; patch: { contentFingerprint: string } }>();
        const tombstones = new Set<string>();
        const batches = history.docs.map(doc => doc.data());
        const unavailable = !project || project.uid !== input.uid || project.id !== input.projectId || project.status === 'deleted' || projectDelete.exists ? 'project_unavailable'
          : !isLifecycle(access) || !access.retention || access.withdrawn ? 'authority_unverified'
          : history.size > adoptionLimits.history || events.size > adoptionLimits.events ? 'history_limit'
          : ['queued', 'importing'].includes(project.status) || batches.some(batch => ['queued', 'transcribing', 'generating'].includes(batch.status)) ? 'active_work' : undefined;
        const context = await readRetentionContext(db, input.uid, access, outputs.docs.map(doc => doc.data().retention), transaction);
        if (newTenure) context.tenures = new Map([...context.tenures, [newTenure.id, newTenure]]);
        const periods = new Map<string, RetentionOrigin | undefined>();
        async function origin(period: unknown): Promise<RetentionOrigin | undefined> {
          if (typeof period !== 'string' || !period.startsWith('shared-') || !identity(period.slice(7)) || !isLifecycle(access) || !access.retention) return undefined;
          if (periods.has(period)) return periods.get(period);
          let result: RetentionOrigin | undefined;
          if (access.trial && period === `shared-${access.trial.allowancePeriodId}` && (!access.paid || access.retention.trialPromotion)) result = { kind: 'trial', startsAt: Date.parse(access.trial.startsAt) };
          else {
            let frozen = access;
            if (!access.paid || period !== `shared-${access.paid.grant.allowancePeriodId}`) {
              const proof = (await transaction.get(account.collection('allowancePeriods').doc(period.slice(7)))).data();
              if (proof && typeof proof.eventId === 'string' && identity(proof.eventId)) {
                const receipt = (await transaction.get(account.collection('lifecycleTransitions').doc(proof.eventId))).data();
                const saved = receipt?.result;
                if (isLifecycle(saved) && saved.paid?.grant.allowancePeriodId === period.slice(7)
                  && saved.paid.grant.startsAt === proof.startsAt && saved.paid.grant.expiresAt === proof.expiresAt) frozen = saved;
              }
            }
            if (frozen.paid && period === `shared-${frozen.paid.grant.allowancePeriodId}` && frozen.retention?.paidTenureId) {
              const id = frozen.retention.paidTenureId;
              const fact = context.tenures.get(id) ?? (await transaction.get(account.collection('retentionTenures').doc(id))).data();
              if (isPaidTenure(fact) && fact.uid === input.uid && fact.id === id && fact.startsAt <= Date.parse(frozen.paid.grant.startsAt)
                && fact.paidAccessEndsAt >= Date.parse(frozen.paid.grant.expiresAt)) {
                context.tenures = new Map([...context.tenures, [id, fact]]);
                result = { kind: 'paid', tenureId: id };
              }
            }
          }
          periods.set(period, result);
          return result;
        }
        async function candidate(ref: DocumentReference, kind: RetentionKind, saved: Record<string, any>, period: unknown, extra: Record<string, unknown> = {}, blocked?: string) {
          const tombstone = await transaction.get(projectRef.collection('retentionDeletions').doc(`${kind}-${kind === 'source' ? input.projectId : ref.id}`));
          if (tombstone.exists) tombstones.add(ref.path);
          const deadline = kind === 'source' ? saved.sourceExpiresAt : saved.expiresAt;
          const policy = kind === 'source' ? saved.sourceRetention : saved.retention;
          let reason = unavailable ?? (policy !== undefined ? 'already_managed' : tombstone.exists || saved.deletedAt !== undefined ? 'deletion_claimed' : blocked)
            ?? (!validDeadline(deadline) ? 'deadline_unverified' : deadline <= at ? 'already_expired' : undefined);
          const accepted = reason ? undefined : await origin(period);
          if (!reason && !accepted) reason = 'origin_unverified';
          if (reason) { items.push({ path: ref.path, kind, reason }); return; }
          const policyValue: RetentionPolicy = { ...accepted!, version: 1, promisedUntil: deadline };
          const resolved = resolveRetention({ kind, retention: policyValue, expiresAt: deadline, importedAt: extra.importedAt as number | undefined }, at, context);
          if (!resolved.valid || !resolved.available || resolved.expiresAt === null) { items.push({ path: ref.path, kind, reason: 'retention_facts_unavailable' }); return; }
          policyValue.promisedUntil = resolved.expiresAt;
          const patch = kind === 'source' ? { sourceRetention: policyValue, ...extra, sourceCleanupAt: policyValue.promisedUntil } : { retention: policyValue };
          pending.push({ ref, patch });
          items.push({ path: ref.path, kind, reason: 'eligible', expiresAt: policyValue.promisedUntil });
        }
        if (project) {
          const duration = project.sourceRetentionDays;
          // The frozen duration and saved success deadline prove this anchor; updatedAt never does.
          const importedAt = validDeadline(project.sourceExpiresAt) && [1, 7, 30].includes(duration) ? project.sourceExpiresAt - duration * day : undefined;
          await candidate(projectRef, 'source', project, project.period, { importedAt },
            project.status !== 'source_ready' || !project.storagePath ? 'source_unavailable' : sourceDelete.exists ? 'deletion_claimed' : !validDeadline(importedAt) ? 'import_anchor_unverified' : undefined);
        }
        if (transcriptDoc.exists) {
          const saved = transcriptDoc.data()!;
          // Exact successful save event links the transcript to the batch that transcribed it, never a cache consumer.
          const successes = events.docs.map(doc => doc.data()).filter(event => event.uid === input.uid && event.projectId === input.projectId && event.stage === 'transcribe' && event.status === 'succeeded' && validDeadline(saved.createdAt) && event.endedAt === saved.createdAt);
          const matches = successes.flatMap(event => batches.filter(batch => batch.uid === input.uid && batch.projectId === input.projectId && (batch.id ?? 'batch') === event.batchId));
          await candidate(transcriptDoc.ref, 'transcript', saved, matches[0]?.period, {}, matches.length === 1 ? undefined : 'transcription_origin_unverified');
        }
        for (const doc of outputs.docs) {
          const saved = doc.data();
          const deletion = await transaction.get(db.collection('assetCleanup').doc(createHash('sha256').update(doc.ref.path).digest('hex')));
          const matches = batches.filter(batch => batch.uid === input.uid && batch.projectId === input.projectId && Array.isArray(batch.slots)
            && batch.slots.some((slot: any) => slot.id === doc.id && slot.feature === saved.feature && slot.status === 'ready'));
          await candidate(doc.ref, 'output', saved, matches[0]?.period, {}, deletion.exists ? 'deletion_claimed' : matches.length !== 1 || saved.id !== doc.id ? 'accepted_slot_unverified' : undefined);
          const fingerprint = featureIds.includes(saved.feature) && typeof saved.text === 'string' ? outputFingerprint(saved.feature, { text: saved.text, data: saved.data }) : null;
          const adopted = pending.find(entry => entry.ref.path === doc.ref.path)?.patch.retention;
          const retained = resolveRetention({ kind: 'output', expiresAt: saved.expiresAt, retention: adopted ?? saved.retention }, at, context).available;
          if (!unavailable && !deletion.exists && !tombstones.has(doc.ref.path) && saved.deletedAt === undefined && retained && fingerprint && saved.contentFingerprint !== fingerprint) {
            fingerprints.set(doc.ref.path, { ref: doc.ref, patch: { contentFingerprint: fingerprint } });
          }
        }
        // A cursor alone cannot prove earlier pages or exclude concurrent old writers.
        // Larger projects use backfillOutputFingerprints' server-owned resumable proof.
        const dedupComplete = input.writersUpgraded === true && !unavailable && audit !== undefined && audit.size <= adoptionLimits.outputs
          && audit.docs.every(doc => {
            const saved = doc.data();
            const fingerprint = featureIds.includes(saved.feature) && typeof saved.text === 'string' ? outputFingerprint(saved.feature, { text: saved.text, data: saved.data }) : null;
            return fingerprint !== null && (fingerprints.get(doc.ref.path)?.patch.contentFingerprint ?? saved.contentFingerprint) === fingerprint;
          });
        if (input.apply === true) {
          if (authorityWouldChange && pending.length) {
            transaction.set(accessDoc.ref, access!);
            if (newTenure) transaction.create(account.collection('retentionTenures').doc(newTenure.id), newTenure);
            transaction.create(account.collection('retentionAdoptions').doc(createId()), { at, projectId: input.projectId, revision: access!.revision, adopted: pending.length });
          }
          for (const entry of pending) transaction.update(entry.ref, entry.patch);
          for (const entry of fingerprints.values()) transaction.update(entry.ref, entry.patch);
          if (dedupComplete && project?.dedupVersion !== 1) transaction.update(projectRef, { dedupVersion: 1 });
        }
        return { applied: input.apply === true ? pending.length : 0, eligible: pending.length, skipped: items.length - pending.length,
          items, fingerprintsEligible: fingerprints.size, fingerprintsApplied: input.apply === true ? fingerprints.size : 0,
          dedupComplete, authorityWouldChange: authorityWouldChange && pending.length > 0, cutoff: at, nextOutputId: outputs.size === size ? outputs.docs.at(-1)!.id : null,
          warnings: ['Only surviving records with complete verified facts are eligible; skipped records keep their saved behavior.',
            ...(!dedupComplete ? ['Compatibility deduplication stays enabled until upgraded writers and a complete bounded hash audit are verified.'] : [])] };
      }, { maxAttempts: 3 });
    },
  };
}
