import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../../src/access/lifecycle-firestore.js';
import { createGenerationStore } from '../../src/generation/firestore.js';
import { priorOutputContext } from '../../src/generation/history.js';

const local = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const iso = (time: number) => new Date(time).toISOString();

test('feature-filtered output reads preserve complete mixed history and effective retention before history bounds', local, async () => {
  const uid = `filtered-history-${randomUUID()}`;
  const app = initializeApp({ projectId: 'demo-riflo' }, uid);
  const db = getFirestore(app);
  const account = db.collection('accounts').doc(uid);
  const grant = db.collection('subscriptionGrants').doc(uid);
  const project = account.collection('projects').doc('history-project');
  const outputs = project.collection('outputs');
  let clock = start;
  const lifecycle = createLifecycleStore(db, { retentionEnabled: true, now: () => clock });
  try {
    await project.set({ uid, id: project.id, status: 'ready' });
    await lifecycle.startTrial(uid, start);
    clock = start + 5 * day;
    const paid = await lifecycle.transition(uid, 'history-activation', { type: 'activate_paid', expectedRevision: 1, plan: 'lower', periodId: randomUUID(), startsAt: iso(clock), expiresAt: iso(start + 35 * day) });
    clock = start + 35 * day;
    await lifecycle.transition(uid, 'history-renewal', { type: 'renew', expectedRevision: paid.revision, plan: 'lower', periodId: randomUUID(), startsAt: iso(clock), expiresAt: iso(start + 65 * day) });
    clock = start + 100 * day;
    const write = db.batch();
    const seed = (id: string, value: Record<string, unknown>) => write.set(outputs.doc(id), { id, feature: 'x_posts', text: `Lesson ${id}`, createdAt: start, expiresAt: clock + day, model: 'fixture', promptVersion: 'fixture', ...value });
    for (let index = 0; index < 16; index++) {
      seed(`x-${String(index).padStart(2, '0')}`, { createdAt: start + index, ...(index % 2 ? { data: { kind: 'thread', posts: [`Thread ${index} first`, `Thread ${index} second`] } } : {}) });
    }
    seed('promoted-trial', { createdAt: start + 20, expiresAt: start + 30 * day, retention: { version: 1, kind: 'trial', startsAt: start, promisedUntil: start + 30 * day } });
    seed('renewed-paid', { createdAt: start + 20, expiresAt: start + 95 * day, retention: { version: 1, kind: 'paid', tenureId: paid.retention!.paidTenureId!, promisedUntil: start + 95 * day } });
    seed('expired', { createdAt: clock, expiresAt: clock });
    seed('invalid-thread', { createdAt: clock, data: { kind: 'thread', posts: [42] } });
    seed('linkedin', { feature: 'linkedin_posts', createdAt: clock });
    seed('blog', { feature: 'blogs', createdAt: clock, data: { title: 'Title', bodyMarkdown: 'Body' } });
    await write.commit();

    const store = createGenerationStore(db);
    const full = await store.outputs(uid, project.id, clock);
    const filtered = await store.outputs(uid, project.id, clock, 'x_posts');
    assert.deepEqual(filtered, full.filter(output => output.feature === 'x_posts'));
    assert.equal(full.length, 21);
    assert.equal(filtered.length, 19);
    assert.ok(filtered.some(output => output.data && 'kind' in output.data && output.data.kind === 'thread'));
    assert.ok(filtered.some(output => output.data === undefined));
    for (const id of ['promoted-trial', 'renewed-paid']) {
      assert.equal(filtered.find(output => output.id === id)?.expiresAt, start + 125 * day);
      assert.ok((await outputs.doc(id).get()).data()!.expiresAt < clock);
    }
    const history = priorOutputContext(filtered, 'x_posts', clock);
    assert.deepEqual(history, priorOutputContext(full, 'x_posts', clock));
    assert.equal(history.previous_outputs.length, 12);
    assert.equal(history.omitted_outputs, 6);
    assert.deepEqual(history.previous_outputs.slice(0, 2), [{ excerpt: 'Lesson promoted-trial' }, { excerpt: 'Lesson renewed-paid' }]);
    assert.ok(!JSON.stringify(history).includes('invalid-thread'));
    assert.ok(!JSON.stringify(history).includes('expired'));
  } finally {
    await db.recursiveDelete(account);
    await grant.delete();
    await db.terminate();
    await deleteApp(app);
  }
});
