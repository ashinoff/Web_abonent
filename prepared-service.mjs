import { gzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSource } from './public/source.js';

const maxBytes = 40 * 1048576;
const compress = promisify(gzip);
const childPath = fileURLToPath(new URL('./prepare-child.mjs', import.meta.url));
async function memoryBudget() {
  let detected;
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = Number((await readFile(path, 'utf8')).trim());
      if (Number.isSafeInteger(value) && value >= 256 * 1048576 && value < 1024 ** 4) {
        detected = Math.floor(value / 1048576); break;
      }
    } catch { /* Local development may have no cgroup limit. */ }
  }
  const override = Number(process.env.PREPARE_MEMORY_MB);
  const configured = Number.isInteger(override) && override >= 512 && override <= 8192 ? override : null;
  return Math.min(8192, Math.max(256, detected ? Math.min(detected, configured || detected) : configured || 512));
}
export function preparationLimits(containerMB) {
  const heapMB = Math.min(768, 128 + Math.floor(Math.max(0, containerMB - 512) * 0.35));
  const childMB = Math.min(1200, 160 + Math.floor(Math.max(0, containerMB - 512) * 0.5));
  const combinedMB = Math.max(160, Math.min(containerMB - 192, Math.floor(containerMB * 0.8)));
  const packageMB = Math.min(256, Math.max(64, Math.floor(containerMB / 8)));
  return { heapMB, childMB, combinedMB, packageMB };
}
function runLimitedChild(args, containerMB) {
  const { heapMB, childMB, combinedMB } = preparationLimits(containerMB);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMB}`, childPath, ...args],
      { stdio: ['ignore','ignore','pipe'], env: { PATH: process.env.PATH || '', TZ: process.env.TZ || 'UTC' } });
    let stderr = '', reason = null, checking = false;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const timeout = setTimeout(() => { reason = 'Подготовка Excel превысила 120 секунд.'; child.kill('SIGKILL'); }, 120000);
    // V8 heap limits do not cover workbook buffers and native allocations.
    // Watch actual RSS before the 512 MB container OOM killer acts.
    const monitor = setInterval(async () => {
      if (checking || !child.pid || reason) return;
      checking = true;
      try {
        const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
        const kib = Number(status.match(/^VmRSS:\s*(\d+)\s*kB/m)?.[1]);
        if (kib && (kib > childMB * 1024 || kib * 1024 + process.memoryUsage().rss > combinedMB * 1048576)) {
          reason = 'Недостаточно памяти для подготовки этого Excel на текущем тарифе.';
          child.kill('SIGKILL');
        }
      } catch { /* A completed child may disappear before the next sample. */ }
      finally { checking = false; }
    }, 25);
    child.on('error', error => { reason ||= error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout); clearInterval(monitor);
      if (reason || code !== 0) reject(new Error(reason || stderr.trim() || `Подготовка завершилась (${signal || code}).`));
      else resolve();
    });
  });
}
const api = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const validDownloadUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['yandex.ru','yandex.net','yandex.com','yandexdisk.com'].some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch { return false; }
};
export const revisionOf = meta => JSON.stringify([meta.md5 || meta.sha256 || '', meta.modified || '', meta.size]);

export function createPreparedService({ source, store, yandex }) {
  const pending = new Map(), pendingResponses = new Map(), metadataChecked = new Map();
  let queue = Promise.resolve(), responseQueue = Promise.resolve(), syncing = false, preparing = false;
  const responseFrom = async (entry, stale = false) => ({ revision: entry.revision,
    payload: await compress(entry.json ?? JSON.stringify(entry.data)), updated_at: entry.updated_at, stale });
  function target(path, suffix = '') {
    const url = new URL(api + suffix); url.searchParams.set('public_key', source); url.searchParams.set('path', path); return url;
  }
  async function download(path, size, destination) {
    const { href } = await (await yandex(target(path, '/download'))).json();
    let address = href;
    for (let i = 0; i < 4; i++) {
      if (!validDownloadUrl(address)) throw new Error('Яндекс Диск вернул неподдерживаемый адрес скачивания.');
      const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(90000) });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Адрес перенаправления отсутствует.');
        address = new URL(location, address).href; await response.body?.cancel(); continue;
      }
      if (!response.ok) throw new Error('Не удалось скачать Excel с Яндекс Диска.');
      if (size > maxBytes || Number(response.headers.get('content-length')) > maxBytes)
        throw new Error('Размер Excel превышает 40 МБ.');
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error('Размер Excel превышает 40 МБ.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination));
      return;
    }
    throw new Error('Слишком много перенаправлений при скачивании.');
  }
  async function prepare(directory, role, filename) {
    try {
      const path = join(directory, 'workbook');
      const output = join(directory, 'package.json');
      const containerMB = await memoryBudget();
      await runLimitedChild([path, output, role, filename], containerMB);
      const { packageMB } = preparationLimits(containerMB);
      if ((await stat(output)).size > packageMB * 1048576) throw new Error(`Пакет Excel превышает лимит ${packageMB} МБ.`);
      return readFile(output, 'utf8');
    } catch (error) {
      if (/heap out of memory|allocation failed/i.test(error.message || ''))
        throw new Error('Файл превышает доступный лимит памяти подготовки Excel.');
      throw new Error((error.message || 'Ошибка подготовки Excel.').trim().slice(0, 400));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const readMeta = (path, role) => store.getMeta ? store.getMeta(source, path, role) : store.get(source, path, role);
  async function load(path, role) {
    const key = role + ':' + path;
    if (!pending.has(key)) {
      const work = (async () => {
        const previous = await readMeta(path, role);
        let meta;
        try { meta = await (await yandex(target(path))).json(); }
        catch (error) { if (previous) return { ...previous, stale: true }; throw error; }
        if (meta.type !== 'file' || !/\.xlsx?$/i.test(meta.name || '') || !Number.isFinite(meta.size) || meta.size > maxBytes) throw new Error('Файл Excel недоступен или превышает 40 МБ.');
        const revision = revisionOf(meta);
        if (previous?.revision === revision) {
          await store.markFile?.(source, path, role, 'ready', previous.updated_at);
          return previous;
        }
        // A single Excel parse at a time prevents 2–5 concurrent visitors from
        // multiplying peak memory during a cache miss.
        const task = async () => {
          const current = await readMeta(path, role);
          if (current?.revision === revision) {
            await store.markFile?.(source, path, role, 'ready', current.updated_at);
            return current;
          }
          const directory = await mkdtemp(join(tmpdir(), 'abonent-prepare-'));
          let json;
          try {
            await download(path, meta.size, join(directory, 'workbook'));
            json = await prepare(directory, role, meta.name);
          } catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw error;
          }
          if (store.putRaw) await store.putRaw(source, path, role, revision, json);
          else await store.put(source, path, role, revision, JSON.parse(json));
          await store.markFile?.(source, path, role, 'ready', new Date());
          return { revision, updated_at: new Date() };
        };
        const next = queue.then(task); queue = next.catch(() => {});
        try { return await next; } catch (error) { if (previous) return { ...previous, stale: true }; throw error; }
      })().finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return pending.get(key);
  }
  function fromDatabase(path, role, etag) {
    const key = JSON.stringify([path, role, etag]);
    if (!pendingResponses.has(key)) {
      const work = (async () => {
        let stale = false;
        const meta = store.getMeta ? await readMeta(path, role) : null;
        const checkedKey = `${role}:${path}`;
        if (meta && Date.now() - new Date(meta.updated_at).getTime() > 15 * 60 * 1000 &&
            Date.now() - (metadataChecked.get(checkedKey) || 0) > 15 * 60 * 1000) {
          metadataChecked.set(checkedKey, Date.now());
          stale = Boolean((await load(path, role)).stale);
        }
        if (etag && store.getRevision) {
          const revision = await store.getRevision(source, path, role);
          if (revision && etag === `"${Buffer.from(revision).toString('base64url')}"`) return { revision, unchanged: true };
        }
        if (store.getMeta && !meta) await load(path, role);
        // Database JSON and compression are large; bound them to one response
        // at a time even when several different RES are opened together.
        const next = responseQueue.then(async () => {
          const read = store.getJson || store.get;
          const saved = await read.call(store, source, path, role);
          const entry = saved || (await load(path, role), await read.call(store, source, path, role));
          return responseFrom(entry, stale || Boolean(entry.stale));
        });
        responseQueue = next.catch(() => {});
        return next;
      })().finally(() => pendingResponses.delete(key));
      pendingResponses.set(key, work);
    }
    return pendingResponses.get(key);
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
  async function syncAll({ prepare = true } = {}) {
    if (syncing) return;
    syncing = true;
    try {
      const seen = [];
      let partialError = null;
      const previousFolders = prepare || !store.listFolders ? new Map() :
        new Map((await store.listFolders(source)).map(folder => [folder.res_path, folder.statuses || {}]));
      const enterprises = (await list('/')).filter(x => x.type === 'dir');
      for (const enterprise of enterprises) {
        let resources;
        try { resources = (await list(enterprise.path)).filter(x => x.type === 'dir'); }
        catch (error) { partialError ||= error; console.warn(`Каталог ${enterprise.path}: ${error.message}`); continue; }
        for (const res of resources) {
          let files;
          try { files = await list(res.path); }
          catch (error) { partialError ||= error; console.warn(`Каталог ${res.path}: ${error.message}`); continue; }
          const statuses = {};
          for (const role of ['registry','consumption','incoming']) {
            const file = findSource(files, role);
            if (!file) { statuses[role] = { state: 'missing' }; continue; }
            if (!prepare) {
              const old = previousFolders.get(res.path)?.[role];
              const unchanged = old?.path === file.path && old?.modified === file.modified && old?.size === file.size;
              statuses[role] = { ...(unchanged ? old : {}), state: unchanged ? old.state : 'pending',
                file: file.name, path: file.path, size: file.size, modified: file.modified };
              continue;
            }
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
      if (seen.length && !partialError) await store.pruneFolders?.(source, seen);
      if (partialError) throw partialError;
    } finally { syncing = false; }
  }
  async function prepareNext() {
    if (syncing || preparing || !store.listFolders || !store.putFolder) return false;
    preparing = true;
    try {
      const folders = await store.listFolders(source);
      for (const folder of folders) {
        for (const role of ['registry', 'consumption', 'incoming']) {
          const status = folder.statuses?.[role];
          if (status?.state !== 'pending' || !status.path) continue;
          const statuses = { ...folder.statuses };
          try {
            const result = await load(status.path, role);
            statuses[role] = { ...status, state: result.stale ? 'stale' : 'ready', updatedAt: result.updated_at };
          } catch (error) {
            statuses[role] = { ...status, state: 'error' };
            console.warn(`Подготовка ${role} в ${folder.res_path}: ${error.message}`);
          }
          await store.putFolder(source, { path: folder.res_path, name: folder.res_name,
            enterprisePath: folder.enterprise_path, enterpriseName: folder.enterprise_name }, statuses);
          return true;
        }
      }
      return false;
    } finally { preparing = false; }
  }
  return { load, fromDatabase, syncAll, prepareNext };
}
