import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseNotes } from '../release-notes.mjs';

test('release notes contain only the requested version, including nested sections', () => {
  const log = '# Package\n\n## 2.0.0\n\n### Major Changes\n\n- New API\n\n## 1.0.0\n\n- Initial API\n';
  assert.equal(releaseNotes(log, '2.0.0'), '### Major Changes\n\n- New API');
  assert.equal(releaseNotes(log, '1.0.0'), '- Initial API');
});

test('missing or empty changelogs fail before creating a release', () => {
  assert.throws(() => releaseNotes('# Package', '1.0.0'), /Missing changelog/);
  assert.throws(() => releaseNotes('## 1.0.0\n\n## 0.1.0\nOld', '1.0.0'), /Empty changelog/);
});
