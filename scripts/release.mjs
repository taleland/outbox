import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && process.env.NPM_PUBLISH_ENABLED !== 'true') throw new Error('Publishing is disabled');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Only --dry-run is supported');
for (const directory of ['core', 'mikro-orm', 'nestjs', 'nodets-bus']) {
  const cwd = join(root, 'packages', directory);
  const { name } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (!dryRun) {
    const tag = execFileSync('git', ['tag', '--merged', 'HEAD', '--sort=-version:refname', '--list', `${name}@*`], { cwd, encoding: 'utf8' }).trim().split('\n')[0];
    if (tag) {
      const result = spawnSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`], { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        if (!result.stderr.includes('HTTP 404')) throw new Error(result.stderr);
        throw new Error(`Incomplete release ${tag}. Run the publish workflow with recover_tag=${tag} before releasing new versions.`);
      }
    }
  }
  execFileSync('pnpm', ['exec', 'semantic-release', ...(dryRun ? ['--dry-run'] : [])], { cwd, stdio: 'inherit' });
}
