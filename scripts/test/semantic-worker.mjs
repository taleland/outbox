import { writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import semanticRelease from 'semantic-release';
import { releaseConfig } from '../release-config.mjs';

const [repositoryUrl, output] = process.argv.slice(2);
const config = releaseConfig(pathToFileURL(join(process.cwd(), 'release.config.js')));
const result = await semanticRelease({
  ...config,
  repositoryUrl,
  dryRun: true,
  ci: false,
  plugins: [fileURLToPath(new URL('../release-commits.mjs', import.meta.url))],
  generateNotes: async () => 'Fixture release notes',
});
writeFileSync(output, JSON.stringify(result ? result.nextRelease.version : false));
