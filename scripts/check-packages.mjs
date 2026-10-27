import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'outbox-pack-'));
const manifests = [];
try {
  for (const directory of ['core', 'mikro-orm', 'nestjs']) {
    const output = join(temporary, directory);
    mkdirSync(output);
    execFileSync('pnpm', ['pack', '--pack-destination', output], {
      cwd: join(root, 'packages', directory), stdio: 'pipe',
    });
    const archives = readdirSync(output).filter(name => name.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    const archive = join(output, archives[0]);
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/src/index.js', 'dist/src/index.d.ts']) {
      assert.ok(files.includes(`package/${file}`), `${directory}: missing ${file}`);
    }
    assert.ok(files.every(file => !/\/(test|node_modules)\//.test(file)), `${directory}: packed development files`);
    execFileSync('tar', ['-xzf', archive, '-C', output]);
    const manifest = JSON.parse(readFileSync(join(output, 'package/package.json'), 'utf8'));
    manifests.push(manifest);
    assert.equal(manifest.license, 'Apache-2.0');
    assert.ok(!JSON.stringify(manifest.dependencies ?? {}).includes('workspace:'));
    if (directory === 'core') {
      assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
      assert.equal(Object.keys(manifest.peerDependencies ?? {}).length, 0);
      // Import outside the workspace to detect accidental dependencies on local modules.
      const module = await import(pathToFileURL(resolve(output, 'package', manifest.main)).href);
      assert.equal(typeof module.createWithOutbox, 'function');
    }
    console.log(`Verified ${manifest.name}@${manifest.version}: ${files.length} files`);
  }
  for (const manifest of manifests.slice(1)) {
    assert.equal(manifest.dependencies['@taleland/outbox-core'], `^${manifests[0].version}`);
  }
  assert.ok(!Object.keys({ ...manifests[2].dependencies, ...manifests[2].peerDependencies }).some(name => name.startsWith('@mikro-orm/')));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
