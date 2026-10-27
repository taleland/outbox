import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublished, publishPackage } from '../npm-publication.mjs';

const specifier = '@taleland/outbox-core@1.0.0';
const ok = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const failure = (code, summary) => ({ status: 1, stdout: JSON.stringify({ error: { code, summary } }), stderr: '' });
const missing = failure('E404', 'Not found');
const available = ok('1.0.0');
const duplicate = failure('E403', 'You cannot publish over the previously published versions: 1.0.0.');

function sequence (results) {
  const calls = [];
  return { calls, run: args => { calls.push(args[0]); assert.ok(results.length); return results.shift(); } };
}

test('only a missing version permits a new publication', () => {
  assert.equal(isPublished(specifier, () => missing), false);
  assert.equal(isPublished(specifier, () => available), true);
  assert.throws(() => isPublished(specifier, () => failure('E401', 'Unauthorized')), /Cannot check/);
  assert.throws(() => isPublished(specifier, () => ok('2.0.0')), /Unexpected registry version/);
});

test('waits for accepted versions to appear before publishing dependencies', async () => {
  const executor = sequence([ok({}), missing, missing, available]);
  const delays = [];
  await publishPackage(specifier, 'package.tgz', { run: executor.run, wait: async ms => { delays.push(ms); } });
  assert.deepEqual(executor.calls, ['publish', 'view', 'view', 'view']);
  assert.deepEqual(delays, [10_000, 10_000]);
});

test('recovers a duplicate version only after the exact version is readable', async () => {
  const executor = sequence([duplicate, missing, available]);
  await publishPackage(specifier, 'package.tgz', { run: executor.run, wait: async () => {} });
  assert.deepEqual(executor.calls, ['publish', 'view', 'view']);
});

test('does not hide authentication or unrelated forbidden publication errors', async () => {
  for (const error of [failure('E403', 'Permission denied'), failure('E401', 'Unauthorized')]) {
    const executor = sequence([error]);
    await assert.rejects(publishPackage(specifier, 'package.tgz', { run: executor.run }), /npm publish failed/);
    assert.deepEqual(executor.calls, ['publish']);
  }
});

test('fails with a retryable explanation when propagation exceeds its bounded wait', async () => {
  const executor = sequence([duplicate, missing, missing]);
  let waits = 0;
  await assert.rejects(publishPackage(specifier, 'package.tgz', {
    run: executor.run, attempts: 2, wait: async () => { waits++; },
  }), /not readable yet/);
  assert.equal(waits, 1);
});

test('registry and process errors fail without publishing again', async () => {
  const executor = sequence([ok({}), failure('E403', 'Access denied')]);
  await assert.rejects(publishPackage(specifier, 'package.tgz', { run: executor.run }), /Cannot check/);
  assert.deepEqual(executor.calls, ['publish', 'view']);
  const error = new Error('npm process unavailable');
  await assert.rejects(publishPackage(specifier, 'package.tgz', { run: () => ({ error }) }), error);
});
