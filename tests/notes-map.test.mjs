import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { groupMapNotes,mapAddress,exactCandidate,visibleMapGroups,readMapLocations,saveMapLocation,registryLocation } from '../public/notes-map-data.js';
import { initNotesMapUI } from '../public/notes-map-ui.js';
import { parseMatrix,buildIndex,listMapNotes } from '../public/core.js';
import { createMapGeocoder,photonCandidates } from '../map-geocoder.mjs';
import { createServer } from '../server.mjs';

const note = (id,fields = {},text = 'Проверить') => ({ id,fields:{ locality:'Тестовый',street:'Учебная улица',house:'12',meter:id,account:'00'+id,...fields },address:'Тестовый, Учебная улица, д. 12, кв. 4',note:text });
const candidate = { lat:44.6,lon:39.5,house:'12',street:'Учебная улица',city:'Тестовый',label:'Тестовый, Учебная улица, 12' };
const feature = { geometry:{ type:'Point',coordinates:[39.5,44.6] },properties:{ housenumber:'12',street:'Учебная улица',city:'Тестовый',countrycode:'RU' } };

test('map reads all notifications, groups apartments by house and filters individual notes at that house', () => {
  const index = buildIndex([parseMatrix([['ЛС','Номер ПУ','Примечание','Примечание','Населенный пункт','Улица','Дом','Квартира','Широта','Долгота'],
    ...Array.from({ length:205 },(_,i) => [String(i),String(i),'Проверка '+i,i === 1 ? 'Дополнительно' : '', 'Тестовый','Учебная','12',String(i),'44,6','39,5'])])]);
  const notes = listMapNotes(index); assert.equal(notes.length,206); assert.equal(notes[0].fields.flat,undefined);
  const groups = groupMapNotes(notes); assert.equal(groups.length,1); assert.equal(groups[0].notes.length,206);
  assert.deepEqual(groups[0].location,{ lat:44.6,lon:39.5,precision:'registry' });
  assert.equal(visibleMapGroups(groups,'Проверка 204')[0].notes.length,1);
  assert.equal(visibleMapGroups(groups,'ничего').length,0);
  assert.equal(mapAddress({ fields:{},address:'Тестовый, Учебная, д. 12, кв. 55' }),'Тестовый, Учебная, д. 12');
});
test('only a unique matching house, street and locality is accepted automatically', () => {
  const group = groupMapNotes([note('1')])[0];
  assert.equal(exactCandidate(group,[candidate]).precision,'address');
  for (const change of [{house:''},{house:'13'},{street:'Другая улица'},{city:'Другой город'},{lat:NaN}]) assert.equal(exactCandidate(group,[{ ...candidate,...change }]),null);
  assert.equal(exactCandidate(group,[candidate,{ ...candidate,lat:44.7 }]),null);
  assert.equal(exactCandidate(group,[candidate,{ ...candidate }]).lat,candidate.lat);
  assert.equal(exactCandidate(groupMapNotes([note('2',{ locality:'' })])[0],[candidate]),null);
  assert.equal(registryLocation({ latitude:'',longitude:'0' }),null);
  assert.equal(registryLocation({ latitude:'91',longitude:'40' }),null);
});
test('saved places belong to their source and RES, survive reopening and tolerate unavailable storage', () => {
  const items = new Map(), storage = { getItem:key => items.get(key),setItem:(key,value) => items.set(key,value) };
  assert.equal(saveMapLocation('РЭС А','дом',candidate,storage),true);
  assert.equal(readMapLocations('РЭС А',storage).get('дом').lat,44.6);
  assert.equal(readMapLocations('РЭС Б',storage).size,0);
  assert.equal(saveMapLocation('РЭС А','дом',{ ...candidate,lat:44.7 },storage),true);
  assert.equal(readMapLocations('РЭС А',storage).size,1);
  assert.equal(readMapLocations('РЭС А',storage).get('дом').lat,44.7);
  assert.equal(saveMapLocation('РЭС А','дом',candidate,{ getItem() { throw new Error('private'); } }),false);
  assert.equal(readMapLocations('РЭС А',{ getItem:() => '{}' }).size,0);
});
test('Photon proxy shares rate limiting, caches results and cancels queued work without contacting the provider', async () => {
  const calls = [];
  const geocoder = createMapGeocoder({ intervalMs:35,fetcher:async (url,options) => {
    calls.push({ url,time:Date.now(),options }); return Response.json({ features:[feature] });
  } });
  const first = await geocoder.lookup('Тестовый, Учебная, д. 12');
  assert.equal(first[0].lat,44.6); assert.equal(calls[0].url.searchParams.get('countrycode'),'RU');
  await geocoder.lookup('Тестовый, Учебная, д. 12'); assert.equal(calls.length,1);
  const next = geocoder.lookup('Тестовый, Учебная, д. 13'), abort = new AbortController();
  const cancelled = geocoder.lookup('Тестовый, Учебная, д. 14',{ signal:abort.signal }); abort.abort();
  await assert.rejects(cancelled); await next; assert.equal(calls.length,2);
  assert.ok(calls[1].time - calls[0].time >= 30);
  assert.equal(photonCandidates({ features:[{ ...feature,geometry:{ type:'Point',coordinates:[400,91] } },{ ...feature,properties:{ countrycode:'DE' } }] }).length,0);
});
test('geocoding API accepts only a bounded house-address payload and preserves the CSP', async () => {
  let received;
  const server = createServer({ mapGeocoder:{ hostname:'example.test',lookup:async value => { received = value; return [candidate]; } } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = value => fetch(base+'/api/map-geocode',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(value) });
    assert.equal((await send({ address:'Тестовый, Учебная, д. 12',name:'Нельзя отправлять' })).status,400);
    assert.equal(received,undefined);
    const response = await send({ address:'Тестовый, Учебная, д. 12' }); assert.equal(response.status,200);
    assert.equal(received,'Тестовый, Учебная, д. 12'); assert.equal((await response.json()).candidates[0].lat,44.6);
    const csp = response.headers.get('content-security-policy'); assert.match(csp,/script-src 'self'/); assert.match(csp,/img-src 'self' data: https:\/\/tile.openstreetmap.org/); assert.doesNotMatch(csp,/unsafe-inline/);
    assert.equal((await fetch(base+'/api/config')).headers.get('cache-control'),'no-store');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function fakeLeaflet() {
  const state = { markers:[],handlers:new Map() };
  const map = { invalidateSize() {},fitBounds() {},panTo() {},on(event,callback) { state.handlers.set(event,callback); return this; } };
  const layer = { addTo() { return this; },clearLayers() { state.markers = []; } };
  return { state,L:{ map:() => map,layerGroup:() => layer,divIcon:value => value,
    tileLayer:() => ({ addTo() { return this; },on() { return this; } }),
    marker:(position,options) => ({ position,options,bindPopup(value) { this.popup = value; return this; },on(_event,callback) { this.click = callback; return this; },addTo() { state.markers.push(this); return this; } }),
    circleMarker:() => ({ addTo() { return this; },remove() {} }),
  } };
}
async function mapPage(t,{ data = [note('1')],fetcher = async () => Response.json({ candidates:[candidate] }) } = {}) {
  const page = new Window({ url:'https://app.example.test/',settings:{ disableCSSFileLoading:true,disableJavaScriptFileLoading:true } });
  page.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  const restore = [];
  for (const key of ['window','document','localStorage','navigator']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{ configurable:true,value:key === 'window' ? page : key === 'navigator' ? { onLine:true } : page[key] });
    restore.push(() => { if (previous) Object.defineProperty(globalThis,key,previous); else delete globalThis[key]; });
  }
  page.HTMLElement.prototype.scrollIntoView = () => {};
  const fake = fakeLeaflet(), opened = []; let meta = '';
  const ui = initNotesMapUI({ request:async () => data,context:() => ({ scope:'map-test',endpoint:'https://app.example.test/api/map-geocode' }),openRecord:(...args) => opened.push(args),onMeta:value => { meta = value; },loadLeaflet:async () => fake.L,fetcher });
  t.after(async () => { ui.reset(); await page.happyDOM.close(); restore.forEach(run => run()); });
  return { ui,fake,opened,getMeta:() => meta,$:selector => page.document.querySelector(selector),page };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); } assert.fail('UI did not settle'); }

test('map locates notes only after a click, sends no subscriber details and restores saved coordinates', async t => {
  const payloads = [];
  const p = await mapPage(t,{ data:[note('1',{ name:'<script>never execute</script>' }),note('2',{},'Второе уведомление')],fetcher:async (_url,options) => { payloads.push(JSON.parse(options.body)); return Response.json({ candidates:[candidate] }); } });
  await p.ui.show(); assert.equal(payloads.length,0); assert.equal(p.fake.state.markers.length,0);
  p.$('#notes-map-find').click(); await until(() => p.$('#notes-map-stop').hidden);
  assert.deepEqual(payloads,[{ address:'Тестовый, Учебная улица, д. 12' }]); assert.equal(p.fake.state.markers.length,1); assert.match(p.getMeta(),/2 из 2/);
  const marker = p.fake.state.markers[0]; assert.match(marker.options.icon.html,/>2</); assert.equal(marker.popup.querySelector('script'),null);
  marker.popup.querySelector('.map-note-card').click(); assert.deepEqual(p.opened[0],['1',{ parent:'notes-dialog',variants:[] }]);
  p.ui.filter('Второе'); assert.match(p.getMeta(),/1 из 1/); assert.match(p.fake.state.markers[0].options.icon.html,/>1</);
  p.ui.reset(); await p.ui.show(); assert.equal(payloads.length,1); assert.equal(p.fake.state.markers.length,1);
});
test('stopping and switching RES ignore a late geocoding reply', async t => {
  let finish, signal;
  const p = await mapPage(t,{ fetcher:(_url,options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  await p.ui.show(); p.$('#notes-map-find').click(); assert.equal(p.$('#notes-map-stop').hidden,false);
  p.$('#notes-map-stop').click(); assert.equal(signal.aborted,true);
  p.ui.reset(); finish(Response.json({ candidates:[candidate] })); await delay(10);
  assert.equal(p.fake.state.markers.length,0); assert.equal(p.$('#notes-map-panel').hidden,true);
  assert.equal(readMapLocations('map-test').size,0);
});
test('a missing address can be placed manually without any geocoding request', async t => {
  let calls = 0;
  const p = await mapPage(t,{ data:[{ ...note('1',{ locality:'',street:'',house:'' }),address:'' }],fetcher:async () => { calls++; throw new Error('should not fetch'); } });
  await p.ui.show(); p.$('.map-unplaced-address').click(); p.$('.map-place').click();
  p.fake.state.handlers.get('click')({ latlng:{ lat:44.6,lng:39.5 } }); assert.equal(p.$('#notes-map-save').hidden,false);
  p.$('#notes-map-save').click(); assert.equal(p.fake.state.markers.length,1); assert.equal(calls,0); assert.equal(p.$('#notes-map-save').hidden,true);
  assert.equal(readMapLocations('map-test').get('missing:1').precision,'manual');
});
