import { gzipSync } from 'node:zlib';
import { readBoundedBuffer } from './public/download-buffer.js';
import { findSource } from './public/source.js';
import { prepareWorkbook } from './prepared-workbook.mjs';

const maxBytes = 40 * 1048576;
const api = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const validDownloadUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['yandex.ru','yandex.net','yandex.com','yandexdisk.com'].some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch { return false; }
};
export const revisionOf = meta => JSON.stringify([meta.md5 || meta.sha256 || '', meta.modified || '', meta.size]);

export function createPreparedService({ source, store, yandex }) {
  const pending = new Map();
  let queue = Promise.resolve(), syncing = false;
  const responseFrom = (entry, stale = false) => ({ revision: entry.revision,
    payload: gzipSync(JSON.stringify(entry.data)), updated_at: entry.updated_at, stale });
  function target(path, suffix = '') {
    const url = new URL(api + suffix); url.searchParams.set('public_key', source); url.searchParams.set('path', path); return url;
  }
  async function download(path, size) {
    const { href } = await (await yandex(target(path, '/download'))).json();
    let address = href;
    for (let i = 0; i < 4; i++) {
      if (!validDownloadUrl(address)) throw new Error('Яндекс Диск вернул неподдерживаемый адрес скачивания.');
      const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(90000) });
      if (response.status >= 300 && response.status < 400) { address = new URL(response.headers.get('location'), address).href; await response.body?.cancel(); continue; }
      if (!response.ok) throw new Error('Не удалось скачать Excel с Яндекс Диска.');
      return readBoundedBuffer(response, maxBytes, size);
    }
    throw new Error('Слишком много перенаправлений при скачивании.');
  }
  async function load(path, role) {
    const key = role + ':' + path;
    if (!pending.has(key)) {
      const work = (async () => {
        const previous = await store.get(source, path, role);
        let meta;
        try { meta = await (await yandex(target(path))).json(); }
        catch (error) { if (previous) return { ...previous, stale: true }; throw error; }
        if (meta.type !== 'file' || !/\.xlsx?$/i.test(meta.name || '') || !Number.isFinite(meta.size) || meta.size > maxBytes) throw new Error('Файл Excel недоступен или превышает 40 МБ.');
        const revision = revisionOf(meta);
        if (previous?.revision === revision) return previous;
        // A single Excel parse at a time prevents 2–5 concurrent visitors from
        // multiplying peak memory during a cache miss.
        const task = async () => {
          const current = await store.get(source, path, role);
          if (current?.revision === revision) return current;
          const buffer = await download(path, meta.size);
          const pack = prepareWorkbook(buffer, role, meta.name);
          await store.put(source, path, role, revision, pack);
          return { revision, data: pack, updated_at: new Date() };
        };
        const next = queue.then(task); queue = next.catch(() => {});
        try { return await next; } catch (error) { if (previous) return { ...previous, stale: true }; throw error; }
      })().finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return pending.get(key);
  }
  async function fromDatabase(path, role, etag) {
    if (etag && store.getRevision) {
      const revision = await store.getRevision(source, path, role);
      if (revision && etag === `"${Buffer.from(revision).toString('base64url')}"`) return { revision, unchanged: true };
    }
    const saved = await store.get(source, path, role);
    const entry = saved || await load(path, role);
    return responseFrom(entry, Boolean(entry.stale));
  }
  async function list(path) {
    const items = []; let offset = 0;
    do {
      const url = target(path); url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset));
      const data = await (await yandex(url)).json();
      if (data.type !== 'dir') throw new Error('Ожидалась папка РЭС.');
      const page = data._embedded?.items || []; items.push(...page); offset += page.length;
      if (!page.length || offset >= (data._embedded?.total ?? offset)) break;
      if (offset > 10000) throw new Error('Слишком много файлов в папке.');
    } while (true);
    return items;
  }
  async function syncAll() {
    if (syncing) return;
    syncing = true;
    try {
      const seen = [];
      for (const enterprise of (await list('/')).filter(x => x.type === 'dir')) {
        for (const res of (await list(enterprise.path)).filter(x => x.type === 'dir')) {
          const files = await list(res.path);
          const statuses = {};
          for (const role of ['registry','consumption','incoming']) {
            const file = findSource(files, role);
            if (!file) { statuses[role] = { state: 'missing' }; continue; }
            try {
              const result = await load(file.path, role);
              statuses[role] = { state: result.stale ? 'stale' : 'ready', file: file.name, path: file.path,
                size: file.size, modified: file.modified, updatedAt: result.updated_at };
            } catch (error) {
              statuses[role] = { state: 'error', file: file.name, path: file.path, size: file.size, modified: file.modified };
              console.warn(`Подготовка ${role} в ${res.path}: ${error.message}`);
            }
          }
          await store.putFolder?.(source, { path: res.path, name: res.name,
            enterprisePath: enterprise.path, enterpriseName: enterprise.name }, statuses);
          seen.push(res.path);
        }
      }
      await store.pruneFolders?.(source, seen);
    } finally { syncing = false; }
  }
  return { load, fromDatabase, syncAll };
}
