import assert from 'node:assert/strict';
import test from 'node:test';
import { createId } from '../../src/shared/id.js';

const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('IDs are UUID v7 and remain unique and ordered within one process at the same clock time', context => {
  context.mock.method(Date, 'now', () => Date.parse('2026-10-29T12:00:00Z'));
  const ids = Array.from({ length: 1000 }, () => createId());
  assert.ok(ids.every(id => uuid7.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort());
});
