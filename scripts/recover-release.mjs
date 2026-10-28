import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NPM_PUBLISH_ENABLED !== 'true') throw new Error('Publishing is disabled');
const root = fileURLToPath(new URL('../', import.meta.url));
const [tag, ...extra] = process.argv.slice(2);
if (!tag || extra.length) throw new Error('Usage: pnpm release:recover <package-tag>');
const directories = ['core', 'mikro-orm', 'nestjs', 'nodets-bus'];
const directory = directories.find(directory => {
  const { name } = JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'));
  return tag.startsWith(`${name}@`) && /^\d+\.\d+\.\d+$/.test(tag.slice(name.length + 1));
});
if (!directory) throw new Error('Recovery requires an exact stable tag of a workspace package');
execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: root, stdio: 'pipe' });
const temporary = mkdtempSync(join(tmpdir(), 'semantic-release-recovery-'));
try {
  // Rebuild the tagged snapshot, never substitute newer source for an existing release.
  execFileSync('git', ['clone', '--no-hardlinks', '--no-checkout', root, temporary], { stdio: 'pipe' });
  execFileSync('git', ['checkout', '--detach', tag], { cwd: temporary, stdio: 'pipe' });
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: temporary, stdio: 'inherit' });
  execFileSync('pnpm', ['build'], { cwd: temporary, stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'scripts/recover-one.mjs'), tag], {
    cwd: join(temporary, 'packages', directory), stdio: 'inherit',
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
