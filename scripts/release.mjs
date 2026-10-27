import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NPM_PUBLISH_ENABLED !== 'true') {
  throw new Error('Publishing is disabled. Complete the release setup before enabling NPM_PUBLISH_ENABLED.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const packages = ['core', 'mikro-orm', 'nestjs'].map(directory => ({
  directory: join(root, 'packages', directory),
  manifest: JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8')),
}));
if (packages.some(({ manifest }) => manifest.version === '0.0.0')) {
  throw new Error('Initial packages are not versioned. Prepare and review a version PR first.');
}
if (readdirSync(join(root, '.changeset')).some(name => name.endsWith('.md') && name !== 'README.md')) {
  throw new Error('Unconsumed changesets remain. Run pnpm version-packages and commit the result first.');
}
const temporary = mkdtempSync(join(tmpdir(), 'outbox-release-'));
try {
  for (const { directory, manifest } of packages) {
    const specifier = `${manifest.name}@${manifest.version}`;
    const existing = spawnSync('npm', ['view', specifier, 'version', '--json', '--registry=https://registry.npmjs.org'], {
      encoding: 'utf8', cwd: root,
    });
    if (existing.error) throw existing.error;
    if (existing.status === 0) {
      console.log(`Already published: ${specifier}`);
      continue;
    }
    // Only a missing version permits publishing; authentication/network errors must fail.
    const error = JSON.parse(existing.stdout).error;
    if (error?.code !== 'E404') throw new Error(existing.stderr || `Cannot check ${specifier}`);
    const output = join(temporary, manifest.name.replace('/', '-'));
    mkdirSync(output);
    execFileSync('pnpm', ['pack', '--pack-destination', output], { cwd: directory, stdio: 'inherit' });
    const archive = readdirSync(output).find(name => name.endsWith('.tgz'));
    if (!archive) throw new Error(`No tarball for ${specifier}`);
    // npm CLI handles OIDC; pnpm has already resolved workspace: dependencies in the tarball.
    execFileSync('npm', ['publish', join(output, archive), '--access', 'public', '--registry=https://registry.npmjs.org'], {
      cwd: root, stdio: 'inherit',
    });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
