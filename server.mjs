import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

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
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function yandex(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'error' });
  if (!response.ok) {
    const messages = { 404: 'Папка или файл не найдены. Проверьте публичную ссылку.', 403: 'Яндекс Диск запретил скачивание. Проверьте доступ по ссылке.', 429: 'Яндекс Диск временно ограничил запросы. Повторите чуть позже.' };
    throw Object.assign(new Error(messages[response.status] || 'Не удалось получить ответ Яндекс Диска.'), { status: response.status === 404 ? 404 : 502 });
  }
  return response;
}
function authorized(req) {
  if (!process.env.APP_USER || !process.env.APP_PASSWORD) return true;
  const expected = Buffer.from(`Basic ${Buffer.from(`${process.env.APP_USER}:${process.env.APP_PASSWORD}`).toString('base64')}`);
  const actual = Buffer.from(req.headers.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.yandex.net https://*.yandex.ru https://*.yandex.com https://*.yandexdisk.com; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Abonent", charset="UTF-8"' }); res.end('Требуется вход'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { sendJson(res, 405, { error: 'Метод не поддерживается.' }); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/config') { sendJson(res, 200, { publicUrl: process.env.YANDEX_PUBLIC_URL || '', proxy: true, maxFileMB: 40 }); return; }
      if (url.pathname === '/api/resources' || url.pathname === '/api/download') {
        const key = process.env.YANDEX_PUBLIC_URL || url.searchParams.get('public_key') || '';
        if (!validPublicUrl(key)) { sendJson(res, 400, { error: 'Укажите публичную ссылку на папку Яндекс Диска.' }); return; }
        const path = url.searchParams.get('path') || '/';
        if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..') || path.length > 4096) { sendJson(res, 400, { error: 'Некорректный путь.' }); return; }
        const target = new URL(api + (url.pathname === '/api/download' ? '/download' : ''));
        target.searchParams.set('public_key', key); target.searchParams.set('path', path);
        if (url.pathname === '/api/resources') {
          target.searchParams.set('limit', '100');
          target.searchParams.set('offset', String(Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0))));
          target.searchParams.set('sort', 'name');
          sendJson(res, 200, await (await yandex(target)).json()); return;
        }
        const { href } = await (await yandex(target)).json();
        let download = href, response;
        for (let redirect = 0; redirect < 4; redirect++) {
          if (!validDownloadUrl(download)) throw new Error('Яндекс Диск вернул неподдерживаемый адрес скачивания.');
          response = await fetch(download, { signal: AbortSignal.timeout(90000), redirect: 'manual' });
          if (response.status >= 300 && response.status < 400) { download = new URL(response.headers.get('location'), download).href; await response.body?.cancel(); continue; }
          break;
        }
        if (!response?.ok) throw new Error('Не удалось скачать реестр с Яндекс Диска.');
        if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); sendJson(res, 413, { error: 'Размер реестра превышает 40 МБ.' }); return; }
        let size = 0;
        const limiter = new Transform({ transform(chunk, _, callback) { size += chunk.length; callback(size > maxBytes ? new Error('Размер файла превышает 40 МБ.') : null, chunk); } });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
        await pipeline(Readable.fromWeb(response.body), limiter, res); return;
      }
      const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { sendJson(res, 403, { error: 'Нет доступа.' }); return; }
      const info = await stat(path);
      if (!info.isFile()) { sendJson(res, 404, { error: 'Страница не найдена.' }); return; }
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(path), res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, error.code === 'ENOENT' ? 404 : error.status || 502, { error: error.code === 'ENOENT' ? 'Страница не найдена.' : error.message || 'Сервис временно недоступен.' });
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Boolean(process.env.APP_USER) !== Boolean(process.env.APP_PASSWORD)) throw new Error('APP_USER и APP_PASSWORD нужно задавать вместе.');
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '0.0.0.0', () => console.log(`Абонент: порт ${port}`));
}
