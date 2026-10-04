import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import XLSX from '@e965/xlsx';
import { prepareWorkbook } from '../prepared-workbook.mjs';
import { fetchPrepared, listOfflineCopies } from '../public/prepared-cache.js';
import { unpackRegistry, unpackMonthly } from '../public/prepared-data.js';
import { buildIndex, analysisRecords, search } from '../public/core.js';
import { indexMonthly } from '../public/monthly.js';
import { createAnalysisService } from '../public/analysis-service.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const excel = rows => { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Лист1'); return XLSX.write(book, { type:'buffer', bookType:'xlsx' }); };
const packs = {
  registry: prepareWorkbook(excel([['Номер счетчика','ЛС','Наименование договора','ТУ','ТП','Адрес'],['00123','0001','Вымышленный абонент','Точка 1','ТП-1','Тестовая улица, 1']]), 'registry', 'Расширенный список.xlsx'),
  consumption: prepareWorkbook(excel([['Полезный отпуск по всем точкам учета за Январь 2022 г. - Февраль 2022 г.'],['ЛС/Номер договора','ТУ','ТП','Январь 2022','Февраль 2022'],['0001','Точка 1','ТП-1',10,20]]), 'consumption', 'ПО.xlsx'),
  incoming: { format:1, role:'incoming', sheets:1 },
};
const source = 'https://disk.yandex.ru/d/UiLoadingTest';
const folders = [['ЭС А','Долгая РЭС'],['ЭС А','Готовая РЭС'],['ЭС Б','Другая РЭС']].map(([enterprise_name,res_name]) => ({ enterprise_name, enterprise_path:'/'+enterprise_name, res_name, res_path:'/'+enterprise_name+'/'+res_name,
  statuses:Object.fromEntries([['registry','Расширенный список.xlsx'],['consumption','ПО.xlsx'],['incoming','прием.xlsx']].map(([role,file]) => [role,{ state:'ready',file,path:'/'+enterprise_name+'/'+res_name+'/'+file,size:9*1048576 }])) }));
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(5); }
  assert.fail('Timed out: ' + description);
}

test('UI keeps selection responsive, preserves ready data on stop and manages only chosen offline copies', async t => {
  const timers = new Set(), setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    const timer = setTimer(() => { timers.delete(timer); callback(...args); }, milliseconds);
    timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); clearTimer(timer); });
  const page = new Window({ url:'https://app.example.test/', settings:{ disableCSSFileLoading:true, disableJavaScriptFileLoading:true } });
  page.document.write(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  const nav = { onLine:true, storage:{ estimate:async () => ({ quota:1e9,usage:0 }) }, serviceWorker:{ register:async () => ({}), ready:Promise.resolve({}) } };
  for (const [key,value] of Object.entries({ window:page, document:page.document, localStorage:page.localStorage, location:page.location, navigator:nav, indexedDB:new IDBFactory(),
    requestAnimationFrame:page.requestAnimationFrame.bind(page), cancelAnimationFrame:page.cancelAnimationFrame.bind(page), matchMedia:()=>({ matches:true }) }))
    Object.defineProperty(globalThis,key,{ value, configurable:true, writable:true });
  const $ = selector => page.document.querySelector(selector);
  const workers = [];
  class WorkbookWorker {
    constructor() { this.controller = new AbortController(); this.closed = false; workers.push(this); }
    terminate() { this.closed = true; this.controller.abort(); }
    async postMessage({ id,action,payload }) {
      this.action = action;
      try {
        let result;
        if (['loadPreparedRegistry','loadPreparedMonthly','checkPreparedIncoming'].includes(action)) {
          const { data:pack,...info } = await fetchPrepared({ ...payload,signal:this.controller.signal });
          if (this.closed) return;
          if (action === 'loadPreparedRegistry') {
            const sheets = unpackRegistry(pack); this.index = buildIndex(sheets);
            result = { ...info,count:this.index.records.length,notesCount:0,skipped:[],sheets:sheets.map(({sheet,layout,sample})=>({sheet,layout,sample})) };
          } else if (action === 'loadPreparedMonthly') {
            this.analysis = createAnalysisService(indexMonthly(unpackMonthly(pack)),payload.records);
            result = { ...this.analysis.summary,...info };
          } else result = { sheets:pack.sheets,...info };
        } else if (action === 'analysisRecords') result = analysisRecords(this.index.records);
        else if (action === 'search') result = search(this.index,payload);
        else if (action === 'analysisConsumer') result = this.analysis.consumer(payload.account,payload.settings,payload.tp,payload.point);
        else throw new Error('Unexpected worker action: '+action);
        if (!this.closed) this.onmessage({ data:{ id,result } });
      } catch (error) { if (!this.closed) this.onmessage({ data:{ id,error:error.message } }); }
    }
  }
  globalThis.Worker = WorkbookWorker;
  const slowRegistry = deferred(), registryStarted = deferred(), slowMonthly = deferred(), monthlyStarted = deferred();
  let folderDelay = null, failUpdate = false, revision = '1', slowIncoming = null, blockNetwork = false;
  const networkCalls = [];
  t.mock.method(globalThis,'fetch',async (input, opts = {}) => {
    const url = new URL(input), path = url.searchParams.get('path') || '/';
    networkCalls.push(url.href);
    if (blockNetwork) throw new Error('Network is unavailable');
    if (!nav.onLine) throw new Error('offline');
    if (url.pathname === '/api/config') return Response.json({ proxy:true,prepared:true,databaseConnected:true,publicUrl:source });
    if (url.pathname === '/api/load-map') return Response.json({ folders });
    if (['/api/directory','/api/resources'].includes(url.pathname)) {
      if (folderDelay && path === '/ЭС А') await folderDelay.promise;
      let items;
      if (path === '/') items = [{ type:'dir',path:'/ЭС А',name:'ЭС А' },{ type:'dir',path:'/ЭС Б',name:'ЭС Б' }];
      else if (folders.some(folder => folder.enterprise_path === path)) items = folders.filter(folder => folder.enterprise_path === path).map(folder => ({ type:'dir',path:folder.res_path,name:folder.res_name }));
      else items = Object.values(folders.find(folder => folder.res_path === path).statuses).map(item => ({ ...item,type:'file',name:item.file }));
      return Response.json({ type:'dir',_embedded:{items,total:items.length} });
    }
    assert.equal(url.pathname,'/api/prepared');
    const role = url.searchParams.get('role');
    if (path.includes('/Долгая РЭС/') && role === 'registry') { registryStarted.resolve(); await slowRegistry.promise; }
    if (path.includes('/Готовая РЭС/') && role === 'consumption') { monthlyStarted.resolve(); await slowMonthly.promise; }
    if (slowIncoming && role === 'incoming') await slowIncoming.promise;
    opts.signal?.throwIfAborted();
    if (failUpdate && role === 'consumption') return Response.json({ error:'Тестовый сбой ПО' },{status:502});
    return Response.json(packs[role],{headers:{'X-Prepared-Revision':revision,'X-Prepared-Stale':'0'}});
  });
  t.after(async () => { slowRegistry.resolve(); slowMonthly.resolve(); folderDelay?.resolve(); slowIncoming?.resolve(); workers.forEach(worker => worker.terminate()); for (const timer of timers) clearTimer(timer); await page.happyDOM.close(); });
  await import('../public/app.js?ui-loading');
  await until(() => $('#folder-list').querySelectorAll('[data-folder]').length === 2,'initial enterprise choices');
  const enterprise = name => [...$('#folder-list').querySelectorAll('[data-folder]')].find(item => item.textContent.includes(name));
  const res = name => [...$('#res-list').querySelectorAll('[data-res]')].find(item => item.textContent.includes(name));

  await t.test('offline button is next to the indicators and explains an empty phone without using the network', async () => {
    assert.ok($('.source-indicators #offline-open'));
    const before = networkCalls.length;
    $('#offline-open').click();
    await until(() => $('#offline-list').getAttribute('aria-busy') === 'false','empty offline list');
    assert.equal($('#offline-dialog').open, true);
    assert.match($('#offline-list').textContent, /пока нет сохранённых РЭС/);
    assert.equal($('#offline-list').querySelectorAll('[data-offline-res]').length, 0);
    assert.equal(networkCalls.length, before);
    $('#offline-dialog').close();
  });

  await t.test('switching while a registry request hangs cancels it and ignores its late result', async () => {
    $('#district-button').click(); enterprise('ЭС А').click();
    await until(() => res('Долгая РЭС'),'RES choices'); res('Долгая РЭС').click(); await registryStarted.promise;
    assert.equal($('#district-button').disabled,false); assert.equal($('#res-button').disabled,false); assert.equal($('#load-stop').hidden,false);
    $('#res-button').click(); assert.equal(res('Готовая РЭС').disabled,false); res('Готовая РЭС').click();
    await monthlyStarted.promise; assert.equal($('#registry-indicator').dataset.state,'on');
    slowRegistry.resolve(); await delay(20);
    assert.equal($('#res-label').textContent,'Готовая РЭС'); assert.equal($('#settings-dialog').open,false);
    assert.equal(workers.filter(worker => !worker.closed && worker.index).length,1);
  });
  await t.test('stopping PO leaves the loaded registry searchable and a late PO cannot turn green', async () => {
    $('#load-stop').click(); assert.equal($('#search-submit').disabled,false); assert.equal($('#load-stop').hidden,true);
    $('#search-input').value = '00123'; $('#search-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
    await until(() => $('#results').textContent.includes('Вымышленный абонент'),'search after stop');
    slowMonthly.resolve(); await delay(20);
    assert.equal($('#consumption-indicator').dataset.state,'off'); assert.equal($('#registry-indicator').dataset.state,'on');
  });
  await t.test('a late enterprise directory cannot replace the newly selected enterprise', async () => {
    folderDelay = deferred(); $('#district-button').click(); enterprise('ЭС А').click();
    assert.equal($('#res-dialog').open,true); $('#res-dialog [data-open-enterprises]').click(); enterprise('ЭС Б').click();
    await until(() => res('Другая РЭС'),'new enterprise RES list'); folderDelay.resolve(); await delay(20); folderDelay = null;
    assert.equal($('#district-label').textContent,'ЭС Б'); assert.equal($('#res-list').textContent.includes('Готовая РЭС'),false);
  });
  const row = name => [...$('#load-map-list').querySelectorAll('article')].find(item => item.textContent.includes(name));
  await t.test('map downloads an unopened RES without switching the active selection and failed update retains it', async () => {
    $('#settings-open').click(); $('#load-map-tab').click();
    await until(() => row('Другая РЭС'),'load map'); row('Другая РЭС').querySelector('[data-offline-action="download"]').click();
    await until(() => row('Другая РЭС').querySelector('.offline-copy').dataset.state === 'ready','downloaded copy');
    assert.equal((await listOfflineCopies(source)).length,2); assert.equal($('#res-label').textContent,'Выберите РЭС');
    assert.match($('#offline-storage').textContent,/2 РЭС/);
    revision = '2'; failUpdate = true; row('Другая РЭС').querySelector('[data-offline-action="update"]').click();
    await until(() => row('Другая РЭС').querySelector('.offline-message').dataset.kind === 'error','failed update message');
    assert.ok((await listOfflineCopies(source)).find(copy => copy.resPath === '/ЭС Б/Другая РЭС').files.every(file => file.revision === '1'));
    failUpdate = false; row('Другая РЭС').querySelector('[data-offline-action="update"]').click();
    await until(() => row('Другая РЭС').querySelector('.offline-message').dataset.kind === 'success','successful update');
  });
  await t.test('stopping incoming preserves ready monthly analysis and can still search', async () => {
    $('#settings-dialog .close-dialog').click(); $('#res-button').click(); slowIncoming = deferred(); res('Другая РЭС').click();
    await until(() => $('#consumption-indicator').dataset.state === 'on' && $('#incoming-indicator').dataset.state === 'checking','incoming request');
    $('#load-stop').click(); slowIncoming.resolve(); slowIncoming = null;
    assert.equal($('#contour-open').disabled,false); assert.equal(workers.filter(worker => !worker.closed && worker.analysis).length,1);
    $('#search-input').value = '00123'; $('#search-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
    await until(() => $('#results').textContent.includes('Вымышленный абонент'),'search after incoming stop');
  });
  await t.test('offline shortcut lists only saved RES and opens registry, PO and incoming without requests even online', async () => {
    const beforeCopies = await listOfflineCopies(source), beforeRequests = networkCalls.length;
    blockNetwork = true;
    try {
      $('#offline-open').click();
      await until(() => $('#offline-list').querySelectorAll('[data-offline-res]').length === 2,'saved-only choices');
      assert.equal($('#offline-list').textContent.includes('Долгая РЭС'), false);
      const choice = [...$('#offline-list').querySelectorAll('[data-offline-res]')].find(item => item.textContent.includes('Другая РЭС'));
      assert.match(choice.textContent, /ЭС Б/); assert.match(choice.textContent, /Реестр · ПО · Приём/);
      choice.click();
      await until(() => $('#incoming-indicator').dataset.state === 'on' && $('#offline-readiness').dataset.ready === 'true','local-only registry, consumption and incoming');
      assert.equal(nav.onLine, true); assert.equal($('#offline-dialog').open, false);
      assert.equal($('#district-label').textContent, 'ЭС Б'); assert.equal($('#res-label').textContent, 'Другая РЭС');
      assert.equal($('#registry-indicator').dataset.state, 'on'); assert.equal($('#consumption-indicator').dataset.state, 'on');
      $('#search-input').value = '00123'; $('#search-form').dispatchEvent(new page.Event('submit',{bubbles:true,cancelable:true}));
      await until(() => $('#results').textContent.includes('Вымышленный абонент'),'search from offline choice');
      assert.equal(networkCalls.length, beforeRequests);
      assert.deepEqual(await listOfflineCopies(source), beforeCopies);
    } finally { blockNetwork = false; }
  });
  await t.test('saved directories open the downloaded RES offline and deletion clears only its readiness', async () => {
    nav.onLine = false; page.dispatchEvent(new page.Event('offline'));
    $('#res-button').click(); res('Другая РЭС').click();
    await until(() => $('#offline-readiness').dataset.ready === 'true','offline-ready saved RES');
    assert.equal($('#registry-indicator').dataset.state,'on'); assert.equal($('#consumption-indicator').dataset.state,'on');
    $('#settings-open').click(); $('#load-map-tab').click(); await until(() => row('Другая РЭС')?.querySelector('[data-offline-action="update"]')?.disabled,'offline map controls');
    // Dialog swipe protection suppresses clicks for 650 ms after dismissal.
    await delay(700);
    row('Другая РЭС').querySelector('[data-offline-action="delete"]').click();
    await until(() => row('Другая РЭС').querySelector('.offline-copy').dataset.state === 'missing','deleted local copy');
    assert.equal((await listOfflineCopies(source)).length,1); assert.equal($('#offline-readiness').dataset.ready,'false');
    assert.equal($('#registry-indicator').dataset.state,'on'); assert.equal($('#search-submit').disabled,false);
  });
  await t.test('airplane mode chooser reflects deletion and directly opens a saved RES from another enterprise', async () => {
    const beforeRequests = networkCalls.length;
    $('#offline-open').click();
    await until(() => $('#offline-list').getAttribute('aria-busy') === 'false','updated offline choices');
    const choices = $('#offline-list').querySelectorAll('[data-offline-res]');
    assert.equal(choices.length, 1); assert.match(choices[0].textContent, /Готовая РЭС/);
    assert.equal($('#offline-list').textContent.includes('Другая РЭС'), false);
    choices[0].click();
    await until(() => $('#registry-indicator').dataset.state === 'on' && $('#load-stop').hidden,'saved registry from another enterprise');
    assert.equal($('#district-label').textContent, 'ЭС А'); assert.equal($('#res-label').textContent, 'Готовая РЭС');
    assert.equal($('#consumption-indicator').dataset.state, 'off'); assert.equal($('#incoming-indicator').dataset.state, 'off');
    assert.equal($('#search-submit').disabled, false); assert.equal($('#settings-dialog').open, false);
    assert.equal(networkCalls.length, beforeRequests);
  });
});
