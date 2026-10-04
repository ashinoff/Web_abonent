import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

test('offline app shell contains every browser module', async () => {
  const root = new URL('../public/', import.meta.url);
  const shell = await readFile(new URL('service-worker.js', root), 'utf8');
  const scripts = (await readdir(root)).filter(name => name.endsWith('.js') && name !== 'service-worker.js');
  for (const script of scripts) assert.ok(shell.includes(`'./${script}'`), `${script} is missing from offline shell`);
});
