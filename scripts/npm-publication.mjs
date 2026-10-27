import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const registry = '--registry=https://registry.npmjs.org';
const command = args => spawnSync('npm', args, { encoding: 'utf8' });

export function isPublished (specifier, run = command) {
  const result = run(['view', specifier, 'version', '--json', registry]);
  if (result.error) throw result.error;
  const response = JSON.parse(result.stdout);
  if (result.status === 0) {
    const versions = Array.isArray(response) ? response : [response];
    if (versions.length !== 1 || versions[0] !== specifier.slice(specifier.lastIndexOf('@') + 1)) {
      throw new Error(`Unexpected registry version for ${specifier}: ${result.stdout}`);
    }
    return true;
  }
  if (response.error?.code === 'E404') return false;
  throw new Error(result.stderr || `Cannot check ${specifier}`);
}

export async function publishPackage (specifier, archive, {
  run = command, wait = setTimeout, attempts = 120, delayMs = 10_000,
} = {}) {
  const result = run(['publish', archive, '--access', 'public', '--json', registry]);
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    const error = JSON.parse(result.stdout).error;
    // A newly accepted version can still return 404 from npm view during propagation.
    // Only this explicit duplicate-version response permits recovery; other 403s fail.
    if (error?.code !== 'E403' || !/cannot publish over the previously published versions/i.test(`${error.summary} ${error.detail}`)) {
      throw new Error(`npm publish failed for ${specifier}: ${result.stderr || result.stdout}`);
    }
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isPublished(specifier, run)) {
      console.log(`Available on npm: ${specifier}`);
      return;
    }
    if (attempt + 1 < attempts) {
      console.log(`Waiting for npm to make ${specifier} available (${attempt + 1}/${attempts})`);
      await wait(delayMs);
    }
  }
  throw new Error(`npm accepted ${specifier}, but it is not readable yet. Retry the release after registry propagation.`);
}
