import { requestSignal } from './load-session.js';

const dbName = 'abonent-prepared-v1';
const packageKey = ({ source, path, role }) => JSON.stringify([source, path, role]);
const copyKey = (source, resPath) => JSON.stringify([source, resPath]);
const parentPath = path => path.slice(0, path.lastIndexOf('/')) || '/';
function metadata(key, value) {
  const [source, path, role] = JSON.parse(key);
  return { source, path, role, resPath: parentPath(path), bytes: value.body.size, revision: value.revision,
    savedAt: value.savedAt, stale: Boolean(value.stale) };
}
function database() {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(dbName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('packages')) db.createObjectStore('packages');
      const entries = db.createObjectStore('metadata');
      db.createObjectStore('generations');
      // Old offline copies survive the upgrade. Read Blob sizes, never expand JSON.
      const cursor = request.transaction.objectStore('packages').openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        try { if (item.value?.body) entries.put(metadata(item.key, item.value), item.key); } catch { /* Ignore unrelated legacy entries. */ }
        item.continue();
      };
    };
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Закройте другие вкладки приложения и повторите сохранение.')); };
  });
}
async function transact(stores, mode, work, signal) {
  signal?.throwIfAborted();
  const db = await database();
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result, failure;
      const abort = () => { failure = signal.reason; try { tx.abort(); } catch {} };
      const finish = () => signal?.removeEventListener('abort', abort);
      tx.oncomplete = () => { finish(); resolve(result); };
      tx.onabort = tx.onerror = () => { finish(); reject(failure || tx.error || new Error('Не удалось сохранить данные на телефоне.')); };
      signal?.addEventListener('abort', abort, { once: true });
      try { work(tx, value => { result = value; }, error => { failure = error; tx.abort(); }); }
      catch (error) { failure = error; tx.abort(); }
    });
  } finally { db.close(); }
}
function getRecord(store, key, signal) {
  return transact([store], 'readonly', (tx, done) => {
    tx.objectStore(store).get(key).onsuccess = event => done(event.target.result);
  }, signal);
}
const generation = (source, resPath, signal) => getRecord('generations', copyKey(source, resPath), signal).then(value => value || 0);

export async function listOfflineCopies(source) {
  return transact(['metadata'], 'readonly', (tx, done) => {
    const groups = new Map();
    const request = tx.objectStore('metadata').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { done([...groups.values()]); return; }
      const item = cursor.value;
      if (item.source === source) {
        if (!groups.has(item.resPath)) groups.set(item.resPath, { resPath: item.resPath, bytes: 0, savedAt: 0, files: [] });
        const group = groups.get(item.resPath);
        group.bytes += item.bytes; group.savedAt = Math.max(group.savedAt, item.savedAt || 0); group.files.push(item);
      }
      cursor.continue();
    };
  });
}

// Commit a whole download together. Quota errors or cancellation retain the old copy.
function savePackages(source, resPath, entries, expectedGeneration, { signal, replaceAll = false } = {}) {
  return transact(['packages', 'metadata', 'generations'], 'readwrite', (tx, done, fail) => {
    const packages = tx.objectStore('packages'), info = tx.objectStore('metadata');
    tx.objectStore('generations').get(copyKey(source, resPath)).onsuccess = event => {
      if ((event.target.result || 0) !== expectedGeneration) { fail(new DOMException('Копия была удалена.', 'AbortError')); return; }
      const keys = new Set(entries.map(entry => packageKey({ source, ...entry })));
      const roles = new Set(entries.map(entry => entry.role));
      const request = info.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const old = cursor.value;
        if (old.source === source && old.resPath === resPath && (replaceAll || roles.has(old.role)) && !keys.has(cursor.key)) {
          packages.delete(cursor.key); cursor.delete();
        }
        cursor.continue();
      };
      try {
        for (const { path, role, value } of entries) {
          const key = packageKey({ source, path, role });
          packages.put(value, key); info.put(metadata(key, value), key);
        }
        done(true);
      } catch (error) { fail(error); }
    };
  }, signal);
}

export function deleteOfflineCopy(source, resPath) {
  return transact(['packages', 'metadata', 'generations'], 'readwrite', (tx, done) => {
    const generations = tx.objectStore('generations'), key = copyKey(source, resPath);
    generations.get(key).onsuccess = event => generations.put((event.target.result || 0) + 1, key);
    const request = tx.objectStore('metadata').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { done(true); return; }
      if (cursor.value.source === source && cursor.value.resPath === resPath) {
        tx.objectStore('packages').delete(cursor.key); cursor.delete();
      }
      cursor.continue();
    };
  });
}

async function networkPackage({ path, role, saved, signal, fresh = false }) {
  signal?.throwIfAborted();
  if (!globalThis.navigator.onLine) throw new Error('Нет подключения к сети.');
  const url = new URL('./api/prepared', globalThis.location.href);
  url.searchParams.set('path', path); url.searchParams.set('role', role);
  const response = await fetch(url, { cache: 'no-store', signal: requestSignal(signal, 150000),
    headers: saved?.revision ? { 'If-None-Match': `"${saved.revision}"` } : {} });
  signal?.throwIfAborted();
  const stale = response.headers.get('X-Prepared-Stale') === '1';
  if (fresh && stale) throw new Error('В базе пока старая версия. Повторите обновление позже.');
  if (response.status === 304 && saved) return { ...saved, stale, savedAt: Date.now() };
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw Object.assign(new Error((problem.code === 'memory_limit' ? 'MEMORY_LIMIT: ' : '') + (problem.error || 'Подготовленные данные пока недоступны.')),{status:response.status,code:problem.code});
  }
  if (!response.headers.get('content-type')?.includes('application/json') || !response.headers.get('X-Prepared-Revision'))
    throw new Error('Неизвестный ответ сервера при сохранении данных.');
  const body = await response.blob();
  signal?.throwIfAborted();
  return { body, revision: response.headers.get('X-Prepared-Revision'), savedAt: Date.now(), stale };
}

export async function fetchPrepared({ source, path, role, signal, offlineOnly = false }) {
  const resPath = parentPath(path), key = packageKey({ source, path, role });
  const expected = await generation(source, resPath, signal).catch(() => null);
  const saved = await getRecord('packages', key, signal).catch(() => null);
  signal?.throwIfAborted();
  if (offlineOnly) {
    if (!saved || expected === null || await generation(source, resPath, signal) !== expected)
      throw new Error('На телефоне нет сохранённой копии этого файла. Скачайте РЭС заново при наличии связи.');
    const data = JSON.parse(await saved.body.text());
    signal?.throwIfAborted();
    if (data.format !== 1 || data.role !== role) throw new Error('Сохранённая копия повреждена. Скачайте РЭС заново при наличии связи.');
    return { data, offline:true, cached:true, savedAt:saved.savedAt, revision:saved.revision, stale:saved.stale };
  }
  try {
    const value = await networkPackage({ path, role, saved, signal });
    const data = JSON.parse(await value.body.text());
    signal?.throwIfAborted();
    if (data.format !== 1 || data.role !== role) throw new Error('Неизвестный формат подготовленных данных.');
    let cached = false;
    if (expected !== null) {
      try { await savePackages(source, resPath, [{ path, role, value }], expected, { signal }); cached = true; }
      catch (error) { if (error.name === 'AbortError') throw error; /* Online use still works with a full phone. */ }
    }
    return { data, offline: false, cached, savedAt: value.savedAt, revision: value.revision, stale: value.stale };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === 'AbortError' || [401,403].includes(error.status) || error.code==='res_changed' || !saved || await generation(source, resPath, signal).catch(() => null) !== expected) throw error;
    return { data: JSON.parse(await saved.body.text()), offline: true, cached: true, savedAt: saved.savedAt, revision: saved.revision, stale: saved.stale };
  }
}

export async function downloadOfflineCopy({ source, resPath, files, signal, onProgress = () => {} }) {
  if (!files.length || files.some(file => parentPath(file.path) !== resPath || !['registry', 'consumption', 'incoming'].includes(file.role)))
    throw new Error('Для этой РЭС нет доступных файлов.');
  const expected = await generation(source, resPath, signal);
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const { path, role } = files[i];
    signal?.throwIfAborted(); onProgress({ index: i + 1, total: files.length, role });
    const saved = await getRecord('packages', packageKey({ source, path, role }), signal);
    const value = await networkPackage({ path, role, saved, signal, fresh: true });
    entries.push({ path, role, value });
  }
  signal?.throwIfAborted();
  const estimate = await globalThis.navigator.storage?.estimate?.().catch(() => null);
  if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) {
    const old = (await listOfflineCopies(source)).find(copy => copy.resPath === resPath)?.bytes || 0;
    const additional = Math.max(0, entries.reduce((total, entry) => total + entry.value.body.size, 0) - old);
    if (additional > estimate.quota - estimate.usage) throw new DOMException('Недостаточно места на телефоне.', 'QuotaExceededError');
  }
  await savePackages(source, resPath, entries, expected, { signal, replaceAll: true });
  return { bytes: entries.reduce((total, entry) => total + entry.value.body.size, 0), savedAt: Date.now() };
}
