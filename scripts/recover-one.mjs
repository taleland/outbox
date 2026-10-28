import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as npm from '@semantic-release/npm';
import * as github from '@semantic-release/github';
import { isPublished } from './npm-publication.mjs';
import { waitForVersion } from './registry-ready.mjs';
import { recoveryNotes } from './recovery-notes.mjs';

if (process.env.NPM_PUBLISH_ENABLED !== 'true') throw new Error('Publishing is disabled');
const [tag] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (tag !== `${manifest.name}@${manifest.version}`) throw new Error('Tag does not match the checked-out package version');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const taggedHead = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
if (head !== taggedHead) throw new Error('Recovery requires the exact tagged commit');
const notes = recoveryNotes(readFileSync('CHANGELOG.md', 'utf8'), manifest.version);
const context = {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  logger: console,
  options: { repositoryUrl: manifest.repository.url },
  branch: { name: 'main', type: 'release', main: true },
  nextRelease: { version: manifest.version, gitTag: tag, gitHead: head, name: tag, notes },
};
if (!isPublished(tag)) {
  await npm.verifyConditions({}, context);
  await npm.prepare({}, context);
  try {
    await npm.publish({}, context);
  } catch (error) {
    // An accepted version may still be unavailable during npm's registry propagation.
    if (!/cannot publish over the previously published versions/i.test(error.stderr ?? '')) throw error;
  }
  await waitForVersion(tag);
}
const repository = new URL(manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')).pathname.slice(1);
if (repository !== process.env.GITHUB_REPOSITORY) throw new Error('Recovery repository does not match GITHUB_REPOSITORY');
const existing = spawnSync('gh', ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], { encoding: 'utf8' });
if (existing.error) throw existing.error;
if (existing.status !== 0) {
  if (!existing.stderr.includes('HTTP 404')) throw new Error(existing.stderr);
  await github.publish({ releaseNameTemplate: '<%= nextRelease.gitTag %>' }, context);
}
// Verify npm versioning did not modify the source snapshot used for recovery.
execFileSync('git', ['diff', '--exit-code', '--', join(process.cwd(), 'package.json')], { stdio: 'inherit' });
