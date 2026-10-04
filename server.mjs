import http from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createPreparedStore } from './prepared-store.mjs';
import { createPreparedService } from './prepared-service.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const maxBytes = 40 * 1024 * 1024;
const api = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
export function validPublicUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['disk.yandex.ru', 'disk.yandex.com', 'disk.yandex.net', 'disk.360.yandex.ru', 'yadi.sk'].includes(u.hostname) && /^\/(d|i)\/[\w-]+\/?$/.test(u.pathname); } catch { return false; }
}
export function validDownloadUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['yandex.ru', 'yandex.net', 'yandex.com', 'yandexdisk.com'].some(h => u.hostname === h || u.hostname.endsWith(`.${h}`)); } catch { return false; }
}
function databaseIssue(error) {
  if (!error) return 'unavailable';
  if (/^Отсутствуют переменные:/.test(error.message)) return 'incomplete_config';
  if (/^DB_PORT/.test(error.message)) return 'invalid_port';
  if (error.code === '28P01' || error.code === '28000') return 'authentication';
  if (error.code === '3D000') return 'database_missing';
  if (error.code === '42501') return 'permission';
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'host';
  if (['ECONNREFUSED','ETIMEDOUT','ENETUNREACH'].includes(error.code)) return 'network';
  if (error.code === '53300') return 'connection_limit';
  return 'unavailable';
}
function sourceIssue(error) {
  if (error?.upstreamStatus === 404) return 'not_found';
  if (error?.upstreamStatus === 403) return 'access_denied';
  if (error?.upstreamStatus === 429) return 'rate_limited';
  return 'unavailable';
}
function preparedDirectory(folders, path, offset) {
  let items;
  if (path === '/') items = [...new Map(folders.map(f => [f.enterprise_path,
    { type:'dir', path:f.enterprise_path, name:f.enterprise_name }])).values()];
  else if (folders.some(f => f.enterprise_path === path)) items = folders.filter(f => f.enterprise_path === path)
    .map(f => ({ type:'dir', path:f.res_path, name:f.res_name }));
  else {
    const folder = folders.find(f => f.res_path === path);
    if (folder) items = [...new Map(Object.values(folder.statuses || {}).filter(s => s.path)
      .map(s => [s.path,{ type:'file',path:s.path,name:s.file,size:s.size,modified:s.modified }])).values()];
    else {
      const file = folders.flatMap(f => Object.values(f.statuses || {})).find(s => s.path === path);
      return file ? { type:'file', path, name:file.file, size:file.size, modified:file.modified } : null;
    }
  }
  items.sort((a,b) => a.name.localeCompare(b.name,'ru'));
  return { type:'dir',path,_embedded:{items:items.slice(offset,offset+100),total:items.length} };
}
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function yandex(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'error' });
  if (!response.ok) {
    const messages = { 404: 'Папка или файл не найдены. Проверьте публичную ссылку.', 403: 'Яндекс Диск запретил скачивание. Проверьте доступ по ссылке.', 429: 'Яндекс Диск временно ограничил запросы. Повторите чуть позже.' };
    throw Object.assign(new Error(messages[response.status] || 'Не удалось получить ответ Яндекс Диска.'), { status: response.status === 404 ? 404 : 502, upstreamStatus: response.status });
  }
  return response;
}
function authorized(req) {
  if (!process.env.APP_USER || !process.env.APP_PASSWORD) return true;
  const expected = Buffer.from(`Basic ${Buffer.from(`${process.env.APP_USER}:${process.env.APP_PASSWORD}`).toString('base64')}`);
  const actual = Buffer.from(req.headers.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createServer(options = {}) {
  // Amvera injects this once for the whole application, not separately per device.
  const configuredUrl = (process.env.YANDEX_PUBLIC_URL || '').trim();
  const configured = validPublicUrl(configuredUrl);
  const key = configured ? new URL(configuredUrl).origin + new URL(configuredUrl).pathname : '';
  // Coalesce only simultaneous metadata calls. No file contents or subscriber
  // state are shared, and completed responses are not cached between refreshes.
  const pendingMetadata = new Map();
  function metadata(url) {
    const key = String(url);
    if (!pendingMetadata.has(key)) {
      const pending = yandex(url).then(response => response.json()).finally(() => pendingMetadata.delete(key));
      pendingMetadata.set(key, pending);
    }
    return pendingMetadata.get(key);
  }
  const store = options.preparedStore || createPreparedStore();
  const prepared = store && createPreparedService({ source: key, store, yandex });
  let databaseConnected = Boolean(store && !store.ready);
  let syncStatus = { state: 'waiting', checkedAt: null, issue: null };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.yandex.net https://*.yandex.ru https://*.yandex.com https://*.yandexdisk.com; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Abonent", charset="UTF-8"' }); res.end('Требуется вход'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { sendJson(res, 405, { error: 'Метод не поддерживается.' }); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/config') { sendJson(res, 200, { publicUrl: key, configured, proxy: true, maxFileMB: 40, prepared: Boolean(prepared), databaseConnected }); return; }
      if (url.pathname === '/api/diagnostics') {
        let database = { state: 'not_configured', issue: 'not_configured' }, catalog = { state: 'unavailable' };
        if (store) {
          try {
            await store.ready?.();
            databaseConnected = true;
            database = { state: 'connected', issue: null };
            if (configured && store.listFolders) {
              const folders = await store.listFolders(key);
              catalog = { state: folders.length ? 'ready' : 'empty', resCount: folders.length,
                enterpriseCount: new Set(folders.map(folder => folder.enterprise_path)).size };
            }
          } catch (error) {
            databaseConnected = false;
            database = { state: 'error', issue: databaseIssue(error) };
          }
        }
        sendJson(res, 200, { source: { state: configured ? 'configured' : 'error', issue: configured ? null : configuredUrl ? 'invalid_url' : 'not_configured' },
          database, catalog, sync: syncStatus }); return;
      }
      if (url.pathname === '/api/load-map') {
        if (!prepared || !store.listFolders) { sendJson(res, 503, { error: 'Карта загрузки доступна после подключения базы данных.' }); return; }
        sendJson(res, 200, { folders: await store.listFolders(key) }); return;
      }
      if (url.pathname === '/api/directory') {
        if (!prepared || !store.listFolders) { sendJson(res, 503, { error: 'Каталог базы ещё не готов.' }); return; }
        const path = url.searchParams.get('path') || '/';
        if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..') || path.length > 4096) { sendJson(res, 400, { error: 'Некорректный путь.' }); return; }
        const folders = await store.listFolders(key);
        const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
        const data = folders.length && preparedDirectory(folders,path,offset);
        if (!data) { sendJson(res, folders.length ? 404 : 503, { error: 'Каталог базы ещё не готов для этой папки.' }); return; }
        sendJson(res, 200, data); return;
      }
      if (url.pathname === '/api/prepared') {
        if (!prepared) { sendJson(res, 503, { error: 'Серверная подготовка ещё не подключена.' }); return; }
        const path = url.searchParams.get('path') || '';
        const role = url.searchParams.get('role') || '';
        if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..') || path.length > 4096 || !['registry','consumption','incoming'].includes(role) || !/\.xlsx?$/i.test(path)) { sendJson(res, 400, { error: 'Некорректный запрос.' }); return; }
        try {
          if (req.method === 'HEAD') {
            const snapshot = await (store.getMeta ? store.getMeta(key, path, role) : store.get(key, path, role));
            if (!snapshot) { res.writeHead(404, { 'Cache-Control':'no-store' }); res.end(); return; }
            const revision = Buffer.from(snapshot.revision).toString('base64url');
            res.writeHead(req.headers['if-none-match'] === `"${revision}"` ? 304 : 200,
              { 'ETag':`"${revision}"`, 'Cache-Control':'no-store' }); res.end(); return;
          }
          const result = await prepared.fromDatabase(path, role, req.headers['if-none-match']);
          if (res.destroyed) return;
          const revision = Buffer.from(result.revision).toString('base64url');
          if (req.headers['if-none-match'] === `"${revision}"`) {
            res.writeHead(304, { 'ETag': `"${revision}"`, 'Cache-Control': 'no-store' }); res.end(); return;
          }
          res.writeHead(200, { 'Content-Type': types['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'ETag': `"${revision}"`, 'X-Prepared-Revision': revision, 'X-Prepared-Stale': result.stale ? '1' : '0' });
          if (req.method === 'HEAD') res.end(); else res.end(result.payload);
        } catch (error) {
          console.warn('Не удалось подготовить Excel:', error.message);
          if (/памяти|Пакет Excel превышает лимит/i.test(error.message)) {
            sendJson(res, 503, { code: 'memory_limit', error: 'Для подготовки этой книги не хватает памяти Amvera. Нужен тариф с большей памятью или меньший файл.' });
          } else sendJson(res, 502, { error: 'Не удалось подготовить Excel на сервере. Проверьте файл или повторите позже.' });
        }
        return;
      }
      if (url.pathname === '/api/resources' || url.pathname === '/api/download') {
        if (!configured) { sendJson(res, 503, { error: 'Общая папка не подключена. Обратитесь к администратору приложения.', code: configuredUrl ? 'source_invalid' : 'source_not_configured' }); return; }
        const path = url.searchParams.get('path') || '/';
        if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..') || path.length > 4096) { sendJson(res, 400, { error: 'Некорректный путь.' }); return; }
        const target = new URL(api + (url.pathname === '/api/download' ? '/download' : ''));
        target.searchParams.set('public_key', key); target.searchParams.set('path', path);
        if (url.pathname === '/api/resources') {
          target.searchParams.set('limit', '100');
          target.searchParams.set('offset', String(Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0))));
          target.searchParams.set('sort', 'name');
          sendJson(res, 200, await metadata(target)); return;
        }
        const { href } = await metadata(target);
        if (res.destroyed || req.aborted) return;
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableFinished) controller.abort(); };
        req.on('aborted', disconnected); res.on('close', disconnected);
        try {
          let download = href, response;
          for (let redirect = 0; redirect < 4; redirect++) {
            if (!validDownloadUrl(download)) throw new Error('Яндекс Диск вернул неподдерживаемый адрес скачивания.');
            response = await fetch(download, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]), redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get('location');
              if (!location) throw new Error('Адрес перенаправления отсутствует.');
              download = new URL(location, download).href; await response.body?.cancel(); continue;
            }
            break;
          }
          if (!response?.ok) { await response?.body?.cancel(); throw new Error('Не удалось скачать реестр с Яндекс Диска.'); }
          const lengthHeader = response.headers.get('content-length'), length = Number(lengthHeader);
          if (length > maxBytes) { await response.body?.cancel(); sendJson(res, 413, { error: 'Размер реестра превышает 40 МБ.' }); return; }
          let size = 0;
          const limiter = new Transform({ transform(chunk, _, callback) { size += chunk.length; callback(size > maxBytes ? new Error('Размер файла превышает 40 МБ.') : null, chunk); } });
          const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
          if (lengthHeader && Number.isSafeInteger(length) && length >= 0 && (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity')) headers['Content-Length'] = length;
          res.writeHead(200, headers);
          await pipeline(Readable.fromWeb(response.body), limiter, res, { signal: controller.signal }); return;
        } finally {
          controller.abort(); req.off('aborted', disconnected); res.off('close', disconnected);
        }
      }
      const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { sendJson(res, 403, { error: 'Нет доступа.' }); return; }
      const info = await stat(path);
      if (!info.isFile()) { sendJson(res, 404, { error: 'Страница не найдена.' }); return; }
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(path), res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof URIError || error.code === 'ERR_INVALID_ARG_VALUE') { sendJson(res, 400, { error: 'Некорректный адрес.' }); return; }
      if (error.code === 'ENOENT') { sendJson(res, 404, { error: 'Страница не найдена.' }); return; }
      if (!error.status) console.warn('Ошибка запроса:', error.message);
      sendJson(res, error.status || 502, { error: error.status ? error.message : 'Сервис временно недоступен.' });
    }
  });
  server.preparedService = prepared;
  server.preparedStore = store;
  server.setDatabaseStatus = value => { databaseConnected = Boolean(value); };
  server.setSyncStatus = status => { syncStatus = { ...status }; };
  server.on('close', () => { Promise.resolve(store?.close?.()).catch(() => {}); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Boolean(process.env.APP_USER) !== Boolean(process.env.APP_PASSWORD)) throw new Error('APP_USER и APP_PASSWORD нужно задавать вместе.');
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  let connected = false;
  const checkDb = async () => {
    try {
      await server.preparedStore.ready();
      if (!connected) console.log('DB connected');
      connected = true;
      server.setDatabaseStatus(true);
      return true;
    } catch (error) { connected = false; server.setDatabaseStatus(false); console.error('DB error:', error.message); }
    return false;
  };
  server.listen(port, '0.0.0.0', () => console.log(`Абонент: порт ${port}`));
  // Serve the shell and diagnostics even while PostgreSQL is slow or unavailable.
  if (server.preparedStore) await checkDb();
  else console.error('DB error: задайте DB_HOST, DB_PORT, DB_NAME, DB_USER и DB_PASSWORD.');
  if (server.preparedStore && server.preparedService) {
    const sync = async () => {
      if (!await checkDb()) return;
      server.setSyncStatus({ state: 'running', checkedAt: new Date().toISOString(), issue: null });
      try { await server.preparedService.syncAll({ prepare: false }); server.setSyncStatus({ state: 'ready', checkedAt: new Date().toISOString(), issue: null }); }
      catch (error) { server.setSyncStatus({ state: 'error', checkedAt: new Date().toISOString(), issue: sourceIssue(error) }); console.warn('Обновление данных:', error.message); }
    };
    // Only catalog metadata runs unattended on the 512 MB plan. A selected
    // workbook is prepared on demand in the bounded child process.
    setTimeout(sync, 5000).unref();
    setInterval(sync, 15 * 60 * 1000).unref();
  }
}
