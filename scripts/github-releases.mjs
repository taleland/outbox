import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from './release-notes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error('GITHUB_REPOSITORY is required');
const temporary = mkdtempSync(join(tmpdir(), 'outbox-release-notes-'));
try {
  for (const directory of ['core', 'mikro-orm', 'nestjs', 'nodets-bus']) {
    const path = join(root, 'packages', directory);
    const { name, version } = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (version === '0.0.0') throw new Error('Prepare a version PR before releasing');
    const tag = `${name}@${version}`;
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: root, stdio: 'pipe' });
    const existing = spawnSync('gh', ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], { encoding: 'utf8' });
    if (existing.error) throw existing.error;
    if (existing.status === 0) { console.log(`Release exists: ${tag}`); continue; }
    if (!existing.stderr.includes('HTTP 404')) throw new Error(existing.stderr || 'GitHub release lookup failed');
    const notes = join(temporary, `${directory}.md`);
    writeFileSync(notes, releaseNotes(readFileSync(join(path, 'CHANGELOG.md'), 'utf8'), version));
    execFileSync('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', tag, '--notes-file', notes], { stdio: 'inherit' });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
