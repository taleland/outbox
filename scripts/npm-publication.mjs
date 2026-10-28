import { spawnSync } from 'node:child_process';

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
