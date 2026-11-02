import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createRetentionAdoption } from '../../src/access/retention-adoption.js';
import { outputFingerprint } from '../../src/generation/history.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
test('server-owned hash proof completes large inventory in bounded pages, preserves promises and includes compatible concurrent inserts', local, async () => {
  const uid = `hash-proof-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const project = account.collection('projects').doc('project');
  const seam = createRetentionAdoption(db);
  const input = { uid, projectId: project.id, writersUpgraded: true };
  try {
    await project.set({ uid, id: project.id, status: 'source_expired' });
    const writes = db.batch();
    for (let index = 0; index < 45; index++) {
      const id = `output-${String(index).padStart(3, '0')}`;
      writes.set(project.collection('outputs').doc(id), { id, feature: 'x_posts', text: id, expiresAt: 123 });
    }
    // Retention adoption is conservative with large history; hash proof is independent of it.
    for (let index = 0; index < 51; index++) writes.set(project.collection('generation').doc(`history-${index}`), { status: 'completed' });
    await writes.commit();
    await assert.rejects(seam.backfillOutputFingerprints({ ...input, writersUpgraded: false, apply: true }));
    await assert.rejects(seam.backfillOutputFingerprints({ ...input, proofId: 'forged', apply: true }));
    const dry = await seam.backfillOutputFingerprints(input);
    assert.equal(dry.pageChecked, 20);
    assert.equal(dry.fingerprintsApplied, 0);
    assert.equal((await project.collection('maintenance').get()).size, 0);
    let page = await seam.backfillOutputFingerprints({ ...input, apply: true });
    assert.equal(page.checked, 20);
    assert.equal(page.complete, false);
    assert.equal((await project.get()).data()!.dedupVersion, undefined);
    const before = { id: 'before-cursor', feature: 'x_posts', text: 'concurrent', expiresAt: 456,
      contentFingerprint: outputFingerprint('x_posts', { text: 'concurrent' }) };
    await project.collection('outputs').doc(before.id).set(before);
    page = await seam.backfillOutputFingerprints({ ...input, proofId: page.proofId, apply: true });
    assert.equal(page.checked, 40);
    assert.equal(page.complete, false);
    page = await seam.backfillOutputFingerprints({ ...input, proofId: page.proofId, apply: true });
    assert.equal(page.checked, 45);
    assert.equal(page.complete, true);
    assert.equal((await project.get()).data()!.dedupVersion, 1);
    for (const doc of (await project.collection('outputs').get()).docs) {
      const output = doc.data();
      assert.equal(output.contentFingerprint, outputFingerprint('x_posts', { text: output.text }));
      assert.equal(output.expiresAt, doc.id === before.id ? 456 : 123);
      assert.equal(output.retention, undefined);
    }
    assert.equal((await seam.backfillOutputFingerprints({ ...input, proofId: page.proofId, apply: true })).pageChecked, 0);
    assert.equal((await account.collection('retentionAdoptions').get()).size, 0);
  } finally { await db.recursiveDelete(account); await db.terminate(); await deleteApp(app); }
});

test('noncanonical last page blocks proof without advancing server cursor or enabling indexed dedup', local, async () => {
  const uid = `hash-proof-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const project = account.collection('projects').doc('project');
  const seam = createRetentionAdoption(db);
  const input = { uid, projectId: project.id, writersUpgraded: true, apply: true, pageSize: 1 };
  try {
    await project.set({ uid, id: project.id, status: 'source_ready' });
    await project.collection('outputs').doc('a').set({ id: 'a', feature: 'x_posts', text: 'valid' });
    await project.collection('outputs').doc('b').set({ id: 'b', feature: 'blogs', text: 'invalid', data: { title: 'missing body' } });
    const first = await seam.backfillOutputFingerprints(input);
    await assert.rejects(seam.backfillOutputFingerprints({ ...input, proofId: first.proofId }), /Noncanonical output/);
    const proof = (await project.collection('maintenance').doc('output-fingerprint-proof').get()).data()!;
    assert.equal(proof.checked, 1);
    assert.equal(proof.afterOutputId, 'a');
    assert.equal((await project.get()).data()!.dedupVersion, undefined);
    await project.update({ status: 'deleted' });
    await assert.rejects(seam.backfillOutputFingerprints({ ...input, proofId: first.proofId }), /Project unavailable/);
  } finally { await db.recursiveDelete(account); await db.terminate(); await deleteApp(app); }
});
