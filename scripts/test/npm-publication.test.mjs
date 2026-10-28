import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublished } from '../npm-publication.mjs';

const specifier = '@taleland/outbox-core@1.0.0';
const ok = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const failure = (code, summary) => ({ status: 1, stdout: JSON.stringify({ error: { code, summary } }), stderr: '' });
const missing = failure('E404', 'Not found');
const available = ok('1.0.0');
test('only a missing version permits a new publication', () => {
  assert.equal(isPublished(specifier, () => missing), false);
  assert.equal(isPublished(specifier, () => available), true);
  assert.equal(isPublished(specifier, () => ok(['1.0.0'])), true);
  assert.throws(() => isPublished(specifier, () => ok([])), /Unexpected registry version/);
  assert.throws(() => isPublished(specifier, () => ok(['1.0.0', '2.0.0'])), /Unexpected registry version/);
  assert.throws(() => isPublished(specifier, () => failure('E401', 'Unauthorized')), /Cannot check/);
  assert.throws(() => isPublished(specifier, () => ok('2.0.0')), /Unexpected registry version/);
});
