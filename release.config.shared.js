import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseConfig (configUrl) {
  const directory = dirname(fileURLToPath(configUrl));
  const { name } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  return {
    branches: ['main'],
    extends: ['semantic-release-monorepo'],
    tagFormat: `${name}@\${version}`,
    plugins: [
      fileURLToPath(new URL('./scripts/release-commits.mjs', import.meta.url)),
      ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md', changelogTitle: `# ${name}` }],
      '@semantic-release/npm',
      ['@semantic-release/git', {
        assets: ['package.json', 'CHANGELOG.md'],
        message: `chore(release): ${name}@\${nextRelease.version} [skip ci]\n\n\${nextRelease.notes}`,
      }],
      ['@semantic-release/github', {
        successComment: false,
        failComment: false,
        releasedLabels: false,
        releaseNameTemplate: '<%= nextRelease.gitTag %>',
      }],
    ],
  };
}
