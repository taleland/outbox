import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isPublished } from './npm-publication.mjs';

export async function waitForVersion (specifier, { check = isPublished, wait = setTimeout, attempts = 120 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check(specifier)) return;
    if (attempt + 1 < attempts) await wait(10000);
  }
  throw new Error(`Registry propagation timed out for ${specifier}. Recover this tagged release before creating another version.`);
}

export async function publish (_, context) {
  const { name } = JSON.parse(readFileSync(join(context.cwd, 'package.json'), 'utf8'));
  await waitForVersion(`${name}@${context.nextRelease.version}`);
}
