import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('offline app shell contains every browser module', async () => {
  const root = new URL('../public/', import.meta.url);
  const shell = await readFile(new URL('service-worker.js', root), 'utf8');
  const scripts = (await readdir(root)).filter(name => name.endsWith('.js') && name !== 'service-worker.js');
  for (const script of scripts) assert.ok(shell.includes(`'./${script}'`), `${script} is missing from offline shell`);
});

test('navigation and versioned scripts use the same active shell even when the server has a newer HTML', async () => {
  const script = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  const version = /const version = '([^']+)'/.exec(script)[1];
  const origin = 'https://app.example.test/', handlers = new Map(), calls = [];
  const entries = new Map([[origin+'index.html', '<html>active shell</html>'],[origin+'app.js','active script'],[origin+'styles.css','active style'],[origin+'worker.js','active worker'],[origin+'prepared-cache.js','active cache module']]);
  const key = (request, options) => { const url = new URL(request.url || request, origin); if (options?.ignoreSearch) url.search = ''; return url.href; };
  const activeCache = { match:async (request, options) => { const body = entries.get(key(request, options)); return body && new Response(body); } };
  runInNewContext(script, {
    self:{ location:{ origin:new URL(origin).origin, href:origin+'service-worker.js' }, addEventListener:(name, handler) => handlers.set(name, handler) }, URL, Request,
    caches:{ open:async name => { assert.equal(name, version); return activeCache; }, match:async () => new Response('old script from another shell') },
    fetch:async request => { calls.push(request); return new Response('<html>new server HTML with different controls</html>'); },
  });
  async function read(path, mode = 'same-origin') {
    let result;
    handlers.get('fetch')({ request:{ method:'GET',url:origin+path,mode }, respondWith:promise => { result = promise; } });
    return (await result).text();
  }
  assert.equal(await read('?selection=saved','navigate'), '<html>active shell</html>');
  for (const [file, body] of [['app.js','active script'],['styles.css','active style'],['worker.js','active worker'],['prepared-cache.js','active cache module']])
    assert.equal(await read(file+'?v=9'), body);
  assert.equal(calls.length, 0);
});

test('upgrading an older worker bypasses cached entry scripts and installs every shell file fresh', async () => {
  const root = new URL('../public/', import.meta.url);
  const [html, app, worker, script] = await Promise.all(['index.html','app.js','worker.js','service-worker.js'].map(file => readFile(new URL(file, root), 'utf8')));
  const entry = /src="([^\"]*app\.js[^\"]*)"/.exec(html)[1];
  const css = /href="([^\"]*styles\.css[^\"]*)"/.exec(html)[1];
  const workbook = /new URL\('([^']*worker\.js[^']*)'/.exec(app)[1];
  const cacheModule = /import\('([^']*prepared-cache\.js[^']*)'/.exec(worker)[1];
  // An older active worker has only the bare asset keys; misses fetch the new code.
  const oldAssets = new Set(['./app.js','./styles.css','./worker.js','./prepared-cache.js']);
  for (const url of [entry, css, workbook, cacheModule]) assert.equal(oldAssets.has(url), false, url+' would load stale code');
  const handlers = new Map(); let requests, installed = false;
  runInNewContext(script, { self:{ location:{ href:'https://app.example.test/service-worker.js' }, addEventListener:(name, handler) => handlers.set(name, handler), skipWaiting:() => { installed = true; } }, URL, Request,
    caches:{ open:async () => ({ addAll:async items => { requests = items; } }) } });
  let pending; handlers.get('install')({ waitUntil:promise => { pending = promise; } }); await pending;
  assert.ok(installed); assert.ok(requests.length > 20);
  assert.ok(requests.every(request => request.cache === 'reload'));
});
