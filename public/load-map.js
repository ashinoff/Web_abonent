import { listOfflineCopies, downloadOfflineCopy, deleteOfflineCopy } from './prepared-cache.js';
import { sourceRoles as roles, folderSources, offlineCopyState, formatBytes, withLocalFolders, rememberMapDirectories, rememberOfflineFiles } from './offline-copies.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const states = { ready:'В базе', pending:'Ожидает подготовки', stale:'Старая версия', missing:'Нет файла', error:'Ошибка', unknown:'Нет в карте базы' };
const copyLabels = { ready:'Сохранено', partial:'Частично сохранено', stale:'Сохранена старая версия', missing:'Не скачано' };
const date = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle:'short', timeStyle:'short' }) : '—';

export function initLoadMap(root, { getFiles = folderSources, beforeDelete = () => {}, onCopiesChanged = () => {} } = {}) {
  const list = $('#load-map-list'), updated = $('#load-map-updated'), button = $('#load-map-refresh'), storage = $('#offline-storage');
  let loading = false, folders = [], copies = [], source = '', job = null, localVersion = 0;
  const messages = new Map();
  function render() {
    const open = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.enterprise));
    const focused = document.activeElement?.closest('[data-offline-action]');
    const focus = focused && { path: focused.dataset.resPath, action: focused.dataset.offlineAction };
    const all = withLocalFolders(folders, copies), groups = new Map();
    if (!all.length) { list.innerHTML = '<div class="load-map-empty">Карта ещё формируется. Сервер проверит папки после запуска; обновите этот экран чуть позже.</div>'; return; }
    for (const folder of all) {
      const key = folder.enterprise_path;
      if (!groups.has(key)) groups.set(key, { path: key, name: folder.enterprise_name, folders: [] });
      groups.get(key).folders.push(folder);
    }
    list.innerHTML = [...groups.values()].map(group => {
      const hasFiles = group.folders.some(folder => Object.values(folder.statuses || {}).some(item => item?.file || (item?.state && item.state !== 'missing')));
      return `<details class="load-map-enterprise" data-enterprise="${esc(group.path)}" ${open.has(group.path) ? 'open' : ''}><summary><i class="load-map-lamp" data-state="${hasFiles ? 'present' : 'empty'}" aria-hidden="true"></i><strong>${esc(group.name)}</strong><small>${group.folders.length} РЭС · ${hasFiles ? 'есть файлы' : 'нет файлов'}</small><svg class="load-map-chevron" aria-hidden="true"><use href="#i-chevron"/></svg></summary><div class="load-map-res-list">${group.folders.map(folder => {
        const statuses = folder.statuses || {}, files = getFiles(folder), copy = copies.find(item => item.resPath === folder.res_path);
        const ready = roles.filter(([key]) => statuses[key]?.state === 'ready').length;
        const state = offlineCopyState(copy, files), active = job?.source === source && job.resPath === folder.res_path;
        const controls = (action, label, disabled = false, extra = '') => `<button type="button" class="offline-action ${extra}" data-offline-action="${action}" data-res-path="${esc(folder.res_path)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        const status = messages.get(folder.res_path);
        return `<article class="load-map-res"><div class="load-map-res-title"><strong>${esc(folder.res_name)}</strong><small>${folder.localOnly ? 'Только на телефоне' : ready + ' из 3 готово'}</small></div><div class="load-map-statuses">${roles.map(([key,label]) => {
          const item = statuses[key] || { state:'missing' }, state = states[item.state] ? item.state : 'error';
          return `<span class="load-map-status" data-state="${state}" title="${esc(item.file || label)}"><i aria-hidden="true"></i>${label}: ${states[state]}</span>`;
        }).join('')}</div><small class="load-map-date">Проверено в базе: ${esc(date(folder.checked_at))}</small><div class="offline-copy" data-state="${state}"><span>На телефоне: <strong>${copyLabels[state]}</strong>${copy ? ' · ' + formatBytes(copy.bytes) : ''}</span>${copy ? '<small>' + esc(date(copy.savedAt)) + '</small>' : ''}</div><div class="offline-actions">${active ? controls('stop', 'Остановить', false, 'offline-stop') : controls(copy ? 'update' : 'download', copy ? 'Обновить копию' : 'Скачать на телефон', !navigator.onLine || !files.length)}${controls('delete', 'Удалить с телефона', !copy, 'offline-delete')}</div><p class="offline-message" role="status" ${status ? '' : 'hidden'} data-kind="${esc(status?.kind || '')}">${esc(status?.text || '')}</p></article>`;
      }).join('')}</div></details>`;
    }).join('');
    if (focus) [...list.querySelectorAll('[data-offline-action]')].find(item => item.dataset.resPath === focus.path && item.dataset.offlineAction === focus.action)?.focus({ preventScroll: true });
  }
  async function refreshLocal() {
    const version = ++localVersion, current = source;
    let estimate, error, saved = [];
    try { saved = await listOfflineCopies(current); }
    catch (problem) { error = problem; }
    try { estimate = await navigator.storage?.estimate?.(); } catch {}
    if (version !== localVersion || current !== source) return;
    copies = saved;
    const bytes = copies.reduce((total, copy) => total + copy.bytes, 0);
    storage.textContent = error ? 'Браузер не разрешил прочитать офлайн-копии. ' + error.message : `На телефоне: ${copies.length} РЭС · ${formatBytes(bytes)}`;
    if (!error && Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage))
      storage.textContent += ` · Для сайта доступно ещё примерно ${formatBytes(Math.max(0, estimate.quota - estimate.usage))}`;
    render();
  }
  async function refresh() {
    if (loading) return;
    if (source !== root()) { job?.controller.abort(); folders = []; copies = []; messages.clear(); list.replaceChildren(); }
    source = root(); const current = source;
    loading = true; button.disabled = true; updated.textContent = 'Читаем карту из базы…';
    const key = 'abonent.load-map.v1:' + current;
    try {
      if (!navigator.onLine) throw new Error('Нет связи с базой.');
      const response = await fetch(new URL('./api/load-map', location.href), { cache:'no-store', signal:AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Не удалось получить карту загрузки.');
      const data = await response.json();
      if (!Array.isArray(data.folders)) throw new Error('Неизвестный ответ базы.');
      if (current !== root()) return;
      folders = data.folders;
      updated.textContent = `Данные базы · ${date(Date.now())}`;
      rememberMapDirectories(current, folders);
      try { localStorage.setItem(key, JSON.stringify({ folders, savedAt:Date.now() })); } catch {}
    } catch (error) {
      if (current !== root()) return;
      let cached; try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
      folders = Array.isArray(cached?.folders) ? cached.folders : [];
      updated.textContent = folders.length ? `Сохранённая карта · ${date(cached.savedAt)}. Нет связи с базой.` : error.message;
    } finally {
      if (current === source && current === root()) await refreshLocal();
      loading = false; button.disabled = false;
    }
  }
  async function download(folder) {
    if (job) { messages.set(job.resPath, { kind:'', text:'Скачивание остановлено. Прежняя копия сохранена.' }); job.controller.abort(); }
    const task = { source, resPath: folder.res_path, controller: new AbortController() };
    job = task;
    const files = getFiles(folder);
    messages.set(folder.res_path, { kind:'loading', text:'Начинаем скачивание… Можно выбрать другую РЭС на главном экране.' }); render();
    try {
      const result = await downloadOfflineCopy({ source: task.source, resPath: task.resPath, files, signal:task.controller.signal,
        onProgress: ({ index, total, role }) => {
          if (job !== task || source !== task.source) return;
          messages.set(task.resPath, { kind:'loading', text:`Скачиваем ${roles.find(([key]) => key === role)[1]} · ${index} из ${total}. Скачивание другой РЭС остановит это.` }); render();
        } });
      rememberOfflineFiles(task.source, task.resPath, files);
      if (job === task && source === task.source) messages.set(task.resPath, { kind:'success', text:`Копия сохранена · ${formatBytes(result.bytes)}. ${files.some(file => file.role === 'registry') ? 'Можно открыть РЭС без интернета.' : 'Для поиска ещё нужен реестр.'}` });
      await onCopiesChanged(task.source, task.resPath, 'download');
    } catch (error) {
      if (source === task.source && job === task) messages.set(task.resPath, { kind: error.name === 'AbortError' ? '' : 'error', text: error.name === 'AbortError' ? 'Скачивание остановлено. Прежняя копия сохранена.' : (error.name === 'QuotaExceededError' ? 'Не хватает места. Удалите ненужные копии РЭС и повторите.' : error.message.replace(/^MEMORY_LIMIT:\s*/, '')) + ' Прежняя копия сохранена, если была скачана.' });
    } finally {
      if (job === task) job = null;
      if (source === task.source) await refreshLocal();
    }
  }
  async function remove(resPath) {
    if (job?.resPath === resPath && job.source === source) { job.controller.abort(); job = null; }
    const current = source;
    try {
      await beforeDelete(current, resPath);
      await deleteOfflineCopy(current, resPath);
      if (current === source) messages.set(resPath, { kind:'success', text:'Копия удалена с телефона. Данные в базе сохранены.' });
      await onCopiesChanged(current, resPath, 'delete');
    } catch (error) { if (current === source) messages.set(resPath, { kind:'error', text:error.message }); }
    finally { if (current === source) await refreshLocal(); }
  }
  list.addEventListener('click', event => {
    const control = event.target.closest('[data-offline-action]');
    if (!control || control.disabled) return;
    const path = control.dataset.resPath, action = control.dataset.offlineAction;
    if (action === 'stop') { if (job?.resPath === path) job.controller.abort(); return; }
    if (action === 'delete') { remove(path); return; }
    const folder = withLocalFolders(folders, copies).find(item => item.res_path === path);
    if (folder) download(folder);
  });
  button.addEventListener('click', refresh);
  window.addEventListener('online', render); window.addEventListener('offline', render);
  window.addEventListener('pagehide', () => job?.controller.abort());
  return { refresh, refreshLocal };
}
