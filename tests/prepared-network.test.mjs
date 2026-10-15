import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import XLSX from '@e965/xlsx';
import { createServer } from '../server.mjs';
import { fetchPrepared, listOfflineCopies } from '../public/prepared-cache.js';

const root = 'https://disk.yandex.ru/d/PreparedNetworkQA';
const path = '/Учебное предприятие/Учебный РЭС/Расширенный список.xlsx';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('automatic Yandex preparation survives a disconnected client with one download and one database write', async t => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Номер счетчика', 'ЛС', 'Наименование договора', 'Примечание'],
    ['000001', '00000001', 'Учебный потребитель', 'Сохранить полное значение'],
  ]), 'Реестр');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  let entry, downloads = 0, writes = 0, requests = 0;
  const entered = deferred(), resume = deferred();
  const store = {
    getMeta: async () => entry && { revision: entry.revision, updated_at: entry.updated_at },
    get: async () => entry,
    getRevision: async () => entry?.revision,
    put: async (_source, _path, _role, revision, data) => { writes++; entry = { revision, data, updated_at: new Date() }; },
  };
  const server = createServer({ env: { YANDEX_PUBLIC_URL: root }, preparedStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { resume.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = new URL(`http://127.0.0.1:${server.address().port}/`), originalFetch = globalThis.fetch;
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'), oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: base });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.indexedDB = new IDBFactory();
  t.after(() => {
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  });
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'cloud-api.yandex.net') return Response.json(url.pathname.endsWith('/download')
      ? { href: 'https://downloader.disk.yandex.ru/registry-network-qa' }
      : { type: 'file', name: 'Расширенный список.xlsx', size: bytes.length, md5: 'synthetic-source', modified: '2026-01-01' });
    if (url.hostname === 'downloader.disk.yandex.ru') {
      downloads++; entered.resolve(); await resume.promise;
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    if (url.origin === base.origin && url.pathname === '/api/prepared') {
      requests++;
      if (requests === 1) {
        const disconnected = new AbortController();
        const first = originalFetch(input, { ...options, signal: AbortSignal.any([options.signal, disconnected.signal]) });
        first.catch(() => {});
        await entered.promise; disconnected.abort(); await first.catch(() => {});
        throw new TypeError('Failed to fetch');
      }
      resume.resolve();
    }
    return originalFetch(input, options);
  });
  const config = await (await originalFetch(new URL('/api/config', base))).json();
  assert.equal(config.preparation.registryReader, 'streaming-xlsx');
  assert.equal(config.preparation.timeoutSeconds, 240); assert.equal(config.preparation.build, '2026-10-16-v23');
  const result = await fetchPrepared({ source: root, path, role: 'registry' });
  assert.equal(requests, 2); assert.equal(downloads, 1); assert.equal(writes, 1);
  assert.equal(result.data.sheets[0].rows[0][1][0], '000001');
  assert.equal(result.data.sheets[0].rows[0][1][1], '00000001');
  assert.equal(result.data.sheets[0].rows[0][1][3], 'Сохранить полное значение');
  assert.equal((await listOfflineCopies(root))[0].files[0].revision, result.revision);
});

test('preparation timeouts have a distinct server response and do not masquerade as workbook or memory errors', async t => {
  const server = createServer({ env: { YANDEX_PUBLIC_URL: root }, preparedStore: {
    getMeta: async () => { throw new Error('Подготовка Excel превысила 240 секунд.'); },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/api/prepared`);
  url.searchParams.set('path', path); url.searchParams.set('role', 'registry');
  const response = await fetch(url), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, 'preparation_timeout');
  assert.match(body.error, /Яндекс Диска/);
});
