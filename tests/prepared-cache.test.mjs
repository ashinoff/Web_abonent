import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { fetchPrepared, downloadOfflineCopy, listOfflineCopies, deleteOfflineCopy } from '../public/prepared-cache.js';
import { folderSources, offlineCopyState, withLocalFolders, offlineDirectory, rememberMapDirectories, rememberOfflineFiles } from '../public/offline-copies.js';
import { createLoadSession, requestSignal } from '../public/load-session.js';

const source = 'https://disk.yandex.ru/d/TestOffline';
const registry = { path: '/ЭС/РЭС/Расширенный список.xlsx', role: 'registry', name: 'Расширенный список.xlsx' };
const monthly = { path: '/ЭС/РЭС/ПО.xlsx', role: 'consumption', name: 'ПО.xlsx' };
const incoming = { path: '/ЭС/РЭС/прием.xlsx', role: 'incoming', name: 'прием.xlsx' };
const pack = (role, version) => ({ format: 1, role, version });
const response = (role, version = '1', stale = false) => Response.json(pack(role, version), { headers: { 'X-Prepared-Revision': version, 'X-Prepared-Stale': stale ? '1' : '0' } });
const options = files => ({ source, resPath: '/ЭС/РЭС', files });
const waitFor = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.location = new URL('https://app.example.test/');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, storage: { estimate: async () => ({ quota: 1e9, usage: 0 }) } } });
});

function network(t, version = '1') {
  t.mock.method(globalThis, 'fetch', async url => response(new URL(url).searchParams.get('role'), version));
}

test('existing v1 copies survive metadata migration and can be listed without parsing JSON', async () => {
  const request = indexedDB.open('abonent-prepared-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('packages');
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const body = new Blob(['an old, deliberately non-JSON body']);
  const tx = db.transaction('packages', 'readwrite');
  tx.objectStore('packages').put({ body, revision: 'old', savedAt: 1 }, JSON.stringify([source, registry.path, registry.role]));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
  const copies = await listOfflineCopies(source);
  assert.equal(copies.length, 1); assert.equal(copies[0].bytes, body.size); assert.equal(copies[0].files[0].revision, 'old');
  await deleteOfflineCopy(source, '/ЭС/РЭС'); assert.deepEqual(await listOfflineCopies(source), []);
});

test('opened RES caches only requested files, reads offline and prunes an old filename for the same role', async t => {
  network(t);
  const first = await fetchPrepared({ source, ...registry }); assert.equal(first.cached, true);
  await fetchPrepared({ source, ...monthly });
  const renamed = { ...registry, path: '/ЭС/РЭС/Расширенный список.xls' };
  await fetchPrepared({ source, ...renamed });
  const [copy] = await listOfflineCopies(source);
  assert.equal(copy.files.length, 2); assert.equal(copy.files.some(file => file.path === registry.path), false);
  assert.equal(copy.bytes, copy.files.reduce((bytes, file) => bytes + file.bytes, 0));
  navigator.onLine = false;
  const offline = await fetchPrepared({ source, ...renamed });
  assert.equal(offline.offline, true); assert.deepEqual(offline.data, pack('registry', '1'));
  await assert.rejects(fetchPrepared({ source, ...registry }), /Нет подключения/);
});

test('explicit offline choice uses saved data even online and never requests missing or deleted files', async t => {
  network(t);
  await downloadOfflineCopy(options([registry, monthly]));
  const before = await listOfflineCopies(source);
  const blocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not be used by an offline choice'); });
  const result = await fetchPrepared({ source, ...registry, offlineOnly:true });
  assert.equal(navigator.onLine, true);
  assert.equal(result.offline, true); assert.equal(result.cached, true);
  assert.deepEqual(result.data, pack('registry', '1'));
  assert.deepEqual(await listOfflineCopies(source), before);
  await assert.rejects(fetchPrepared({ source, ...incoming, offlineOnly:true }), /нет сохранённой копии/);
  await deleteOfflineCopy(source, '/ЭС/РЭС');
  await assert.rejects(fetchPrepared({ source, ...registry, offlineOnly:true }), /нет сохранённой копии/);
  assert.equal(blocked.mock.callCount(), 0);
});

test('deleting one copy keeps other RES and public-folder sources intact', async t => {
  network(t);
  await fetchPrepared({ source, ...registry }); await fetchPrepared({ source, ...monthly });
  const other = { ...registry, path: '/ЭС/Другая РЭС/Расширенный список.xlsx' };
  await fetchPrepared({ source, ...other }); await fetchPrepared({ source: 'another source', ...registry });
  await deleteOfflineCopy(source, '/ЭС/РЭС');
  assert.deepEqual((await listOfflineCopies(source)).map(copy => copy.resPath), ['/ЭС/Другая РЭС']);
  assert.equal((await listOfflineCopies('another source')).length, 1);
  navigator.onLine = false;
  await assert.rejects(fetchPrepared({ source, ...registry }), /Нет подключения/);
  assert.equal((await fetchPrepared({ source, ...other })).cached, true);
});

test('cancelled fetch never returns an offline fallback or writes its late response', async t => {
  network(t); await fetchPrepared({ source, ...registry });
  const entered = waitFor(), late = waitFor(), controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { entered.resolve(opts.signal); return late.promise; });
  const request = fetchPrepared({ source, ...registry, signal: controller.signal });
  const rejection = assert.rejects(request, { name: 'AbortError' });
  const signal = await entered.promise; controller.abort(); assert.equal(signal.aborted, true);
  late.resolve(response('registry', '2')); await rejection;
  assert.equal((await listOfflineCopies(source))[0].files[0].revision, '1');
});

test('a download already in flight cannot recreate a deleted copy, including across tabs', async t => {
  network(t); await fetchPrepared({ source, ...registry });
  const entered = waitFor(), late = waitFor();
  t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); return late.promise; });
  const request = fetchPrepared({ source, ...registry });
  const rejection = assert.rejects(request, { name: 'AbortError' });
  await entered.promise; await deleteOfflineCopy(source, '/ЭС/РЭС'); late.resolve(response('registry', '2'));
  await rejection; assert.deepEqual(await listOfflineCopies(source), []);
});

test('failed whole-RES update leaves all old parts and revisions available offline', async t => {
  network(t); await downloadOfflineCopy(options([registry, monthly]));
  t.mock.method(globalThis, 'fetch', async url => new URL(url).searchParams.get('role') === 'registry' ? response('registry', '2') : Response.json({ error:'ПО недоступно' }, { status:502 }));
  await assert.rejects(downloadOfflineCopy(options([registry, monthly])), /ПО недоступно/);
  assert.deepEqual((await listOfflineCopies(source))[0].files.map(file => file.revision), ['1', '1']);
  navigator.onLine = false;
  assert.deepEqual((await fetchPrepared({ source, ...registry })).data, pack('registry', '1'));
});

test('conditional update reuses 304 bodies, replaces changed parts and removes obsolete parts', async t => {
  network(t); await downloadOfflineCopy(options([registry, monthly, incoming]));
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(opts.headers['If-None-Match'], '"1"');
    return new URL(url).searchParams.get('role') === 'registry' ? new Response(null, { status:304, headers:{ 'X-Prepared-Stale':'0' } }) : response('consumption', '2');
  });
  await downloadOfflineCopy(options([registry, monthly]));
  const [copy] = await listOfflineCopies(source);
  assert.equal(copy.files.length, 2); assert.equal(offlineCopyState(copy, [registry, monthly]), 'ready');
  assert.equal(copy.files.find(file => file.role === 'registry').revision, '1');
  assert.equal(copy.files.find(file => file.role === 'consumption').revision, '2');
  assert.equal(offlineCopyState(copy, [registry, monthly, incoming]), 'partial');
});

test('quota checks and transaction quota errors retain old copies; online data still opens', async t => {
  network(t); await downloadOfflineCopy(options([registry, monthly]));
  navigator.storage.estimate = async () => ({ quota:1, usage:1 });
  t.mock.method(globalThis, 'fetch', async url => response(new URL(url).searchParams.get('role'), 'a much larger revision'));
  await assert.rejects(downloadOfflineCopy(options([registry, monthly])), { name:'QuotaExceededError' });
  navigator.storage.estimate = async () => ({ quota:1e9, usage:0 });
  const put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function(value, key) {
    if (this.name === 'packages' && value.revision !== '1') throw new DOMException('full', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  await assert.rejects(downloadOfflineCopy(options([registry, monthly])), { name:'QuotaExceededError' });
  assert.ok((await listOfflineCopies(source))[0].files.every(file => file.revision === '1'));
  const online = await fetchPrepared({ source, ...registry });
  assert.equal(online.cached, false); assert.equal(online.data.version, 'a much larger revision');
  assert.ok((await listOfflineCopies(source))[0].files.every(file => file.revision === '1'));
});

test('stale 200 and 304 responses cannot claim a successful offline update', async t => {
  network(t); await downloadOfflineCopy(options([registry]));
  for (const status of [200, 304]) {
    t.mock.method(globalThis, 'fetch', async () => status === 200 ? response('registry', '2', true) : new Response(null, { status:304, headers:{ 'X-Prepared-Stale':'1' } }));
    await assert.rejects(downloadOfflineCopy(options([registry])), /старая версия/);
    assert.equal((await listOfflineCopies(source))[0].files[0].revision, '1');
  }
});

test('cancelling a bundle between parts keeps the old copy and does not request the next part', async t => {
  network(t); await downloadOfflineCopy(options([registry, monthly]));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => { requests++; return response(new URL(url).searchParams.get('role'), '2'); });
  const controller = new AbortController();
  await assert.rejects(downloadOfflineCopy({ ...options([registry, monthly]), signal:controller.signal, onProgress:({ index }) => { if (index === 2) controller.abort(); } }), { name:'AbortError' });
  assert.equal(requests, 1); assert.ok((await listOfflineCopies(source))[0].files.every(file => file.revision === '1'));
});

test('downloading an unopened RES remembers enough directories and filenames for offline selection', () => {
  const data = new Map(), storage = { getItem:key => data.get(key), setItem:(key,value) => data.set(key,value) };
  const folder = { enterprise_path:'/ЭС', enterprise_name:'ЭС', res_path:'/ЭС/РЭС', res_name:'РЭС', statuses:{ registry:{ ...registry, file:registry.name }, consumption:{ ...monthly, file:monthly.name }, incoming:{ state:'missing' } } };
  assert.deepEqual(folderSources(folder).map(file => file.role), ['registry', 'consumption']);
  rememberMapDirectories(source, [folder], storage); rememberOfflineFiles(source, folder.res_path, folderSources(folder), storage);
  assert.equal(JSON.parse(data.get('abonent.folder.v1:' + source + ':/'))[0].path, '/ЭС');
  assert.equal(JSON.parse(data.get('abonent.folder.v1:' + source + ':/ЭС'))[0].path, '/ЭС/РЭС');
  assert.equal(JSON.parse(data.get('abonent.folder.v1:' + source + ':/ЭС/РЭС')).length, 2);
  const local = withLocalFolders([], [{ resPath:folder.res_path, files:[registry] }]);
  assert.equal(local[0].localOnly, true); assert.equal(local[0].statuses.registry.path, registry.path);
  const copies = [{ resPath:folder.res_path, files:[registry] }];
  assert.equal(offlineDirectory(copies, '/')[0].name, 'ЭС');
  assert.equal(offlineDirectory(copies, '/ЭС')[0].name, 'РЭС');
  assert.equal(offlineDirectory(copies, folder.res_path)[0].path, registry.path);
  assert.equal(offlineDirectory(copies, '/Другой РЭС'), null);
});

test('switching selection and stopping invalidate old work, including a fetch timeout signal', async () => {
  const session = createLoadSession(), first = session.start(), combined = requestSignal(first, 1000);
  const second = session.start();
  assert.equal(first.aborted, true); assert.equal(combined.aborted, true);
  assert.equal(session.current(first), false); assert.equal(session.current(second), true);
  session.cancel(); assert.equal(session.current(second), false);
});
