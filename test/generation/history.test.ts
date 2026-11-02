import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalOutput, priorOutputContext } from '../../src/generation/history.js';
import type { GeneratedOutput, GenerationFeature } from '../../src/generation/service.js';

const now = 1000;
const output = (feature: GenerationFeature, text: string, data?: GeneratedOutput['data']): GeneratedOutput => ({ id: 'output', feature, text, ...(data ? { data } : {}), createdAt: 10, expiresAt: 2000, model: 'fixture', promptVersion: 'fixture' });

test('exact comparison normalizes existing text boundaries without erasing meaningful differences', () => {
  const value = (text: string) => canonicalOutput('x_posts', { text });
  assert.equal(value('  Caf\u0065\u0301  '), value('Café'));
  for (const [first, second] of [['Use API', 'Use api'], ['10%', '100%'], ['Wait.', 'Wait!'], ['line\n  code', 'line\ncode'], ['a  b', 'a b']]) assert.notEqual(value(first!), value(second!));
});

test('structured comparisons retain headings, ordered slides and final legacy or multi-cut ranges', () => {
  const blog = { status: 'ok' as const, title: 'Lesson', bodyMarkdown: 'Keep the source meaning.' };
  const newsletter = { status: 'ok' as const, subject: 'Lesson', previewText: 'A practical point', bodyMarkdown: 'Keep the source meaning.' };
  assert.equal(canonicalOutput('blogs', output('blogs', '', blog)), canonicalOutput('blogs', output('blogs', '', { ...blog, bodyMarkdown: ' Keep the source meaning. ' })));
  assert.notEqual(canonicalOutput('blogs', output('blogs', '', blog)), canonicalOutput('blogs', output('blogs', '', { ...blog, title: 'Another lesson' })));
  assert.notEqual(canonicalOutput('newsletters', output('newsletters', '', newsletter)), canonicalOutput('newsletters', output('newsletters', '', { ...newsletter, previewText: 'Different preview' })));
  const slides = [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }];
  assert.notEqual(canonicalOutput('carousels', output('carousels', '', { status: 'ok', slides })), canonicalOutput('carousels', output('carousels', '', { status: 'ok', slides: [...slides].reverse() })));
  const legacy = output('short_videos', 'Old description', { status: 'ok', startSeconds: 10, endSeconds: 20 });
  const current = output('short_videos', 'Changed description', { status: 'ok', segments: [{ startSeconds: 10, endSeconds: 20 }] });
  assert.equal(canonicalOutput('short_videos', legacy), canonicalOutput('short_videos', current));
  assert.notEqual(canonicalOutput('short_videos', current), canonicalOutput('short_videos', output('short_videos', '', { status: 'ok', segments: [{ startSeconds: 10, endSeconds: 15 }, { startSeconds: 15, endSeconds: 20 }] })));
  assert.equal(canonicalOutput('short_videos', { text: 'A timestamp is not a validated cut plan.' }), null);
});

test('prompt history is recent, same-format, retained, bounded data with no asset paths', () => {
  const records = Array.from({ length: 40 }, (_, index) => ({ ...output('blogs', `${index} ${'private context '.repeat(300)}`, { status: 'ok' as const, title: `Lesson ${index}`, bodyMarkdown: 'A supported lesson.' }), id: `${index}`, createdAt: index, assets: [{ id: 'private', storagePath: 'private-path', bytes: 1, width: 1, height: 1, contentType: 'image/png' as const }] }));
  records.push({ ...records[0]!, id: 'expired', createdAt: 100, expiresAt: now });
  const history = priorOutputContext([...records, { ...output('x_posts', 'other-format'), createdAt: 100 }], 'blogs', now);
  assert.ok(history.previous_outputs.length > 0 && history.previous_outputs.length <= 12);
  assert.ok(JSON.stringify(history).length <= 8_000);
  assert.match(JSON.stringify(history.previous_outputs[0]), /39 private context/);
  assert.equal(history.omitted_outputs, 40 - history.previous_outputs.length);
  assert.doesNotMatch(JSON.stringify(history), /private-path|other-format|expired/);
  assert.deepEqual(priorOutputContext([], 'x_posts', now), { previous_outputs: [], omitted_outputs: 0 });
});
