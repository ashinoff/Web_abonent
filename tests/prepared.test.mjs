import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import XLSX from '@e965/xlsx';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { unpackRegistry, unpackMonthly } from '../public/prepared-data.js';
import { buildIndex, search, listNotes, analysisRecords } from '../public/core.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { indexMonthly } from '../public/monthly.js';
import { createPreparedService, preparationLimits, revisionOf } from '../prepared-service.mjs';
import { JOURNAL_ANALYSIS_VERSION, EVENTS_PACKAGE_VERSION } from '../public/journals.js';
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
  assert.deepEqual(preparationLimits(2000), {heapMB:756,childMB:1700,combinedMB:1800,packageMB:250});
  const larger=preparationLimits(2048);
  assert.equal(larger.heapMB,768);
  assert.ok(larger.heapMB > 128 && larger.childMB > 160 && larger.packageMB > 64);
  assert.ok(larger.combinedMB < 2048);
  assert.ok(2048 - larger.combinedMB >= 192);
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

test('catalog records optional journal roles without preparing or downloading them',async()=>{
  const resPath='/ЭС/РЭС',folders=new Map(),calls=[];
  const files=[{type:'file',name:'31. значения.xlsx',path:resPath+'/31. значения.xlsx',size:1024,modified:'2026-10-11'},
    {type:'file',name:'46. события.xlsx',path:resPath+'/46. события.xlsx',size:2048,modified:'2026-10-11'}];
  const tree={'/':[{type:'dir',name:'ЭС',path:'/ЭС'}],'/ЭС':[{type:'dir',name:'РЭС',path:resPath}],[resPath]:files};
  const service=createPreparedService({source:'https://disk.yandex.ru/d/OptionalJournals',store:{
    listFolders:async()=>[...folders.values()],putFolder:async(_,folder,statuses)=>folders.set(folder.path,{res_path:folder.path,statuses}),
  },yandex:async url=>{
    assert.equal(url.pathname.endsWith('/download'),false);
    const path=url.searchParams.get('path');calls.push(path);
    return Response.json({type:'dir',_embedded:{items:tree[path]||[],total:(tree[path]||[]).length}});
  }});
  await service.syncAll({prepare:false});
  assert.deepEqual(calls,['/','/ЭС',resPath]);
  const {statuses}=folders.get(resPath);
  assert.equal(statuses.instant.state,'pending');assert.equal(statuses.instant.path,files[0].path);
  assert.equal(statuses.events.state,'pending');assert.equal(statuses.events.path,files[1].path);
  assert.equal(statuses.registry.state,'missing');assert.equal(statuses.consumption.state,'missing');
});

test('prepared API serves cached journals and validates blocks before any snapshot access',async()=>{
  let blocked=false,reads=0,policyChecks=0;
  const preparedStore={
    assertLoadAllowed:async()=>{policyChecks++;if(blocked)throw Object.assign(new Error('Загрузка закрыта.'),{status:403,code:'res_blocked'});return{generation:'0',globalGeneration:'0'};},
    get:async(_,path,role)=>{reads++;return{revision:role==='instant'?`instant:v${JOURNAL_ANALYSIS_VERSION}:journal-test`:`events:v${EVENTS_PACKAGE_VERSION}:journal-test`,data:{format:1,role,rows:[]}};},
  };
  const server=createServer({env:{YANDEX_PUBLIC_URL:'https://disk.yandex.ru/d/CachedJournals'},preparedStore});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const role of ['instant','events']) {
      const url=base+'/api/prepared?path='+encodeURIComponent('/ЭС/РЭС/журнал.xlsx')+'&role='+role;
      const response=await fetch(url);assert.equal(response.status,200);assert.equal((await response.json()).role,role);
      assert.equal((await fetch(url,{method:'HEAD'})).status,200);
      blocked=true;const before=reads;
      const denied=await fetch(url);assert.equal(denied.status,403);assert.equal((await denied.json()).code,'res_blocked');
      assert.equal(reads,before);blocked=false;
    }
    assert.ok(policyChecks>4);
    assert.equal((await fetch(base+'/api/prepared?path=%2F%D0%AD%D0%A1%2F%D0%A0%D0%AD%D0%A1%2F%D0%B6%D1%83%D1%80%D0%BD%D0%B0%D0%BB.xlsx&role=unrecognised')).status,400);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('journal 31 parser upgrade prepares unchanged Excel once before returning an old ETag',async t=>{
  const source='https://disk.yandex.ru/d/ParserUpgrade',path='/ЭС/РЭС/31. значения.xlsx';
  const workbook=excel([
    ['Серийный','Время','Активная мощность по фазе 1 (КВт)','Напряжение на фазе 1 (В)','Ток в фазе 1 (А)','Коэффициент мощности по фазе 1 cos(f)'],
    ['0001','01.08.2026 12:00:00',0.5,230,2.2,0.99],
  ]);
  const meta={type:'file',name:'31. значения.xlsx',size:workbook.length,modified:'2026-10-01',md5:'unchanged-source'};
  let saved={revision:revisionOf(meta),updated_at:new Date(),data:{format:1,role:'instant',fields:['active1'],meters:[{serial:'0001',latest:{at:null,values:[0.5]},signals:[]}]}};
  let downloads=0,writes=0,metadata=0,blocked=false;
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://downloader.disk.yandex.ru/')){downloads++;return new Response(workbook,{headers:{'content-length':String(workbook.length)}});}
    return original(url,options);
  });
  const store={getMeta:async()=>({revision:saved.revision,updated_at:saved.updated_at}),getRevision:async()=>saved.revision,get:async()=>saved,
    assertLoadAllowed:async()=>{if(blocked)throw Object.assign(new Error('Загрузка закрыта.'),{status:403,code:'res_blocked'});return{generation:'0',globalGeneration:'0'};},
    put:async(_,file,role,revision,data)=>{assert.equal(file,path);assert.equal(role,'instant');writes++;saved={revision,data,updated_at:new Date()};}};
  const service=createPreparedService({source,store,yandex:async url=>{
    metadata++;
    return Response.json(url.pathname.endsWith('/download')?{href:'https://downloader.disk.yandex.ru/upgrade'}:meta);
  }});
  const oldEtag=`"${Buffer.from(saved.revision).toString('base64url')}"`;
  const upgraded=await Promise.all(Array.from({length:5},()=>service.fromDatabase(path,'instant',oldEtag)));
  assert.equal(downloads,1);assert.equal(writes,1);assert.equal(metadata,2);
  assert.ok(upgraded.every(item=>!item.unchanged&&item.revision.startsWith(`instant:v${JOURNAL_ANALYSIS_VERSION}:`)));
  const pack=JSON.parse(gunzipSync(upgraded[0].payload));assert.equal(pack.analysisVersion,JOURNAL_ANALYSIS_VERSION);
  assert.equal(pack.role,'instant');assert.equal(pack.meters[0].serial,'0001');assert.ok(pack.fields.includes('neutralCurrent'));
  const currentEtag=`"${Buffer.from(saved.revision).toString('base64url')}"`;
  const unchanged=await service.fromDatabase(path,'instant',currentEtag);
  assert.equal(unchanged.unchanged,true);assert.equal(unchanged.revision,saved.revision);
  assert.equal(downloads,1);assert.equal(writes,1);assert.equal(metadata,2);
  blocked=true;
  await assert.rejects(service.fromDatabase(path,'instant',oldEtag),error=>error.code==='res_blocked');
  assert.equal(downloads,1);assert.equal(metadata,2);
});

test('journal parser upgrade failure retains the last good package and marks conditional responses stale',async t=>{
  const path='/ЭС/РЭС/31. старый.xlsx',saved={revision:'legacy-instant',updated_at:new Date(),data:{format:1,role:'instant',fields:[],meters:[]}};
  let attempts=0;
  const store={getMeta:async()=>saved,getRevision:async()=>saved.revision,get:async()=>saved};
  const service=createPreparedService({source:'https://disk.yandex.ru/d/UpgradeOffline',store,yandex:async()=>{attempts++;throw new Error('Нет сети.');}});
  const result=await service.fromDatabase(path,'instant',`"${Buffer.from(saved.revision).toString('base64url')}"`);
  assert.equal(result.unchanged,true);assert.equal(result.stale,true);assert.equal(result.revision,saved.revision);assert.equal(attempts,1);
  const stale=await service.fromDatabase(path,'instant');assert.equal(stale.stale,true);
  assert.deepEqual(JSON.parse(gunzipSync(stale.payload)),saved.data);
  assert.equal(attempts,1,'failed parser upgrades pause remote metadata attempts for 60 seconds');
});

test('failed journal 31 upgrade backs off for 60 seconds without caching administrative denials',async t=>{
  const path='/ЭС/РЭС/31. неверный.xlsx',workbook=excel([['Нет шапки журнала'],['Учебная строка']]);
  const saved={revision:'legacy-instant',updated_at:new Date(),data:{format:1,role:'instant',fields:[],meters:[]}};
  let downloads=0,metadata=0,blocked=false,generation='0',clock=Date.now();
  t.mock.method(Date,'now',()=>clock);
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://downloader.disk.yandex.ru/')){downloads++;return new Response(workbook,{headers:{'content-length':String(workbook.length)}});}
    return original(url,options);
  });
  const store={getMeta:async()=>saved,getRevision:async()=>saved.revision,get:async()=>saved,
    assertLoadAllowed:async(_,file,expected)=>{
      if(blocked)throw Object.assign(new Error('Загрузка закрыта.'),{status:403,code:'res_blocked'});
      if(expected&&expected.generation!==generation)throw Object.assign(new Error('Данные изменены.'),{status:409,code:'res_changed'});
      return{generation,globalGeneration:'0'};
    },put:async()=>assert.fail('Invalid journals must not replace the last good package')};
  const service=createPreparedService({source:'https://disk.yandex.ru/d/UpgradeBackoff',store,yandex:async url=>{
    metadata++;
    return Response.json(url.pathname.endsWith('/download')?{href:'https://downloader.disk.yandex.ru/bad-upgrade'}:
      {type:'file',name:'31. неверный.xlsx',size:workbook.length,modified:'2026-10-01'});
  }});
  const etag=`"${Buffer.from(saved.revision).toString('base64url')}"`;
  for(let i=0;i<2;i++){
    const result=await service.fromDatabase(path,'instant',etag);assert.equal(result.unchanged,true);assert.equal(result.stale,true);
  }
  assert.equal(downloads,1);assert.equal(metadata,2,'second conditional request must not restart the failed parse');
  blocked=true;
  await assert.rejects(service.fromDatabase(path,'instant',etag),error=>error.code==='res_blocked');
  assert.equal(downloads,1);assert.equal(metadata,2);
  blocked=false;clock+=60001;
  assert.equal((await service.fromDatabase(path,'instant',etag)).stale,true);
  assert.equal(downloads,2);assert.equal(metadata,4,'the retry is allowed after 60 seconds');
  generation='1';
  assert.equal((await service.fromDatabase(path,'instant',etag)).stale,true);
  assert.equal(downloads,3);assert.equal(metadata,6,'a new policy generation cannot inherit an earlier failure backoff');
});

test('journal 46 aggregation upgrade prepares unchanged Excel once before ETag and leaves journal 31 cached',async t=>{
  const source='https://disk.yandex.ru/d/EventAggregationUpgrade',path='/ЭС/РЭС/46. события.xlsx';
  const rows=[
    ['ТУ','Тип ПУ','Серийный','Абонент','Лимит','Дата и время','Тип','Событие','Инициатор','Дополнительная информация'],
    ['','','0001','','','01.08.2026 12:00:00','','','','Вскрытый элемент устройства "Клеммная крышка"'],
  ];
  const workbook=excel(rows),meta={type:'file',name:'46. события.xlsx',size:workbook.length,modified:'2026-10-01',md5:'same-events-source'};
  let saved={revision:revisionOf(meta),updated_at:new Date(),data:{format:1,analysisVersion:2,role:'events',rows:[['0001','2026-08-01T12:00:00',rows[1][9]]]}};
  const instant={revision:`instant:v${JOURNAL_ANALYSIS_VERSION}:cached-source`,updated_at:new Date(),data:{format:1,role:'instant',fields:[],meters:[]}};
  let downloads=0,writes=0,metadata=0,blocked=false,reads=0;
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://downloader.disk.yandex.ru/')){downloads++;return new Response(workbook,{headers:{'content-length':String(workbook.length)}});}
    return original(url,options);
  });
  const entry=role=>role==='instant'?instant:saved;
  const store={
    getMeta:async(_,file,role)=>{reads++;const value=entry(role);return{revision:value.revision,updated_at:value.updated_at};},
    getRevision:async(_,file,role)=>{reads++;return entry(role).revision;},
    get:async(_,file,role)=>{reads++;return entry(role);},
    assertLoadAllowed:async()=>{if(blocked)throw Object.assign(new Error('Загрузка закрыта.'),{status:403,code:'res_blocked'});return{generation:'0',globalGeneration:'0'};},
    put:async(_,file,role,revision,data)=>{assert.equal(file,path);assert.equal(role,'events');writes++;saved={revision,data,updated_at:new Date()};},
  };
  const service=createPreparedService({source,store,yandex:async url=>{
    metadata++;return Response.json(url.pathname.endsWith('/download')?{href:'https://downloader.disk.yandex.ru/event-upgrade'}:meta);
  }});
  const oldEtag=`"${Buffer.from(saved.revision).toString('base64url')}"`;
  const upgraded=await Promise.all(Array.from({length:5},(_,i)=>service.fromDatabase(path,'events',i%2?undefined:oldEtag)));
  assert.equal(downloads,1);assert.equal(writes,1);assert.equal(metadata,2);
  assert.ok(upgraded.every(item=>!item.unchanged&&!item.stale&&item.revision===`events:v${EVENTS_PACKAGE_VERSION}:`+revisionOf(meta)));
  const pack=JSON.parse(gunzipSync(upgraded[0].payload));
  assert.equal(pack.format,1);assert.equal(pack.role,'events');assert.equal(pack.aggregationVersion,EVENTS_PACKAGE_VERSION);
  const currentEtag=`"${Buffer.from(saved.revision).toString('base64url')}"`;
  const unchanged=await service.fromDatabase(path,'events',currentEtag);
  assert.equal(unchanged.unchanged,true);assert.equal(unchanged.stale,false);
  const instantUnchanged=await service.fromDatabase('/ЭС/РЭС/31. значения.xlsx','instant',`"${Buffer.from(instant.revision).toString('base64url')}"`);
  assert.equal(instantUnchanged.unchanged,true);assert.equal(instantUnchanged.revision,instant.revision);
  assert.equal(downloads,1);assert.equal(writes,1);assert.equal(metadata,2,'neither the new events package nor the existing instant parser should reload');
  blocked=true;const beforeReads=reads;
  await assert.rejects(service.fromDatabase(path,'events',oldEtag),error=>error.code==='res_blocked');
  assert.equal(reads,beforeReads);assert.equal(downloads,1);assert.equal(metadata,2);
});

test('failed journal 46 migration backs off, preserves the offline copy, then recovers to one cached aggregation',async t=>{
  const path='/ЭС/РЭС/46. события.xlsx',bad=excel([['Нет шапки журнала'],['Учебная строка']]);
  const good=excel([
    ['ТУ','Тип ПУ','Серийный','Абонент','Лимит','Дата и время','Тип','Событие','Инициатор','Дополнительная информация'],
    ['','','0001','','','01.08.2026 12:00:00','','','','Вскрытый элемент устройства "Корпус"'],
  ]);
  const legacy={format:1,analysisVersion:2,role:'events',rows:[['0001','2026-08-01T12:00:00','Вскрытый элемент устройства "Корпус"']]};
  let saved={revision:'legacy-events',updated_at:new Date(),data:legacy};
  let workbook=bad,downloads=0,metadata=0,writes=0,blocked=false,clock=Date.now();
  t.mock.method(Date,'now',()=>clock);
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://downloader.disk.yandex.ru/')){downloads++;return new Response(workbook,{headers:{'content-length':String(workbook.length)}});}
    return original(url,options);
  });
  const store={getMeta:async()=>({revision:saved.revision,updated_at:saved.updated_at}),getRevision:async()=>saved.revision,get:async()=>saved,
    assertLoadAllowed:async()=>{if(blocked)throw Object.assign(new Error('Загрузка закрыта.'),{status:403,code:'res_blocked'});return{generation:'0',globalGeneration:'0'};},
    put:async(_,file,role,revision,data)=>{assert.equal(file,path);assert.equal(role,'events');writes++;saved={revision,data,updated_at:new Date()};}};
  const service=createPreparedService({source:'https://disk.yandex.ru/d/EventMigrationBackoff',store,yandex:async url=>{
    metadata++;return Response.json(url.pathname.endsWith('/download')?{href:'https://downloader.disk.yandex.ru/event-recovery'}:
      {type:'file',name:'46. события.xlsx',size:workbook.length,modified:'2026-10-01'});
  }});
  const oldEtag=`"${Buffer.from(saved.revision).toString('base64url')}"`;
  for(let i=0;i<2;i++){
    const stale=await service.fromDatabase(path,'events',oldEtag);
    assert.equal(stale.unchanged,true);assert.equal(stale.stale,true);assert.equal(stale.revision,'legacy-events');
  }
  assert.equal(downloads,1);assert.equal(metadata,2);assert.equal(writes,0);
  const offline=await service.fromDatabase(path,'events');assert.equal(offline.stale,true);
  assert.deepEqual(JSON.parse(gunzipSync(offline.payload)),legacy,'migration failure must leave the existing offline format readable');
  assert.equal(downloads,1);assert.equal(metadata,2,'unconditional stale reads also respect the migration backoff');
  blocked=true;
  await assert.rejects(service.fromDatabase(path,'events',oldEtag),error=>error.code==='res_blocked');
  assert.equal(downloads,1);assert.equal(metadata,2);
  blocked=false;workbook=good;clock+=60001;
  const recovered=await service.fromDatabase(path,'events',oldEtag);
  assert.equal(recovered.unchanged,undefined);assert.equal(recovered.stale,false);assert.equal(writes,1);
  assert.equal(JSON.parse(gunzipSync(recovered.payload)).aggregationVersion,EVENTS_PACKAGE_VERSION);
  assert.equal(downloads,2);assert.equal(metadata,4);
  const unchanged=await service.fromDatabase(path,'events',`"${Buffer.from(saved.revision).toString('base64url')}"`);
  assert.equal(unchanged.unchanged,true);assert.equal(unchanged.stale,false);
  assert.equal(downloads,2);assert.equal(metadata,4,'successful migration clears the failure state and caches the new revision');
});
