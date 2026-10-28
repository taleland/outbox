import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('real semantic-release independently analyzes each package since its own tag', { timeout: 120000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'independent-releases-'));
  const cwd = join(temporary, 'source');
  const remote = join(temporary, 'remote.git');
  mkdirSync(cwd);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, content) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), content); };
  const commit = (message, files) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    git(['add', 'packages']); git(['commit', '-m', message]); git(['push', 'origin', 'main', '--tags']);
  };
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Release tests']); git(['config', 'user.email', 'release-tests@example.test']);
    git(['config', 'commit.gpgsign', 'false']);
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
    git(['remote', 'add', 'origin', remote]);
    symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    write('package.json', JSON.stringify({ private: true, type: 'module' }));
    for (const directory of ['core', 'nestjs', 'mikro-orm']) {
      write(`packages/${directory}/package.json`, JSON.stringify({ name: `@fixture/${directory}`, version: '1.0.0', type: 'module' }));
      write(`packages/${directory}/src/index.js`, 'export const value = 1;');
    }
    git(['add', 'package.json', 'packages']); git(['commit', '-m', 'feat: initial packages']);
    for (const directory of ['core', 'nestjs', 'mikro-orm']) git(['tag', `@fixture/${directory}@1.0.0`]);
    git(['push', 'origin', 'main', '--tags']);
    const worker = join(root, 'test/fixtures/semantic-release.mjs');
    const plan = directory => {
      const output = join(temporary, `${directory}.json`);
      execFileSync(process.execPath, [worker, remote, output], {
        cwd: join(cwd, 'packages', directory),
        stdio: 'pipe',
        env: { ...process.env, GITHUB_ACTIONS: '', CI: '', GITHUB_REF: '', GITHUB_EVENT_NAME: '' },
      });
      return JSON.parse(readFileSync(output, 'utf8'));
    };
    commit('feat(core): add a capability', { 'packages/core/src/index.js': 'export const value = 2;' });
    assert.equal(plan('core'), '1.1.0');
    assert.equal(plan('nestjs'), false);
    commit('fix(core): repair Nest integration', { 'packages/nestjs/src/index.js': 'export const value = 2;' });
    assert.equal(plan('nestjs'), '1.0.1', 'changed paths take precedence over the commit scope');
    commit('feat!: improve test coverage', { 'packages/mikro-orm/test/test.js': '// tests only' });
    assert.equal(plan('mikro-orm'), false, 'test-only breaking titles must not publish');
    commit('fix: update package metadata', {
      'packages/mikro-orm/package.json': JSON.stringify({ name: '@fixture/mikro-orm', version: '1.0.8', type: 'module', devDependencies: { example: '1.0.0' } }),
    });
    assert.equal(plan('mikro-orm'), false, 'version and dev-only changes must not publish');
    commit('chore(deps): update a runtime dependency', {
      'packages/mikro-orm/package.json': JSON.stringify({ name: '@fixture/mikro-orm', version: '1.0.8', type: 'module', dependencies: { example: '^2.0.0' } }),
    });
    assert.equal(plan('mikro-orm'), '1.0.1');
    git(['tag', '@fixture/core@1.1.0']); git(['push', 'origin', '--tags']);
    assert.equal(plan('core'), false, 'each package must start from its own latest tag');
    commit('fix: update two implementations', {
      'packages/core/src/index.js': 'export const value = 3;', 'packages/nestjs/src/index.js': 'export const value = 3;',
    });
    assert.equal(plan('core'), '1.1.1');
    assert.equal(plan('nestjs'), '1.0.1');
    commit('feat(core)!: replace the API', { 'packages/core/src/index.js': 'export const replacement = 1;' });
    assert.equal(plan('core'), '2.0.0');
    assert.equal(plan('nestjs'), '1.0.1', 'a core major must not cascade into Nest');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
