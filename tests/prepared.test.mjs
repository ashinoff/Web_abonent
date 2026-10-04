import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import XLSX from '@e965/xlsx';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { unpackRegistry, unpackMonthly } from '../public/prepared-data.js';
import { buildIndex, search, listNotes, analysisRecords } from '../public/core.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { indexMonthly } from '../public/monthly.js';
import { createPreparedService } from '../prepared-service.mjs';
import { createPreparedStore } from '../prepared-store.mjs';
import { createServer } from '../server.mjs';

const excel = rows => {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Лист1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
};
const registry = () => excel([
  ['Номер счетчика','ЛС','Наименование договора','ТУ','ТП','Адрес','Примечание'],
  ['001','0001','ООО Тест','Объект 1','ТП-1','Сочи, улица Тестовая, 1','Проверить ввод'],
  ['002','0001','ООО Тест','Объект 1','ТП-1','Сочи, улица Тестовая, 1','Проверить ввод'],
]);
const monthly = () => excel([
  ['Полезный отпуск по всем точкам учета за Январь 2022 г. - Февраль 2022 г.'],
  ['ЛС/Номер договора','ТУ','ТП','Январь 2022','Февраль 2022'],
  ['0001','Объект 1','ТП-1',10,20],
  ['0001','Объект 1','ТП-1',10,30],
]);

test('server packages preserve all registry cells, notifications and additive monthly analysis', () => {
  const rawRegistry = registry(), rawMonthly = monthly();
  const packedRegistry = prepareWorkbook(rawRegistry, 'registry', 'Расширенный список.xlsx');
  const sheets = unpackRegistry(JSON.parse(gunzipSync(gzipSync(JSON.stringify(packedRegistry)))));
  const index = buildIndex(sheets);
  assert.equal(index.records.length, 2);
  assert.equal(search(index, { query: '00', partial: true }).total, 2);
  assert.equal(listNotes(index).total, 2);
  assert.equal(index.records[0].values[6], 'Проверить ввод');
  const pack = prepareWorkbook(rawMonthly, 'consumption');
  const model = indexMonthly(unpackMonthly(JSON.parse(gunzipSync(gzipSync(JSON.stringify(pack))))));
  const analysis = createAnalysisService(model, analysisRecords(index.records));
  assert.deepEqual(analysis.consumer('0001', {}, null, { pointName: 'Объект 1' }).result.meter.values, [20, 50]);
  assert.deepEqual(analysis.contour('ТП-1', {}).values, [20, 50]);
  assert.ok(Buffer.byteLength(JSON.stringify(packedRegistry)) < rawRegistry.length * 4);
});

test('five clients prepare one file once, version check reuses DB and failed update serves last good package', async t => {
  const workbook = monthly(), records = new Map();
  let version = '2026-10-01', downloads = 0, parses = 0;
  const store = {
    get: async (root,path,role) => records.get(`${root}:${path}:${role}`),
    put: async (root,path,role,revision,data) => { parses++; records.set(`${root}:${path}:${role}`,{revision,data}); },
  };
  const savedFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async address => {
    if (!String(address).startsWith('https://downloader.disk.yandex.ru/')) return savedFetch(address);
    downloads++; return new Response(workbook, { headers: { 'content-length': String(workbook.length) } });
  });
  const service = createPreparedService({ source: 'https://disk.yandex.ru/d/Test', store,
    yandex: async url => Response.json(url.pathname.endsWith('/download') ? { href: 'https://downloader.disk.yandex.ru/file' } :
      { type:'file',name:'ПО.xlsx',size:workbook.length,modified:version }) });
  const first = await Promise.all(Array.from({ length: 5 }, () => service.load('/РЭС/ПО.xlsx', 'consumption')));
  assert.ok(first.every(x => x.revision === first[0].revision)); assert.equal(downloads,1); assert.equal(parses,1);
  await service.load('/РЭС/ПО.xlsx', 'consumption'); assert.equal(downloads,1);
  version = '2026-10-02';
  const second = await service.load('/РЭС/ПО.xlsx', 'consumption');
  assert.notEqual(second.revision, first[0].revision); assert.equal(downloads,2); assert.equal(parses,2);
  version = '2026-10-03';
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async address => { if (String(address).startsWith('https://downloader.disk.yandex.ru/')) throw new Error('offline'); return savedFetch(address); });
  const stale = await service.load('/РЭС/ПО.xlsx', 'consumption');
  assert.equal(stale.stale,true); assert.equal(stale.revision,second.revision);
});

test('prepared HTTP endpoint serves gzip package, rejects traversal and deduplicates simultaneous requests', async t => {
  const prev = process.env.YANDEX_PUBLIC_URL;
  process.env.YANDEX_PUBLIC_URL = 'https://disk.yandex.ru/d/PreparedTest';
  const workbook = registry(), entries = new Map(), realFetch = globalThis.fetch;
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloud-api.yandex.net') return Response.json(url.pathname.endsWith('/download')
      ? { href: 'https://downloader.disk.yandex.ru/registry' }
      : { type: 'file', name: 'Расширенный список.xlsx', size: workbook.length, modified: '2026-10-04' });
    if (url.hostname === 'downloader.disk.yandex.ru') { downloads++; return new Response(workbook, { headers: { 'content-length': String(workbook.length) } }); }
    return realFetch(input, options);
  });
  const preparedStore = {
    get: async (source,path,role) => entries.get(JSON.stringify([source,path,role])),
    put: async (source,path,role,revision,data) => entries.set(JSON.stringify([source,path,role]),{revision,data}),
  };
  const server = createServer({ preparedStore });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await realFetch(base+'/api/config')).json(); assert.equal(config.prepared,true);
    assert.equal((await realFetch(base+'/api/prepared?path=%2F..%2Fsecret.xlsx&role=registry')).status,400);
    const url=base+'/api/prepared?path='+encodeURIComponent('/РЭС/Расширенный список.xlsx')+'&role=registry';
    const responses = await Promise.all(Array.from({length:5}, () => realFetch(url)));
    assert.ok(responses.every(x => x.ok));
    const packs = await Promise.all(responses.map(r => r.json()));
    assert.ok(packs.every(p => p.sheets[0].rows.length === 2));
    assert.equal(downloads,1);
    const unchanged = await realFetch(url); assert.equal(unchanged.headers.get('x-prepared-stale'),'0');
    const revision = unchanged.headers.get('etag');
    const repeated = await realFetch(url, { headers: { 'If-None-Match': revision } });
    assert.equal(repeated.status,304); assert.equal(await repeated.text(),'');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (prev === undefined) delete process.env.YANDEX_PUBLIC_URL; else process.env.YANDEX_PUBLIC_URL=prev;
  }
});

test('database config requires every DB_* variable and a valid port', async () => {
  assert.equal(createPreparedStore({}), null);
  const incomplete = createPreparedStore({ DB_HOST: 'localhost' });
  await assert.rejects(incomplete.ready(), /DB_PORT.*DB_NAME.*DB_USER.*DB_PASSWORD/);
  const invalid = createPreparedStore({ DB_HOST:'localhost', DB_PORT:'nope', DB_NAME:'local', DB_USER:'local', DB_PASSWORD:'test' });
  await assert.rejects(invalid.ready(), /DB_PORT/);
});
