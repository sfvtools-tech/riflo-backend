import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLongForm } from '../../src/generation/validation.js';
import { parseSelection } from '../../src/generation/service.js';

const blog = () => ({ status: 'ok', title: 'A practical source-based idea', bodyMarkdown: '## The idea\n\nA short explanation grounded in the source.\n\n- Start small.\n- Check the result.' });
const newsletter = () => ({ status: 'ok', subject: 'An idea worth trying', previewText: 'A useful lesson from this video.', bodyMarkdown: 'Hello,\n\nHere is a practical idea grounded in the source.\n\nTry it when it fits your situation.' });

test('blogs and newsletters preserve their fields and produce readable private text downloads', () => {
  const article = validateLongForm(blog(), 'blogs');
  assert.deepEqual(article.content, blog());
  assert.ok(article.text.includes(blog().title));
  assert.ok(article.text.includes(blog().bodyMarkdown));
  const email = validateLongForm(newsletter(), 'newsletters');
  assert.deepEqual(email.content, newsletter());
  assert.ok(email.text.includes(newsletter().subject));
  assert.ok(email.text.includes(newsletter().previewText));
  assert.ok(email.text.includes(newsletter().bodyMarkdown));
});

test('long-form validation rejects unknown fields, unsafe markup and oversized content', () => {
  for (const value of [null, [], {}, { ...blog(), status: 'maybe' }, { ...blog(), extra: 'not allowed' }, { ...blog(), title: '' }, { ...blog(), title: 'x'.repeat(121) }, { ...blog(), bodyMarkdown: 'x'.repeat(16001) }, { ...blog(), bodyMarkdown: 'word '.repeat(1201) }]) {
    assert.throws(() => validateLongForm(value, 'blogs'));
  }
  for (const bodyMarkdown of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '![image](file.png)', '[click](javascript:alert(1))', '[relative link](/private)', 'https://evil.example/private']) {
    assert.throws(() => validateLongForm({ ...blog(), bodyMarkdown }, 'blogs'));
    assert.throws(() => validateLongForm({ ...newsletter(), bodyMarkdown }, 'newsletters'));
  }
  for (const value of [{ ...newsletter(), subject: 'x'.repeat(101) }, { ...newsletter(), previewText: 'x'.repeat(161) }, { ...newsletter(), bodyMarkdown: 'x'.repeat(21001) }, { ...newsletter(), bodyMarkdown: 'word '.repeat(1501) }]) {
    assert.throws(() => validateLongForm(value, 'newsletters'));
  }
  assert.equal(validateLongForm({ ...blog(), title: 'x'.repeat(120), bodyMarkdown: 'word '.repeat(1200).trim() }, 'blogs').content.status, 'ok');
  assert.equal(validateLongForm({ ...newsletter(), subject: 'x'.repeat(100), previewText: 'x'.repeat(160), bodyMarkdown: 'word '.repeat(1500).trim() }, 'newsletters').content.status, 'ok');
  assert.equal(validateLongForm({ ...newsletter(), bodyMarkdown: 'x'.repeat(21000) }, 'newsletters').content.status, 'ok');
});

test('insufficient source is a non-success result rather than an empty delivered output', () => {
  assert.throws(() => validateLongForm({ status: 'insufficient_source', title: '', bodyMarkdown: '' }, 'blogs'), { code: 'insufficient_source', retryable: false });
  assert.throws(() => validateLongForm({ status: 'insufficient_source', subject: '', previewText: '', bodyMarkdown: '' }, 'newsletters'), { code: 'insufficient_source', retryable: false });
  assert.throws(() => validateLongForm({ ...blog(), status: 'insufficient_source' }, 'blogs'), { code: 'invalid_generated_output' });
});

test('long formats are optional and limited to one of each per request', () => {
  assert.deepEqual(parseSelection({ blogs: 1, newsletters: 1 }), { x_posts: 0, linkedin_posts: 0, blogs: 1, newsletters: 1 });
  for (const selection of [{ blogs: 2 }, { newsletters: 2 }, { blogs: 0.5 }, { newsletters: '1' }]) {
    assert.throws(() => parseSelection(selection));
  }
  assert.deepEqual(parseSelection(undefined), { x_posts: 2, linkedin_posts: 1 });
});
