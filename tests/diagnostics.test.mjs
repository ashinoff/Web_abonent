import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { diagnosticsHTML } from '../public/diagnostics-ui.js';

const context = { selectedRes:'Туапсинский РЭС', selectedFile:null, registryState:'missing', filesState:'ready', offline:false };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('diagnostics distinguishes missing source from database authentication without leaking secrets', async () => {
  const original = process.env.YANDEX_PUBLIC_URL;
  delete process.env.YANDEX_PUBLIC_URL;
  const server = createServer({ preparedStore: {
    ready: async () => { throw Object.assign(new Error('password=SECRET host=internal.example'), { code:'28P01' }); },
    close: async () => {},
  } });
  await listen(server);
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const unavailable = await fetch(root+'/api/resources?path=/');
    assert.equal(unavailable.status,503);
    assert.equal((await unavailable.json()).code,'source_not_configured');
    const result = await fetch(root+'/api/diagnostics');
    assert.equal(result.status,200);
    const data = await result.json();
    assert.deepEqual(data.source,{state:'error',issue:'not_configured'});
    assert.deepEqual(data.database,{state:'error',issue:'authentication'});
    assert.doesNotMatch(JSON.stringify(data),/SECRET|internal\.example/);
    const html = diagnosticsHTML(data,context,'registry');
    assert.match(html,/YANDEX_PUBLIC_URL/);
    assert.match(html,/DB_USER и DB_PASSWORD/);
    assert.match(html,/Туапсинский РЭС/);
    assert.doesNotMatch(html,/SECRET/);
  } finally {
    await close(server);
    if (original === undefined) delete process.env.YANDEX_PUBLIC_URL;
    else process.env.YANDEX_PUBLIC_URL = original;
  }
});

test('diagnostics reports a connected but unfilled catalog separately', async () => {
  const original = process.env.YANDEX_PUBLIC_URL;
  process.env.YANDEX_PUBLIC_URL='https://disk.yandex.ru/d/DiagnosticsTest';
  const server = createServer({ preparedStore: {
    ready: async () => {}, listFolders: async () => [], close: async () => {},
  } });
  await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/diagnostics`);
    const data = await response.json();
    assert.equal(data.database.state,'connected');
    assert.equal(data.catalog.state,'empty');
    assert.match(diagnosticsHTML(data,context,'base'),/Карта базы пока пуста/);
  } finally {
    await close(server);
    if (original === undefined) delete process.env.YANDEX_PUBLIC_URL;
    else process.env.YANDEX_PUBLIC_URL = original;
  }
});

test('diagnostics reports the memory budget and never raises the detected container limit', async () => {
  const original = process.env.PREPARE_MEMORY_MB;
  process.env.PREPARE_MEMORY_MB = '2048';
  const server = createServer();
  await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/diagnostics`);
    assert.equal(response.status, 200);
    const { memory } = await response.json();
    assert.equal(memory.configuredMB, 2048);
    assert.equal(memory.containerMB, Math.min(memory.detectedMB || 2048, 2048));
    assert.equal(memory.source, memory.detectedMB ? 'cgroup' : 'env');
    assert.ok(memory.heapMB > 0 && memory.childMB > 0);
    assert.ok(memory.combinedMB < memory.containerMB);
    assert.ok(memory.packageMB > 0);
  } finally {
    await close(server);
    if (original === undefined) delete process.env.PREPARE_MEMORY_MB;
    else process.env.PREPARE_MEMORY_MB = original;
  }
});
