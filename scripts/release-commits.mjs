import { execFileSync, spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { analyzeCommits as analyze } from '@semantic-release/commit-analyzer';
import { generateNotes as notes } from '@semantic-release/release-notes-generator';

const publishedFields = ['name', 'type', 'main', 'types', 'exports', 'files', 'engines', 'bin',
  'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies', 'publishConfig'];

function manifestAt (cwd, ref, path) {
  const result = spawnSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const manifest = JSON.parse(result.stdout);
  return Object.fromEntries(publishedFields.map(field => [field, manifest[field]]));
}

export function relevantCommits ({ cwd, commits }) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const prefix = relative(root, cwd).split('\\').join('/') + '/';
  return commits.filter(commit => {
    const files = commit.files ?? execFileSync('git', [
      'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit.hash,
    ], { cwd, encoding: 'utf8' }).trim().split('\n');
    if (files.some(file => file.startsWith(`${prefix}src/`) || file === `${prefix}tsconfig.json`)) return true;
    const path = `${prefix}package.json`;
    return files.includes(path) && JSON.stringify(manifestAt(cwd, `${commit.hash}^`, path)) !== JSON.stringify(manifestAt(cwd, commit.hash, path));
  });
}

export async function analyzeCommits (_, context) {
  return analyze({
    preset: 'conventionalcommits',
    releaseRules: [
      { type: 'chore', scope: 'deps', release: 'patch' },
      { type: 'build', scope: 'deps', release: 'patch' },
    ],
  }, { ...context, commits: relevantCommits(context) });
}

export async function generateNotes (_, context) {
  // The monorepo extension decorates version for display; keep the real SemVer in changelogs.
  const version = context.nextRelease.gitTag.slice(context.nextRelease.gitTag.lastIndexOf('@') + 1);
  return notes({ preset: 'conventionalcommits' }, {
    ...context, commits: relevantCommits(context), nextRelease: { ...context.nextRelease, version },
  });
}
