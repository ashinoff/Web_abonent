import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import XLSX from '@e965/xlsx';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { unpackRegistry, unpackMonthly } from '../public/prepared-data.js';
import { buildIndex, search, listNotes, analysisRecords } from '../public/core.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { indexMonthly } from '../public/monthly.js';
import { createPreparedService, preparationLimits } from '../prepared-service.mjs';
import { createPreparedStore } from '../prepared-store.mjs';
import { createServer } from '../server.mjs';

const excel = (rows, bookType = 'xlsx') => {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Лист1');
  return XLSX.write(book, { type: 'buffer', bookType });
};
const registry = bookType => excel([
  ['Номер счетчика','ЛС','Наименование договора','ТУ','ТП','Адрес','Примечание'],
  ['001','0001','ООО Тест','Объект 1','ТП-1','Сочи, улица Тестовая, 1','Проверить ввод'],
  ['002','0001','ООО Тест','Объект 1','ТП-1','Сочи, улица Тестовая, 1','Проверить ввод'],
], bookType);
const monthly = bookType => excel([
  ['Полезный отпуск по всем точкам учета за Январь 2022 г. - Февраль 2022 г.'],
  ['ЛС/Номер договора','ТУ','ТП','Январь 2022','Февраль 2022'],
  ['0001','Объект 1','ТП-1',10,20],
  ['0001','Объект 1','ТП-1',10,30],
], bookType);

for (const bookType of ['biff8', 'xlsx']) test(`${bookType}: server packages preserve all registry cells, notifications and additive monthly analysis`, () => {
  const rawRegistry = registry(bookType), rawMonthly = monthly(bookType);
  const packedRegistry = prepareWorkbook(rawRegistry, 'registry', `Расширенный список.${bookType === 'biff8' ? 'xls' : 'xlsx'}`);
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
  let downloads = 0, metadata = 0, fullReads = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloud-api.yandex.net') { metadata++; return Response.json(url.pathname.endsWith('/download')
      ? { href: 'https://downloader.disk.yandex.ru/registry' }
      : { type: 'file', name: 'Расширенный список.xlsx', size: workbook.length, modified: '2026-10-04' }); }
    if (url.hostname === 'downloader.disk.yandex.ru') { downloads++; return new Response(workbook, { headers: { 'content-length': String(workbook.length) } }); }
    return realFetch(input, options);
  });
  const preparedStore = {
    get: async (source,path,role) => { fullReads++; return entries.get(JSON.stringify([source,path,role])); },
    getRevision: async (source,path,role) => entries.get(JSON.stringify([source,path,role]))?.revision,
    put: async (source,path,role,revision,data) => entries.set(JSON.stringify([source,path,role]),{revision,data}),
  };
  const server = createServer({ preparedStore });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await realFetch(base+'/api/config')).json(); assert.equal(config.prepared,true);
    assert.equal((await realFetch(base+'/api/prepared?path=%2F..%2Fsecret.xlsx&role=registry')).status,400);
    const url=base+'/api/prepared?path='+encodeURIComponent('/РЭС/Расширенный список.xlsx')+'&role=registry';
    assert.equal((await realFetch(url,{method:'HEAD'})).status,404);
    assert.equal(downloads,0,'HEAD does not trigger workbook preparation');
    const responses = await Promise.all(Array.from({length:5}, () => realFetch(url)));
    assert.ok(responses.every(x => x.ok));
    const packs = await Promise.all(responses.map(r => r.json()));
    assert.ok(packs.every(p => p.sheets[0].rows.length === 2));
    assert.equal(downloads,1);
    const unchanged = await realFetch(url); assert.equal(unchanged.headers.get('x-prepared-stale'),'0');
    const revision = unchanged.headers.get('etag');
    assert.equal((await realFetch(url,{method:'HEAD'})).headers.get('etag'),revision);
    const before304 = fullReads;
    const repeated = await realFetch(url, { headers: { 'If-None-Match': revision } });
    assert.equal(repeated.status,304); assert.equal(await repeated.text(),'');
    assert.equal(repeated.headers.get('x-prepared-stale'),'0');
    assert.equal(fullReads,before304);
    assert.equal(metadata,2); // One file metadata lookup and one download link; cached reads use DB only.
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

test('workbook preparation respects 512 MB containers and expands with a larger plan', () => {
  assert.deepEqual(preparationLimits(512), {heapMB:128,childMB:160,combinedMB:320,packageMB:64});
  assert.deepEqual(preparationLimits(1024), {heapMB:512,childMB:672,combinedMB:832,packageMB:128});
  const larger=preparationLimits(2048);
  assert.equal(larger.heapMB,768);
  assert.ok(larger.heapMB > 128 && larger.childMB > 160 && larger.packageMB > 64);
  assert.ok(larger.combinedMB < 2048);
});

test('folder map records ready and missing sources without exposing workbooks', async t => {
  const source = 'https://disk.yandex.ru/d/PreparedMap';
  const path = '/Предприятие/РЭС/Расширенный список.xlsx', workbook = registry();
  const roots = { '/':[{ type:'dir',name:'Предприятие',path:'/Предприятие' }],
    '/Предприятие':[{ type:'dir',name:'РЭС',path:'/Предприятие/РЭС' }],
    '/Предприятие/РЭС':[{ type:'file',name:'Расширенный список.xlsx',path }] };
  const savedFetch = globalThis.fetch, entries = new Map(), folders = new Map();
  t.mock.method(globalThis, 'fetch', async (input, opts) => String(input).startsWith('https://downloader.disk.yandex.ru/')
    ? new Response(workbook, { headers:{ 'content-length':String(workbook.length) } }) : savedFetch(input, opts));
  const store = {
    get: async (src,p,role) => entries.get(JSON.stringify([src,p,role])),
    put: async (src,p,role,revision,data) => entries.set(JSON.stringify([src,p,role]),{revision,data}),
    putFolder: async (src,folder,statuses) => folders.set(folder.path,{ enterprise_path:folder.enterprisePath,
      enterprise_name:folder.enterpriseName,res_path:folder.path,res_name:folder.name,statuses,checked_at:new Date() }),
    listFolders: async () => [...folders.values()],
    pruneFolders: async (src,paths) => { for (const key of folders.keys()) if (!paths.includes(key)) folders.delete(key); },
  };
  const service = createPreparedService({ source, store, yandex: async url => {
    const p = url.searchParams.get('path');
    if (url.pathname.endsWith('/download')) return Response.json({ href:'https://downloader.disk.yandex.ru/file' });
    if (p === path) return Response.json({ type:'file',name:'Расширенный список.xlsx',size:workbook.length,modified:'2026-10-04' });
    return Response.json({ type:'dir',_embedded:{ items:roots[p] || [],total:(roots[p] || []).length } });
  } });
  await service.syncAll();
  const status = folders.get('/Предприятие/РЭС').statuses;
  assert.equal(status.registry.state,'ready');
  assert.equal(status.registry.path,path);
  assert.equal(status.consumption.state,'missing');
  assert.equal(status.incoming.state,'missing');
  assert.equal(JSON.stringify([...folders.values()]).includes('Проверить ввод'),false);
  const previous = process.env.YANDEX_PUBLIC_URL; process.env.YANDEX_PUBLIC_URL = source;
  const server = createServer({ preparedStore:store });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const response = await savedFetch(`http://127.0.0.1:${server.address().port}/api/load-map`);
    assert.equal(response.status,200);
    assert.equal((await response.json()).folders[0].statuses.registry.state,'ready');
    const base = `http://127.0.0.1:${server.address().port}/api/directory?path=`;
    assert.equal((await (await savedFetch(base+'%2F')).json())._embedded.items[0].name,'Предприятие');
    assert.equal((await (await savedFetch(base+encodeURIComponent('/Предприятие'))).json())._embedded.items[0].name,'РЭС');
    assert.equal((await (await savedFetch(base+encodeURIComponent('/Предприятие/РЭС'))).json())._embedded.items[0].path,path);
    assert.equal((await (await savedFetch(base+encodeURIComponent(path))).json()).type,'file');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.YANDEX_PUBLIC_URL; else process.env.YANDEX_PUBLIC_URL=previous;
  }
});

test('startup scans the catalog without downloading workbooks and prepares one file at a time', async t => {
  const source = 'https://disk.yandex.ru/d/CatalogTest', workbook = registry(), entries = new Map(), folders = new Map();
  const path = '/ЭС/РЭС/Расширенный список.xlsx';
  const tree = { '/': [{type:'dir',name:'ЭС',path:'/ЭС'}],
    '/ЭС': [{type:'dir',name:'РЭС',path:'/ЭС/РЭС'}],
    '/ЭС/РЭС': [{type:'file',name:'Расширенный список.xlsx',path,size:workbook.length,modified:'2026-10-04'}] };
  let downloads = 0;
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://downloader.disk.yandex.ru/')) {
      downloads++; return new Response(workbook, {headers:{'content-length':String(workbook.length)}});
    }
    return original(url, options);
  });
  const store = {
    get: async (src,p,role) => entries.get(`${p}:${role}`),
    put: async (src,p,role,revision,data) => entries.set(`${p}:${role}`,{revision,data}),
    listFolders: async () => [...folders.values()],
    putFolder: async (src,folder,statuses) => folders.set(folder.path,{res_path:folder.path,res_name:folder.name,
      enterprise_path:folder.enterprisePath,enterprise_name:folder.enterpriseName,statuses}),
    pruneFolders: async () => {},
  };
  const service = createPreparedService({source,store,yandex:async url => {
    const p=url.searchParams.get('path');
    if (url.pathname.endsWith('/download')) return Response.json({href:'https://downloader.disk.yandex.ru/workbook'});
    if (p === path) return Response.json({type:'file',name:'Расширенный список.xlsx',size:workbook.length,modified:'2026-10-04'});
    return Response.json({type:'dir',_embedded:{items:tree[p] || [],total:(tree[p] || []).length}});
  }});
  await service.syncAll({prepare:false});
  assert.equal(downloads,0);
  assert.equal(folders.get('/ЭС/РЭС').statuses.registry.state,'pending');
  assert.equal(await service.prepareNext(),true);
  assert.equal(downloads,1);
  assert.equal(folders.get('/ЭС/РЭС').statuses.registry.state,'ready');
  assert.equal(await service.prepareNext(),false);
});

test('a manually chosen snapshot refreshes before returning its old ETag', async t => {
  const workbook = monthly(), path = '/ЭС/РЭС/Мой файл.xlsx', source = 'https://disk.yandex.ru/d/ManualTest';
  const old = {revision:'old',data:{sheets:[]},updated_at:new Date(Date.now()-20*60*1000)};
  let saved=old, downloads=0;
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=> {
    if (String(url).startsWith('https://downloader.disk.yandex.ru/')) { downloads++; return new Response(workbook,{headers:{'content-length':String(workbook.length)}}); }
    return original(url,options);
  });
  const store={get:async()=>saved,getMeta:async()=>({revision:saved.revision,updated_at:saved.updated_at}),
    getRevision:async()=>saved.revision,put:async(src,p,role,revision,data)=>{saved={revision,data,updated_at:new Date()};}};
  const service=createPreparedService({source,store,yandex:async url=>Response.json(url.pathname.endsWith('/download')
    ? {href:'https://downloader.disk.yandex.ru/manual'} :
      {type:'file',name:'Мой файл.xlsx',size:workbook.length,modified:'2026-10-04'})});
  const result=await service.fromDatabase(path,'consumption',`"${Buffer.from(old.revision).toString('base64url')}"`);
  assert.equal(result.unchanged,undefined);
  assert.notEqual(result.revision,'old');
  assert.equal(downloads,1);
});
