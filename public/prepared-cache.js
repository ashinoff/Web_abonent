const dbName = 'abonent-prepared-v1';
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('packages');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(key, operation, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('packages', operation === 'get' ? 'readonly' : 'readwrite');
      const request = tx.objectStore('packages')[operation](...(operation === 'get' ? [key] : [value, key]));
      if (operation === 'get') request.onsuccess = () => resolve(request.result);
      else tx.oncomplete = () => resolve(true);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function fetchPrepared({ source, path, role }) {
  const key = JSON.stringify([source, path, role]);
  const url = new URL('./api/prepared', self.location.href);
  url.searchParams.set('path', path); url.searchParams.set('role', role);
  const saved = await transaction(key, 'get').catch(() => null);
  try {
    if (!self.navigator.onLine) throw new Error('Нет подключения к сети.');
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(90000), headers: saved?.revision ? { 'If-None-Match': `"${saved.revision}"` } : {} });
    if (response.status === 304 && saved) return { data: JSON.parse(await saved.body.text()), offline: false, cached: true, savedAt: saved.savedAt };
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Подготовленные данные пока недоступны.');
    const body = await response.blob();
    const data = JSON.parse(await body.text());
    let cached = false;
    try { await transaction(key, 'put', { body, revision: response.headers.get('X-Prepared-Revision'), savedAt: Date.now() }); cached = true; }
    catch { /* Storage quota must not prevent online use. */ }
    return { data, offline: false, cached };
  } catch (error) {
    if (!saved) throw error;
    return { data: JSON.parse(await saved.body.text()), offline: true, cached: true, savedAt: saved.savedAt };
  }
}
