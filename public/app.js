import { readBoundedBuffer } from './download-buffer.js';
import { clean, norm, fieldKey } from './core.js';
import { demo, demoMonthly } from './demo.js';
import { findSource, isExcelFile, isRegistryFile, isConsumptionFile, REGISTRY_NAME, CONSUMPTION_NAME, INCOMING_NAME } from './source.js';
import { initSourceFiles } from './source-files.js';
import { attachDialogSwipe } from './gestures.js';
import { groupRecordFields } from './record-sections.js';
import { initAnalysisUI } from './analysis-ui.js';
import { initNotesUI } from './notes-ui.js';
import { calculateReading } from './readings.js';
import { initLoadMap } from './load-map.js';
import { initDiagnosticsUI } from './diagnostics-ui.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = n => new Intl.NumberFormat('ru-RU').format(n);
const recordsText = n => `${number(n)} ${n % 100 >= 11 && n % 100 <= 14 ? 'записей' : n % 10 === 1 ? 'запись' : n % 10 >= 2 && n % 10 <= 4 ? 'записи' : 'записей'}`;
const subscribersWord = n => n % 100 >= 11 && n % 100 <= 14 ? 'абонентов' : n % 10 === 1 ? 'абонент' : n % 10 >= 2 && n % 10 <= 4 ? 'абонента' : 'абонентов';
const ratioLine = record => `<div class="reading-inline"><div class="transformer-ratio"><span>Коэф ТТ =</span> <strong>${esc(record.fields.transformerRatio || '—')}</strong></div><div class="reading-calculator" data-previous="${esc(record.fields.receipt || '')}" data-ratio="${esc(record.fields.transformerRatio || '')}"><input type="text" inputmode="decimal" autocomplete="off" aria-label="Фактические показания ПУ ${esc(record.fields.meter || '')}" placeholder="Факт. показания"><output hidden aria-live="polite"></output><button type="button" data-reading-action aria-label="Рассчитать объём">${icon('check')}</button></div></div><p class="reading-note" role="status" hidden></p><p class="reading-formula" hidden></p>`;
const pointText = fields => [fields.point || fields.pointNumber, fields.pointName].filter(Boolean).join(' · ') || '—';
const pointLine = record => `<div class="quick-point"><span class="number-label">Точка учёта</span><strong>${esc(pointText(record.fields))}</strong></div>`;
const initial = window.ABONENT_CONFIG || {};
let config = { ...initial }, proxy = false, folders = [], selectedFolder = null, selectedFile = null;
let resFolders = [], selectedRes = null, resState = 'idle';
let sourceState = 'loading', diskState = 'checking', directoryState = 'loading', folderRead = null;
let consumptionFile = null, consumptionState = 'idle', consumptionError = '', registryState = 'idle', busyText = '';
let incomingFile = null, incomingState = 'idle', incomingError = '', monthlyWorker = null, monthlyId = 0;
const monthlyRequests = new Map();
let summary = null, pending = null, currentSource = null, isDemo = false, busy = false, operation = 0;
let results = [], resultTotal = 0, submitted = false, searchVersion = 0, worker, requestId = 0, prefs = {};
let folderItems = [], filesState = 'idle', filesError = '', registryError = '', consumptionInfo = null, incomingInfo = null;
let directoryOffline = false;
let shellReady = false;
let tpChoices = [], tpSelection = null, tpMeters = [], tpVersion = 0, tpBusy = false, recordVersion = 0;
let recordContext = { parent: null, variants: [] };
let tpViewKey = '', tpPickerQuery = '', tpPickerScroll = 0, tpFilterTimer = null;
const dialogControls = new Map();
const requests = new Map();
try { prefs = JSON.parse(localStorage.getItem('abonent.preferences.v1') || '{}'); } catch { /* Preferences are optional. */ }
const sourceFiles = initSourceFiles($('#source-files'), { onRead: useSourceFile, onRefresh: refreshResFiles });
function savePrefs() { try { localStorage.setItem('abonent.preferences.v1', JSON.stringify(prefs)); } catch { /* Private browsing can disable storage. */ } }
function createWorkbookWorker() { return new Worker(new URL('./worker.js', import.meta.url)); }
function getWorker() {
  if (!worker) {
    worker = createWorkbookWorker();
    worker.onmessage = ({ data }) => { const p = requests.get(data.id); if (!p) return; clearTimeout(p.timer); requests.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); };
    worker.onerror = () => { resetWorker(new Error('Не удалось запустить обработку Excel. Перезагрузите страницу.')); };
  }
  return worker;
}
function resetWorker(error = new Error('Операция отменена.')) {
  worker?.terminate(); worker = null;
  for (const p of requests.values()) { clearTimeout(p.timer); p.reject(error); }
  requests.clear();
}
function rpc(action, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const w = getWorker(), id = ++requestId;
    const timer = setTimeout(() => resetWorker(new Error('Чтение реестра заняло слишком много времени. Попробуйте файл меньшего размера.')),
      action === 'loadPreparedRegistry' ? 300000 : 120000);
    requests.set(id, { resolve, reject, timer });
    w.postMessage({ id, action, payload }, transfer);
  });
}
function resetMonthly(error = new Error('Операция отменена.')) {
  monthlyWorker?.terminate(); monthlyWorker = null;
  for (const p of monthlyRequests.values()) { clearTimeout(p.timer); p.reject(error); }
  monthlyRequests.clear();
}
function monthlyRPC(action, payload = {}, transfer = []) {
  if (!monthlyWorker) {
    monthlyWorker = createWorkbookWorker();
    monthlyWorker.onmessage = ({ data }) => { const p=monthlyRequests.get(data.id); if (!p) return; clearTimeout(p.timer); monthlyRequests.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); };
    monthlyWorker.onerror = () => { resetMonthly(new Error('Не удалось обработать файл потребления. Повторите загрузку.')); consumptionState='error'; renderIndicators(); };
  }
  return new Promise((resolve,reject) => {
    const id=++monthlyId, timer=setTimeout(() => { resetMonthly(new Error('Расчёт занял слишком много времени. Попробуйте меньшую выгрузку.')); consumptionState='error'; renderIndicators(); },
      ['loadPreparedMonthly','checkPreparedIncoming'].includes(action) ? 300000 : 120000);
    monthlyRequests.set(id,{resolve,reject,timer}); monthlyWorker.postMessage({id,action,payload},transfer);
  });
}
function message(target, value, loading = false) { const el = $(target); el.textContent = value; el.hidden = !value; el.classList.toggle('loading', loading); }
function toast(value) { $('#toast').textContent = value; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 3000); }
function setBusy(value, text = '') {
  busy = value; busyText = text;
  for (const sel of ['#confirm-mapping', '#local-file', '#search-submit', '#tp-open', '#local-monthly']) $(sel).disabled = value;
  $('#read-folders').disabled = value || sourceState === 'loading' || directoryState === 'loading';
  document.querySelectorAll('.choice-item').forEach(el => { el.disabled = value; });
  $('#district-button').disabled = value;
  $('#res-button').disabled = value || !selectedFolder;
  if (text || !value) message('#settings-message', text, value);
  updateSource(); renderIndicators(); renderResults();
}
function openDialog(id) {
  for (const dialog of document.querySelectorAll('dialog[open]')) if (dialog.id !== id) dialog.close();
  const dialog = $('#' + id);
  if (!dialog.open) dialog.showModal();
}
function showSettings() { renderIndicators(); analysisUI.settingsTab('connection'); openDialog('settings-dialog'); }
function showEnterprises() {
  openDialog('enterprise-dialog'); renderFolders();
  if (sourceState !== 'loading' && directoryState !== 'ready' && !busy) readFolders();
}
function showRes() {
  if (!selectedFolder) { showEnterprises(); return; }
  openDialog('res-dialog'); renderResFolders();
  if (resState === 'error' && !busy) openFolder(selectedFolder, { choose: true });
}
function rootUrl() { return clean(config.publicUrl); }
function renderIndicators() {
  notesUI.update(summary, busy);
  const offline = $('#offline-readiness');
  offline.hidden = !selectedRes || !config.prepared;
  if (!offline.hidden) {
    const ready = shellReady && summary?.cached && (!consumptionFile || consumptionInfo?.cached) && (!incomingFile || incomingInfo?.cached);
    offline.dataset.ready = String(Boolean(ready));
    offline.textContent = ready ? `Данные ${selectedRes.name} сохранены на телефоне · доступны без интернета` :
      'Подготовка офлайн-доступа: дождитесь загрузки реестра, ПО и приёма при устойчивой связи.';
  }
  const cachedOffline = summary?.offline || consumptionInfo?.offline || incomingInfo?.offline;
  const baseState = sourceState === 'loading' ? 'checking' : !config.prepared ? (proxy ? 'off' : 'idle') : !navigator.onLine || cachedOffline ? 'off' : config.databaseConnected ? 'on' : 'off';
  const baseText = baseState === 'checking' ? 'Проверяем подключение к базе…' : !config.prepared ? 'База не подключена · доступен прежний режим Excel' : baseState === 'on' ? 'Подготовленные данные базы доступны' : !navigator.onLine || cachedOffline ? 'База недоступна · открыты сохранённые данные' : 'Нет связи с базой данных';
  const registryText = registryState === 'ready' || summary ? 'Реестр готов к поиску' : registryState === 'checking' ? busyText || 'Проверяем реестр…' : pending ? 'Подтвердите столбцы в настройках' : registryError || (registryState === 'missing' ? 'Файл реестра не найден' : registryState === 'error' ? 'Реестр не загружен' : 'Сначала выберите РЭС');
  const consumptionText = consumptionState === 'ready' ? 'Готов к анализу: ' + (consumptionFile?.name || 'Демонстрация') : consumptionState === 'checking' ? `Читаем «${consumptionFile?.name || CONSUMPTION_NAME}»…` : consumptionState === 'missing' ? `Файл «${CONSUMPTION_NAME}» не найден` : consumptionState === 'error' ? consumptionError || 'Не удалось прочитать файл потребления' : 'Сначала выберите РЭС';
  const incomingText = incomingState === 'ready' ? 'Прочитан: ' + incomingFile.name + ' · баланс ожидает формат' : incomingState === 'checking' ? 'Читаем файл приёма…' : incomingState === 'missing' ? `Файл «${INCOMING_NAME}» не найден` : incomingState === 'error' ? incomingError || 'Не удалось прочитать приём' : 'Сначала выберите РЭС';
  for (const [name, state, label] of [
    ['base', baseState, baseText],
    ['registry', registryState === 'ready' ? 'on' : registryState === 'checking' ? 'checking' : registryState === 'idle' ? 'idle' : 'off', registryText],
    ['incoming', incomingState === 'ready' ? 'on' : incomingState === 'checking' ? 'checking' : incomingState === 'idle' ? 'idle' : 'off', incomingText],
    ['consumption', consumptionState === 'ready' ? 'on' : consumptionState === 'checking' ? 'checking' : consumptionState === 'idle' ? 'idle' : 'off', consumptionText],
  ]) {
    const indicator = $('#' + name + '-indicator');
    indicator.dataset.state = state; indicator.title = label;
    indicator.setAttribute('aria-label', `${{ base:'Чтение базы',registry:'Реестр',consumption:'Потребление',incoming:'Приём' }[name]}: ${label}`);
  }
  $('#base-detail').textContent = baseText;
  $('#enterprise-detail').textContent = selectedFolder?.name || 'Не выбрано';
  $('#res-detail').textContent = selectedRes?.name || 'Не выбрана';
  $('#contour-open').disabled = busy || consumptionState !== 'ready';
  $('#tp-analyze').disabled = busy || consumptionState !== 'ready';
  const analysisButton = $('#consumer-analyze');
  if (analysisButton) { analysisButton.disabled = consumptionState !== 'ready' || !activeRecord?.fields.account; $('#analysis-availability').textContent = consumptionState === 'ready' ? 'Все строки ЛС + ТУ суммируются по месяцам. Анализируем общий объём точки.' : consumptionText; }
  sourceFiles.render({ res: selectedRes, items: folderItems, listState: filesState, listError: filesError, busy: busy || directoryState === 'loading' || sourceState === 'loading', sources: {
    registry: { file: currentSource || selectedFile, saved: selectedRes && prefs.fileChoices?.registry, expected: REGISTRY_NAME, state: summary ? 'ready' : registryState, meta: summary ? recordsText(summary.count) : '', message: registryText },
    consumption: { file: consumptionFile, saved: selectedRes && prefs.fileChoices?.consumption, expected: CONSUMPTION_NAME, state: consumptionState, meta: consumptionInfo ? `${recordsText(consumptionInfo.rowCount)} · ${consumptionInfo.months.length} мес.` : '', message: consumptionState === 'ready' ? 'Готов к анализу' : consumptionText },
    incoming: { file: incomingFile, saved: selectedRes && prefs.fileChoices?.incoming, expected: INCOMING_NAME, state: incomingState, meta: incomingInfo ? `Заполненных листов: ${incomingInfo.sheets}` : '', message: incomingState === 'ready' ? 'Файл прочитан · расчёт баланса подключим позже' : incomingText }
  } });
}
function renderSourceState() {
  const text = sourceState === 'loading' ? 'Получаем настройки общей папки…' : sourceState === 'error' ? 'Не удалось получить настройки источника. Проверьте соединение и повторите.' : sourceState === 'missing' ? 'Общая папка ещё не подключена. Администратору нужно указать ссылку в переменной YANDEX_PUBLIC_URL в Амвере.' : '';
  message('#source-setup-message', text);
  $('#read-folders').disabled = busy || sourceState === 'loading' || directoryState === 'loading';
  renderIndicators(); renderFolders();
}
async function readConfiguration() {
  sourceState = 'loading'; diskState = 'checking'; renderSourceState();
  try {
    const response = await fetch(new URL('./api/config', location.href), { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const remote = await response.json();
      if (remote.proxy !== true) throw new Error('Неизвестный ответ сервера.');
      proxy = true; config = { ...initial, ...remote, publicUrl: remote.publicUrl || '' };
      try { localStorage.setItem('abonent.server.v1', JSON.stringify({ publicUrl: config.publicUrl, prepared: config.prepared })); } catch {}
    } else if (response.status === 404 || response.ok) {
      proxy = false; config = { ...initial }; // Static hosting uses its fixed config.js only.
    } else throw new Error('Настройки сервера недоступны.');
    sourceState = rootUrl() ? 'ready' : 'missing';
    if (rootUrl()) validateRoot(rootUrl());
  } catch {
    try {
      const saved = JSON.parse(localStorage.getItem('abonent.server.v1') || 'null');
      if (saved?.publicUrl && prefs.root === saved.publicUrl && saved.prepared) {
        proxy = true; config = { ...initial, ...saved }; sourceState = 'ready'; directoryOffline = true;
      } else sourceState = 'error';
    } catch { sourceState = 'error'; }
  }
  if (sourceState !== 'ready') { diskState = 'disconnected'; directoryState = 'error'; consumptionFile = null; consumptionState = selectedRes ? 'error' : 'idle'; registryState = selectedRes ? 'error' : 'idle'; }
  renderSourceState();
}
function validateRoot(value) {
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password && !u.port && ['disk.yandex.ru', 'disk.yandex.com', 'disk.yandex.net', 'disk.360.yandex.ru', 'yadi.sk'].includes(u.hostname) && /^\/(d|i)\/[\w-]+\/?$/.test(u.pathname)) return `${u.origin}${u.pathname}`; } catch {}
  throw new Error('Адрес общей папки настроен некорректно. Обратитесь к администратору приложения.');
}
async function apiRequest(action, path = '/', offset = 0, legacy = false) {
  if (proxy && !navigator.onLine) throw new Error('Нет подключения к сети.');
  const base = config.apiBase || (proxy ? new URL('./api/', location.href).href : 'https://cloud-api.yandex.net/v1/disk/public/');
  const directory = action === 'resources' && proxy && config.prepared && config.databaseConnected && !legacy;
  const endpoint = directory ? 'directory' : proxy || config.apiBase ? action : action === 'download' ? 'resources/download' : 'resources';
  const url = new URL(endpoint, base.endsWith('/') ? base : base + '/');
  if (!proxy && !config.apiBase) url.searchParams.set('public_key', validateRoot(rootUrl()));
  url.searchParams.set('path', path);
  if (action === 'resources') { url.searchParams.set('offset', offset); url.searchParams.set('limit', 100); url.searchParams.set('sort', 'name'); }
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(action === 'download' ? 90000 : 25000), credentials: 'same-origin' }); }
  catch { throw new Error(proxy ? 'Нет ответа от Яндекс Диска. Проверьте соединение и повторите.' : 'Браузер не смог получить файл с Яндекс Диска. Откройте Excel с устройства или используйте версию на Амвере.'); }
  if (directory && [404,502,503].includes(response.status)) return apiRequest(action,path,offset,true);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const text = { 404: 'Папка не найдена. Проверьте ссылку и доступ.', 403: 'Доступ к файлу ограничен. Разрешите скачивание по ссылке.', 429: 'Слишком много запросов к Диску. Повторите позже.', 413: 'Файл превышает 40 МБ.' };
    throw new Error(body.error && !/^[A-Za-z]+Error$/.test(body.error) ? body.error : text[response.status] || 'Не удалось получить данные Яндекс Диска.');
  }
  return response;
}
async function listFolder(path, legacy = false) {
  const key = 'abonent.folder.v1:' + rootUrl() + ':' + path;
  try {
    let all = [], offset = 0;
    while (true) {
      const data = await (await apiRequest('resources', path, offset, legacy)).json();
      if (data.type !== 'dir') throw new Error('Не удалось прочитать каталог: по выбранному пути находится файл.');
      const part = data._embedded?.items || []; all.push(...part); offset += part.length;
      if (!part.length || offset >= (data._embedded?.total ?? offset)) break;
      if (offset > 10000) throw new Error('В папке слишком много файлов. Разделите её на папки предприятий.');
    }
    directoryOffline = false;
    try { localStorage.setItem(key, JSON.stringify(all)); } catch {}
    return all;
  } catch (error) {
    const saved = localStorage.getItem(key);
    if (!saved) throw error;
    directoryOffline = true;
    return JSON.parse(saved);
  }
}
function renderFolders() {
  const list = $('#folder-list');
  if (sourceState === 'loading' || directoryState === 'loading') {
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '<div class="enterprise-loading" role="status"><span class="loading-indicator" aria-hidden="true"></span><span>Загружаем предприятия…</span><div class="loading-bar" aria-hidden="true"></div></div>';
    return;
  }
  list.setAttribute('aria-busy', 'false');
  if (sourceState !== 'ready' || directoryState === 'error') {
    list.innerHTML = '<div class="enterprise-empty"><p>Не удалось загрузить список предприятий.</p><button type="button" class="secondary" data-open-settings>Проверить подключение</button></div>';
    return;
  }
  list.innerHTML = folders.length ? folders.map((f, i) => `<button type="button" class="choice-item ${selectedFolder?.path === f.path ? 'selected' : ''}" data-folder="${i}" aria-pressed="${selectedFolder?.path === f.path}" ${busy ? 'disabled' : ''}><span>${esc(f.name)}</span><i class="choice-dot" aria-hidden="true"></i></button>`).join('') : '<div class="enterprise-empty"><p>Предприятия пока не найдены.</p></div>';
}
async function readFolders() {
  if (folderRead) return folderRead;
  if (busy) return false;
  folderRead = (async () => {
    if (sourceState !== 'ready') { await readConfiguration(); if (sourceState !== 'ready') return false; }
    directoryState = 'loading'; diskState = 'checking'; renderSourceState();
    try {
      const root = validateRoot(rootUrl());
      if (prefs.root !== root) { folders = []; selectedFolder = null; resFolders = []; resState = 'idle'; clearResSelection(); prefs = { root }; savePrefs(); }
      folders = (await listFolder('/')).filter(f => f.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      directoryState = 'ready'; diskState = directoryOffline ? 'disconnected' : 'connected';
      if (!selectedRes) { consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; }
      return true;
    } catch (error) {
      directoryState = 'error'; diskState = 'disconnected'; consumptionFile = null; consumptionState = selectedRes ? 'error' : 'idle'; registryState = selectedRes ? 'error' : 'idle';
      message('#settings-message', error.message);
      return false;
    } finally { renderSourceState(); }
  })();
  try { return await folderRead; } finally { folderRead = null; }
}
function clearResSelection() {
  selectedRes = null; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; consumptionError = ''; registryState = 'idle';
  clearDataset(); renderIndicators();
}
function renderResFolders() {
  $('#res-enterprise').textContent = selectedFolder?.name || '';
  const list = $('#res-list');
  list.setAttribute('aria-busy', String(resState === 'loading'));
  if (resState === 'loading') {
    list.innerHTML = '<div class="enterprise-loading" role="status"><span class="loading-indicator" aria-hidden="true"></span><span>Загружаем РЭС…</span><div class="loading-bar" aria-hidden="true"></div></div>'; return;
  }
  if (resState === 'error') {
    list.innerHTML = '<div class="enterprise-empty"><p>Не удалось загрузить список РЭС.</p><button type="button" class="secondary" data-open-settings>Проверить подключение</button></div>'; return;
  }
  list.innerHTML = resFolders.length ? resFolders.map((f, i) => `<button type="button" class="choice-item ${selectedRes?.path === f.path ? 'selected' : ''}" data-res="${i}" aria-pressed="${selectedRes?.path === f.path}" ${busy ? 'disabled' : ''}><span>${esc(f.name)}</span><i class="choice-dot" aria-hidden="true"></i></button>`).join('') : '<div class="enterprise-empty"><p>В этом предприятии пока нет папок РЭС.</p></div>';
}
async function refreshSources() {
  if (busy || folderRead) return;
  message('#settings-message', '');
  await readConfiguration();
  if (sourceState !== 'ready' || !await readFolders()) return;
  const folder = folders.find(f => f.path === (selectedFolder?.path || prefs.folder?.path));
  if (folder) await openFolder(folder, { restore: true });
  else if (selectedFolder || prefs.folder) {
    selectedFolder = null; resFolders = []; resState = 'idle'; clearResSelection();
    prefs = { root: rootUrl() }; savePrefs(); updateSource(); renderIndicators();
    message('#settings-message', 'Выбранное предприятие больше не найдено. Выберите другое на главном экране.');
  }
}
async function selectFolder(i) {
  if (busy || !folders[i]) return;
  await openFolder(folders[i], { choose: true });
}
async function openFolder(folder, { restore = false, choose = false } = {}) {
  if (busy) return;
  const savedRes = restore && prefs.root === rootUrl() && prefs.folder?.path === folder.path ? prefs.res : null;
  selectedFolder = folder; resFolders = []; resState = 'loading'; clearResSelection();
  if (!savedRes) prefs = { root: rootUrl() };
  prefs.folder = { name: folder.name, path: folder.path }; savePrefs();
  if (choose) openDialog('res-dialog');
  renderFolders(); renderResFolders();
  try {
    setBusy(true, 'Читаем папки РЭС…');
    const items = await listFolder(folder.path);
    resFolders = items.filter(f => f.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    resState = 'ready'; diskState = directoryOffline ? 'disconnected' : 'connected';
  } catch (error) {
    resState = 'error'; diskState = 'disconnected'; setBusy(false);
    message('#settings-message', error.message); renderResFolders(); return;
  }
  setBusy(false); renderResFolders();
  const restored = savedRes && resFolders.find(f => f.path === savedRes.path);
  if (restored) await openRes(restored);
  else if (savedRes) {
    prefs = { root: rootUrl(), folder: prefs.folder }; savePrefs();
    message('#settings-message', 'Выбранная РЭС больше не найдена. Выберите другую РЭС.');
    toast('Выбранная РЭС больше не найдена');
  }
}
async function selectRes(i) {
  if (busy || !resFolders[i]) return;
  $('#res-dialog').close(); await openRes(resFolders[i]);
}
async function refreshResFiles() {
  if (busy || folderRead || !selectedRes) return;
  await openRes(selectedRes, { keepSettings: true });
}
async function useSourceFile(role, path) {
  if (busy || folderRead || !selectedRes || filesState !== 'ready' || !['registry', 'consumption', 'incoming'].includes(role)) return;
  const choices = { ...prefs.fileChoices };
  if (path === null) {
    delete choices[role]; prefs.fileChoices = choices; savePrefs();
    await refreshResFiles(); return;
  }
  const file = folderItems.find(item => item.type === 'file' && item.path === path && isExcelFile(item.name));
  if (!file) { message('#settings-message', 'Выберите Excel из списка файлов этой РЭС.'); return; }
  choices[role] = { path: file.path, name: file.name }; prefs.fileChoices = choices; savePrefs();
  if (role === 'registry') { await refreshResFiles(); return; }
  if (role === 'consumption') { consumptionFile = file; await readConsumptionFile(); }
  else { incomingFile = file; await readIncomingFile(); }
  if ((role === 'consumption' ? consumptionState : incomingState) === 'ready') toast('Файл прочитан: ' + file.name);
}
async function openRes(res, { keepSettings = false } = {}) {
  if (busy || !selectedFolder) return;
  clearResSelection(); selectedRes = res;
  consumptionState = 'checking'; incomingState = 'checking'; registryState = 'checking';
  if (prefs.res?.path !== res.path) prefs = { root: rootUrl(), folder: { name: selectedFolder.name, path: selectedFolder.path } };
  prefs.res = { name: res.name, path: res.path }; savePrefs(); renderResFolders();
  try {
    setBusy(true, 'Читаем файлы РЭС…');
    filesState = 'loading'; renderIndicators();
    folderItems = (await listFolder(res.path)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    if (proxy && config.prepared && Object.values(prefs.fileChoices || {}).some(choice => choice?.path && !folderItems.some(item => item.path === choice.path))) {
      folderItems = (await listFolder(res.path, true)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }
    filesState = 'ready'; diskState = directoryOffline ? 'disconnected' : 'connected';
    consumptionFile = findSource(folderItems, 'consumption', prefs.fileChoices); consumptionState = consumptionFile ? 'checking' : 'missing';
    selectedFile = findSource(folderItems, 'registry', prefs.fileChoices);
    incomingFile = findSource(folderItems, 'incoming', prefs.fileChoices); incomingState = incomingFile ? 'checking' : 'missing';
  } catch (error) {
    filesState = 'error'; filesError = error.message;
    diskState = 'disconnected'; consumptionState = 'error'; incomingState = 'error'; registryState = 'error';
    setBusy(false); message('#settings-message', error.message); showSettings(); return;
  }
  setBusy(false);
  if (selectedFile) await downloadFile({ keepSettings });
  else {
    registryState = 'missing'; renderIndicators();
    message('#settings-message', 'Реестр не найден. Выберите файл вручную в разделе «Просмотр файлов».'); showSettings();
  }
  if (selectedRes?.path === res.path && consumptionFile) await readConsumptionFile();
  if (selectedRes?.path === res.path && incomingFile) await readIncomingFile();
}
async function fetchWorkbook(file) {
  if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Файл больше 40 МБ.');
  const latest = await (await apiRequest('resources', file.path)).json();
  if (latest.type !== 'file') throw new Error('Файл больше не найден. Обновите файлы РЭС.');
  file = { ...file, ...latest };
  if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Файл больше 40 МБ.');
  let response = await apiRequest('download', file.path);
  if (!proxy && !config.apiBase) {
    const { href } = await response.json();
    const url = new URL(href);
    if (url.protocol !== 'https:' || !['yandex.ru','yandex.net','yandex.com','yandexdisk.com'].some(h => url.hostname === h || url.hostname.endsWith('.' + h))) throw new Error('Неподдерживаемый адрес скачивания.');
    try { response = await fetch(href, { signal: AbortSignal.timeout(90000) }); } catch { throw new Error('Браузер заблокировал скачивание с Диска. Откройте Excel с устройства или используйте версию на Амвере.'); }
    if (!response.ok) throw new Error('Не удалось скачать Excel. Проверьте доступ по ссылке.');
  }
  return { file, buffer: await readBoundedBuffer(response, (config.maxFileMB || 40) * 1048576, file.size) };
}
async function downloadFile({ keepSettings = false } = {}) {
  if (busy || !selectedFile || !selectedFolder || !selectedRes) return;
  const folder = selectedFolder, res = selectedRes;
  try {
    registryState = 'checking'; registryError = ''; setBusy(true, 'Загружаем реестр…');
    if (proxy && config.prepared && !customMappingSaved() && selectedFile.path) {
      try {
        const listedIncoming = incomingFile;
        clearDataset(true); incomingFile = listedIncoming; incomingState = listedIncoming ? 'checking' : 'missing';
        const data = await rpc('loadPreparedRegistry', { source: rootUrl(), path: selectedFile.path, role: 'registry' });
        currentSource = { type: 'disk', name: selectedFile.name, folder: folder.name, res: res.name,
          root: rootUrl(), folderInfo: folder, resInfo: res, fileInfo: selectedFile, keepSettings };
        summary = data; registryState = 'ready'; pending = null;
        updateSource(); setBusy(false); renderResults();
        if (!keepSettings) $('#settings-dialog').close();
        toast(data.offline ? 'Реестр открыт с телефона · офлайн' : `Реестр готов: ${recordsText(data.count)}`);
        return;
      } catch (error) {
        if ((selectedFile.size || 0) > 8 * 1048576 || error.message.startsWith('MEMORY_LIMIT:'))
          throw new Error(error.message.replace(/^MEMORY_LIMIT:\s*/, ''));
        // A small custom workbook can still use local column mapping.
      }
    }
    const { file, buffer } = await fetchWorkbook(selectedFile); selectedFile = file;
    await loadBuffer(buffer, { name: file.name, folder: folder.name, res: res.name, modified: file.modified, type: 'disk', root: rootUrl(), folderInfo: folder, resInfo: res, fileInfo: file, keepSettings });
  } catch (error) { registryState = 'error'; registryError = error.message; setBusy(false); message('#settings-message', error.message); showSettings(); }
}
async function loadMonthlyBuffer(buffer) {
  const op = operation, records = await rpc('analysisRecords');
  if (op !== operation) throw new Error('Рабочая область изменилась.');
  return monthlyRPC('loadMonthly', { buffer, records }, [buffer]);
}
async function readIncomingFile() {
  const op=operation, file=incomingFile;
  incomingState='checking'; incomingError=''; incomingInfo=null; setBusy(true, 'Читаем файл приёма…');
  try {
    if (proxy && config.prepared && file.path) {
      try {
        const info = await monthlyRPC('checkPreparedIncoming', { source: rootUrl(), path: file.path, role: 'incoming' });
        if (op !== operation || incomingFile !== file) return;
        incomingInfo = info; incomingState = 'ready'; setBusy(false); return;
      } catch (error) {
        if ((file.size || 0) > 8 * 1048576 || error.message.startsWith('MEMORY_LIMIT:'))
          throw new Error(error.message.replace(/^MEMORY_LIMIT:\s*/, ''));
        // A small incompatible workbook can still use local Excel reading.
      }
    }
    const { buffer, file: latest } = await fetchWorkbook(file); Object.assign(file, latest);
    if (op!==operation || incomingFile!==file) return;
    const info = await monthlyRPC('checkIncoming',{buffer},[buffer]);
    if (op!==operation || incomingFile!==file) return;
    incomingInfo=info; incomingState='ready';
  } catch(error) { if(op!==operation || incomingFile!==file)return;incomingState='error';incomingError=error.message; }
  if (op===operation) setBusy(false);
}
async function readConsumptionFile() {
  const op = operation, file = consumptionFile;
  consumptionState = 'checking'; consumptionError = ''; consumptionInfo = null; resetMonthly(); analysisUI.reset(); setBusy(true, 'Читаем файл потребления…');
  try {
    if (proxy && config.prepared && file.path) {
      try {
        const records = await rpc('analysisRecords');
        const info = await monthlyRPC('loadPreparedMonthly', { source: rootUrl(), path: file.path, role: 'consumption', records });
        if (op !== operation || consumptionFile !== file) return;
        consumptionInfo = info; consumptionState = 'ready'; setBusy(false); return;
      } catch (error) {
        if ((file.size || 0) > 8 * 1048576 || error.message.startsWith('MEMORY_LIMIT:'))
          throw new Error(error.message.replace(/^MEMORY_LIMIT:\s*/, ''));
        // A small incompatible workbook can still use local Excel reading.
      }
    }
    const { buffer, file: latest } = await fetchWorkbook(file); Object.assign(file, latest);
    if (op !== operation || consumptionFile !== file) return;
    const info = await loadMonthlyBuffer(buffer);
    if (op !== operation || consumptionFile !== file) return;
    consumptionInfo = info; consumptionState = 'ready';
  } catch (error) {
    if (op !== operation || consumptionFile !== file) return;
    consumptionState = 'error'; consumptionError = error.message;
  }
  if (op === operation) setBusy(false);
}
function clearDataset(keepDirectory = false) {
  notesUI.reset();
  operation++; consumptionInfo = null; incomingInfo = null; registryError = ''; resetMonthly(); analysisUI.reset(); incomingFile=null; incomingState='idle'; incomingError=''; if (keepDirectory) { if (consumptionFile) consumptionState='checking'; } else { consumptionFile=null; consumptionState='idle'; consumptionError=''; } searchVersion++; resetWorker(); summary = null; pending = null; currentSource = null; isDemo = false; submitted = false; results = []; resultTotal = 0;
  tpVersion++; recordVersion++; tpChoices = []; tpSelection = null; tpMeters = []; tpBusy = false; if (!keepDirectory) { folderItems = []; filesState = 'idle'; filesError = ''; }
  tpViewKey = ''; tpPickerQuery = ''; tpPickerScroll = 0; clearTimeout(tpFilterTimer);
  for (const id of ['tp-dialog', 'search-results-dialog', 'record-dialog']) $('#' + id).close();
  $('#search-modal-results').replaceChildren(); $('#tp-meters').replaceChildren(); $('#tp-list').replaceChildren(); $('#record-body').replaceChildren();
  $('#mapping-section').hidden = true; $('#search-input').value = ''; $('#clear-query').hidden = true;
  updateSource(); renderResults();
}
async function loadBuffer(buffer, source) {
  const listedIncoming = incomingFile;
  clearDataset(source.type === 'disk'); if (source.type === 'disk') { incomingFile=listedIncoming; incomingState=listedIncoming?'checking':'missing'; }
  const op = operation;
  setBusy(true, 'Читаем Excel и определяем столбцы…');
  const data = await rpc('load', { buffer, file: source.name }, [buffer]);
  if (operation !== op) return;
  pending = { ...data, source };
  if (source.type === 'disk' && prefs.mappingSignature === signature(data) && prefs.folder?.path === source.folderInfo.path && prefs.res?.path === source.resInfo.path && prefs.root === source.root) {
    await confirmMapping(prefs.overrides || {}, true);
  } else if (source.type === 'disk' && !data.skipped.length && data.sheets.every(s => !s.layout.flattened && s.layout.mapping.meter !== undefined && s.layout.mapping.account !== undefined)) {
    const overrides = Object.fromEntries(data.sheets.map(s => [s.sheet, { meter: s.layout.mapping.meter, account: s.layout.mapping.account }]));
    await confirmMapping(overrides, true);
  } else { if (source.type === 'disk') registryState = 'error'; renderMapping(); setBusy(false); renderResults(); showSettings(); $('#mapping-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
function signature(data) { return JSON.stringify(data.sheets.map(s => [s.sheet, s.layout.labels])); }
function customMappingSaved() {
  if (!prefs.overrides || !prefs.mappingSignature) return false;
  try {
    return JSON.parse(prefs.mappingSignature).some(([sheet, labels]) =>
      ['meter','account'].some(key => {
        const expected = labels.findIndex(label => fieldKey(label) === key);
        const chosen = prefs.overrides[sheet]?.[key];
        return Number.isInteger(chosen) && chosen !== expected;
      }));
  } catch { return true; }
}
function renderMapping() {
  $('#mapping-section').hidden = false;
  $('#mapping-fields').innerHTML = pending.sheets.map((s, i) => `<div class="map-sheet"><h4>${esc(s.sheet)}</h4>${['meter', 'account'].map(key => `<div class="map-row"><label for="map-${i}-${key}">${key === 'meter' ? 'Номер ПУ' : 'Лицевой счёт'}</label><select id="map-${i}-${key}" data-map-sheet="${i}" data-map-key="${key}"><option value="-1">Нет такого столбца</option>${s.layout.labels.map((label, c) => `<option value="${c}" ${s.layout.mapping[key] === c ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><div class="map-preview" id="sample-${i}-${key}"></div></div>`).join('')}</div>`).join('');
  updateMapPreview();
  const warnings = [...pending.skipped.map(s => `Лист «${s.sheet}» пропущен: ${s.error}`), ...pending.sheets.filter(s => s.layout.flattened).map(s => `Лист «${s.sheet}»: восстановлена двухстрочная шапка. Проверьте примеры номеров.`)];
  $('#mapping-warning').textContent = warnings.join(' '); $('#mapping-warning').hidden = !warnings.length;
}
function updateMapPreview() {
  document.querySelectorAll('[data-map-sheet]').forEach(select => {
    const { mapSheet: i, mapKey: key } = select.dataset, c = Number(select.value);
    $(`#sample-${i}-${key}`).textContent = c < 0 ? 'Поле не будет участвовать в поиске' : 'Примеры: ' + pending.sheets[i].sample.map(r => r[c] || '—').join(' · ');
  });
}
async function confirmMapping(savedOverrides, automatic = false) {
  if (!pending || busy && !automatic) return;
  try {
    const overrides = savedOverrides || Object.fromEntries(pending.sheets.map((s, i) => [s.sheet, { meter: Number($(`#map-${i}-meter`).value), account: Number($(`#map-${i}-account`).value) }]));
    for (const v of Object.values(overrides)) if (v.meter >= 0 && v.meter === v.account) throw new Error('Номер ПУ и лицевой счёт должны быть в разных столбцах.');
    for (const v of Object.values(overrides)) if (v.meter < 0 && v.account < 0) throw new Error('Выберите хотя бы один столбец: номер ПУ или лицевой счёт.');
    setBusy(true, 'Готовим поиск…');
    const data = await rpc('remap', { overrides });
    currentSource = pending.source; summary = data;
    if (consumptionState === 'ready') await monthlyRPC('updateAnalysisRegistry',{records:await rpc('analysisRecords')});
    await rpc('releaseSource');
    if (currentSource.type === 'disk') {
      prefs = { fileChoices: prefs.fileChoices, root: currentSource.root, folder: { name: currentSource.folderInfo.name, path: currentSource.folderInfo.path }, res: { name: currentSource.resInfo.name, path: currentSource.resInfo.path }, file: { name: currentSource.fileInfo.name, path: currentSource.fileInfo.path }, mappingSignature: signature(pending), overrides };
      savePrefs();
    }
    registryState = currentSource.type === 'disk' ? 'ready' : 'idle';
    pending = null; $('#mapping-section').hidden = true; setBusy(false); updateSource(); renderResults();
    if (!currentSource.keepSettings) $('#settings-dialog').close(); toast(`Реестр готов: ${recordsText(summary.count)}`);
    if (data.skipped.length) message('#form-message', `Пропущено листов: ${data.skipped.length}. ${data.skipped.map(s => s.sheet + ': ' + s.error).join(' ')}`);
  } catch (error) { if (pending?.source.type === 'disk') registryState = 'error'; setBusy(false); message('#settings-message', error.message); showSettings(); }
}
async function startDemo() {
  if (busy) return;
  try {
    clearDataset(); selectedFolder = null; selectedRes = null; resFolders = []; resState = 'idle'; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; setBusy(true); summary = await rpc('demo', demo); isDemo = true;
    consumptionFile = { name: 'ПО по месячно · пример' }; consumptionState='checking';
    await monthlyRPC('demoMonthly',{parsed:demoMonthly,records:await rpc('analysisRecords')}); consumptionState='ready';
    currentSource = { name: 'Демонстрационный реестр', folder: 'Сочинские ЭС · пример', res: 'Дагомысский РЭС · пример', type: 'demo' };
    updateSource(); renderResults(); $('#search-input').focus();
  } catch (error) { message('#form-message', error.message); }
  finally { setBusy(false); }
}
function updateSource() {
  $('#district-label').textContent = currentSource?.folder || selectedFolder?.name || 'Выберите предприятие';
  $('#res-label').textContent = currentSource?.res || selectedRes?.name || (selectedFolder ? 'Выберите РЭС' : 'Сначала выберите предприятие');
  $('#res-button').disabled = busy || !selectedFolder;
  $('#demo-banner').hidden = !isDemo; $('#example-queries').hidden = !isDemo;
  document.querySelectorAll('[name="field"]').forEach(input => {
    const available = !summary || input.value === 'address' || summary.sheets.some(s => s.layout.mapping[input.value] !== undefined);
    input.disabled = !available;
    if (!available && input.checked) { const first = summary.sheets.some(s => s.layout.mapping.meter !== undefined) ? 'meter' : 'account'; $(`[name="field"][value="${first}"]`).checked = true; updateSearchMode(); }
  });
}
function field() { return $('[name="field"]:checked').value; }
function updateSearchMode() {
  const type = field();
  const labels = { meter: ['Номер прибора учёта', 'Введите номер счётчика'], account: ['Номер лицевого счёта', 'Введите лицевой счёт'], address: ['Адрес точки учёта', 'Населённый пункт, улица, дом'] };
  $('#search-label').textContent = labels[type][0]; $('#search-input').placeholder = labels[type][1];
  $('#match-hint').textContent = type === 'address' ? 'По всем словам адреса' : 'Можно ввести номер целиком или его часть';
}
function emptyState(title, text, type = 'search', actions = '') { return `<div class="empty-state"><div class="empty-mark">${icon(type)}</div><h3>${title}</h3><p>${text}</p>${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`; }
function renderResults() {
  $('#show-more').hidden = true; $('#results-count').textContent = ''; $('#results-title').textContent = submitted ? 'Найденные абоненты' : 'Результаты поиска';
  if (!summary && busy) { $('#results').innerHTML = emptyState('Загружаем реестр', busyText || 'Подготавливаем поиск…', 'file'); return; }
  if (!summary) {
    const target = pending || selectedRes ? 'settings' : selectedFolder ? 'res' : 'enterprises';
    const title = pending ? 'Проверьте столбцы реестра' : selectedRes ? 'Реестр не подключён' : selectedFolder ? 'Выберите РЭС' : 'Выберите предприятие';
    const text = pending ? 'Подтвердите номера ПУ и лицевых счетов в настройках.' : selectedRes ? 'Проверьте файлы выбранной РЭС в настройках.' : selectedFolder ? 'Выберите район электрических сетей. Файлы загрузятся из его папки.' : 'Выберите предприятие, затем РЭС. Реестр загрузится автоматически.';
    $('#results').innerHTML = emptyState(title, text, 'folder', `<button class="secondary" data-open-${target}>${target === 'settings' ? 'Открыть настройки' : target === 'res' ? 'Выбрать РЭС' : 'Выбрать предприятие'}</button>` + (pending ? '' : '<button class="text-button" id="start-demo">Посмотреть пример</button>'));
    return;
  }
  if (!submitted) { $('#results').innerHTML = emptyState('Можно искать', `В реестре ${recordsText(summary.count)}. Введите номер ПУ, лицевой счёт или адрес.`, 'search'); return; }
  $('#results-count').textContent = recordsText(resultTotal);
  if (!results.length) { $('#results').innerHTML = emptyState('Совпадений нет', field() === 'address' ? 'Попробуйте указать только улицу и номер дома.' : 'Проверьте выбранную РЭС или введите более короткий фрагмент номера.'); return; }
  const cards = results.map(r => `<article class="result-card"><div class="result-top"><h3 class="result-name">${esc(r.fields.name || 'Абонент без наименования')}</h3>${r.fields.status ? `<span class="status ${/откл/i.test(r.fields.status) ? 'off' : ''}">${esc(r.fields.status)}</span>` : ''}</div><p class="result-address">${icon('pin')}<span>${esc(r.address || 'Адрес не указан в реестре')}</span></p><div class="result-numbers"><div><div class="number-label">НОМЕР ПУ</div><div class="number-value">${esc(r.fields.meter || '—')}</div></div><div><div class="number-label">ЛИЦЕВОЙ СЧЁТ</div><div class="number-value">${esc(r.fields.account || '—')}</div></div>${pointLine(r)}${ratioLine(r)}</div><div class="result-bottom"><span>${esc(r.fields.tp || r.sheet)} · строка ${r.row}</span><button class="record-open" data-record="${esc(r.id)}">Все данные</button></div></article>`).join('');
  $('#results').innerHTML = resultTotal === 1 ? cards : emptyState(`Найдено: ${recordsText(resultTotal)}`, 'Совпадения доступны в списке. Нажмите «Найти», чтобы открыть его снова.', 'file');
  $('#search-modal-results').innerHTML = cards;
  $('#search-modal-meta').textContent = `${recordsText(resultTotal)} · «${clean($('#search-input').value)}»`;
  $('#show-more').hidden = results.length >= resultTotal;
}
async function doSearch(more = false) {
  const query = clean($('#search-input').value);
  if (!summary) { message('#form-message', pending ? 'Подтвердите столбцы реестра в настройках.' : 'Сначала подключите реестр в настройках.'); return; }
  if (!query) { message('#form-message', 'Введите номер или адрес для поиска.'); $('#search-input').focus(); return; }
  const version = ++searchVersion;
  $('#search-submit').disabled = true; $('#show-more').disabled = true; message('#form-message', '');
  try {
    const found = await rpc('search', { query, field: field(), partial: true, offset: more ? results.length : 0, limit: 30 });
    if (version !== searchVersion) return;
    results = more ? [...results, ...found.records] : found.records; resultTotal = found.total; submitted = true; renderResults();
    if (!more) {
      $('#search-input').blur();
      if (found.total > 1) { openDialog('search-results-dialog'); $('#search-results-dialog .dialog-body').scrollTop = 0; }
      else { $('#search-results-dialog').close(); if (window.innerWidth < 701) $('.results-column').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    return found;
  } catch (error) { message('#form-message', error.message); }
  finally { $('#search-submit').disabled = false; $('#show-more').disabled = false; }
}
function renderTPChoices() {
  const query = norm($('#tp-filter').value);
  const choices = tpChoices.filter(tp => norm(tp.name).includes(query));
  $('#tp-list').innerHTML = choices.length ? choices.map(tp => `<button type="button" class="choice-item tp-choice" data-tp="${esc(tp.key)}"><span>${esc(tp.name)}</span><span class="tp-count">${number(tp.total)} ПУ</span></button>`).join('') : '<p class="hint">ТП не найдены.</p>';
}
function showTPPicker() {
  clearTimeout(tpFilterTimer); tpVersion++; tpBusy = false; tpSelection = null; tpMeters = []; tpViewKey = '';
  $('#tp-filter').value = tpPickerQuery;
  $('#tp-filter').placeholder = 'Найти ТП в списке'; $('#tp-filter-label').textContent = 'Найти ТП в списке';
  $('#tp-title').textContent = 'Реестр ТП'; $('#tp-meta').textContent = `В реестре: ${number(tpChoices.length)} ТП`;
  $('#tp-back').hidden = true; $('#tp-picker').hidden = false; $('#tp-register').hidden = true;
  message('#tp-message', ''); renderTPChoices(); $('#tp-body').scrollTop = tpPickerScroll;
}
function prepareTPReturn() {
  const dialog = $('#tp-dialog'), surface = dialog.querySelector('.dialog-surface');
  const preview = surface.cloneNode(true);
  preview.className = 'dialog-surface swipe-underlay'; preview.style.transform = '';
  preview.querySelector('#tp-back').hidden = true;
  preview.querySelector('#tp-title').textContent = 'Реестр ТП';
  preview.querySelector('#tp-meta').textContent = `В реестре: ${number(tpChoices.length)} ТП`;
  preview.querySelector('#tp-picker').hidden = false; preview.querySelector('#tp-register').hidden = true;
  preview.querySelector('#tp-filter').value = tpPickerQuery; preview.querySelector('#tp-filter').placeholder = 'Найти ТП в списке';
  preview.querySelector('#tp-message').hidden = true;
  preview.querySelector('[data-scroll-top]').hidden = tpPickerScroll < 260;
  preview.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  preview.inert = true; preview.setAttribute('aria-hidden', 'true');
  dialog.prepend(preview); preview.querySelector('.dialog-body').scrollTop = tpPickerScroll;
  dialog.classList.add('has-swipe-underlay');
  return () => { preview.remove(); dialog.classList.remove('has-swipe-underlay'); };
}
async function openTPs() {
  if (!summary || busy) { message('#form-message', 'Сначала подключите реестр предприятия.'); return; }
  openDialog('tp-dialog'); tpPickerQuery = ''; tpPickerScroll = 0; showTPPicker();
  const version = tpVersion, op = operation;
  $('#tp-list').innerHTML = '<div class="loading-row"><span class="loading-indicator"></span>Читаем список ТП…</div>';
  try {
    const choices = await rpc('tps');
    if (version !== tpVersion || op !== operation) return;
    tpChoices = choices; showTPPicker();
    if (!choices.length) message('#tp-message', 'В реестре нет заполненных значений в столбце «ТП».');
  } catch (error) { if (version === tpVersion) message('#tp-message', error.message); }
}
function renderTPMeters() {
  $('#tp-title').textContent = tpSelection.name;
  const count = tpSelection.totalInTP;
  $('#tp-meta').innerHTML = `<strong>${number(count)}</strong> ${subscribersWord(count)} · по уникальным ПУ${clean($('#tp-filter').value) ? `<span class="tp-filter-count">Найдено по запросу: ${number(tpSelection.total)} ПУ</span>` : ''}`;
  const unique = values => [...new Set(values.filter(Boolean))].join(' · ') || '—';
  $('#tp-meters').innerHTML = tpMeters.map((m, i) => `<button type="button" class="meter-item" data-tp-meter="${i}"><span class="meter-item-head"><span class="meter-number"><span class="number-label">Номер ПУ</span><strong>${esc(m.meter)}</strong></span><span class="meter-open-label">Открыть</span></span><span class="meter-details"><span><span class="number-label">Лицевой счёт</span><strong>${esc(unique(m.variants.map(v => v.account)))}</strong></span><span><span class="number-label">Точка учёта</span><strong>${esc(unique(m.variants.map(pointText)))}</strong></span></span><span class="meter-subscriber">${esc(unique(m.variants.map(v => v.name)))}</span>${m.variants.length > 1 ? `<span class="meter-duplicates">${recordsText(m.variants.length)} исходного реестра</span>` : ''}</button>`).join('');
  $('#tp-more').hidden = tpMeters.length >= tpSelection.total;
  $('#tp-missing').hidden = !tpSelection.missingMeters;
  $('#tp-missing').textContent = `Без номера ПУ: ${recordsText(tpSelection.missingMeters)}. Они не входят в количество абонентов по ПУ; их можно найти по ЛС.`;
  if (!tpSelection.total) $('#tp-meters').innerHTML = `<p class="hint">${clean($('#tp-filter').value) ? 'Совпадений нет. Попробуйте другой номер или часть названия.' : 'У этой ТП нет строк с заполненным номером ПУ.'}</p>`;
}
async function selectTP(key, more = false) {
  if (!summary || more && tpBusy) return;
  clearTimeout(tpFilterTimer);
  if (key !== tpViewKey) {
    tpPickerQuery = $('#tp-filter').value; tpPickerScroll = $('#tp-body').scrollTop;
    tpViewKey = key; $('#tp-filter').value = '';
    $('#tp-filter').placeholder = 'ПУ, ЛС или точка учёта'; $('#tp-filter-label').textContent = 'Найти ПУ, ЛС или точку учёта в этой ТП';
    $('#tp-filter').blur();
  }
  const query = clean($('#tp-filter').value);
  const version = ++tpVersion, op = operation; tpBusy = true; $('#tp-more').disabled = true;
  if (!more) {
    tpMeters = []; $('#tp-picker').hidden = true; $('#tp-register').hidden = false; $('#tp-back').hidden = false;
    $('#tp-title').textContent = tpChoices.find(tp => tp.key === key)?.name || 'Реестр ПУ'; $('#tp-meta').textContent = 'Загружаем…';
    $('#tp-meters').innerHTML = '<div class="loading-row">Готовим список ПУ…</div>'; $('#tp-more').hidden = true; $('#tp-missing').hidden = true; $('#tp-body').scrollTop = 0;
  }
  message('#tp-message', '');
  try {
    const found = await rpc('tpMeters', { key, query, offset: more ? tpMeters.length : 0, limit: 100 });
    if (version !== tpVersion || op !== operation) return;
    tpSelection = found; tpMeters = more ? [...tpMeters, ...found.meters] : found.meters;
    renderTPMeters();
  } catch (error) { if (version === tpVersion) message('#tp-message', error.message); }
  finally { if (version === tpVersion) { tpBusy = false; $('#tp-more').disabled = false; } }
}
function renderRecordSections(record) {
  const groups = groupRecordFields(record.labels, record.values);
  const render = empty => groups.map(group => {
    const fields = group.fields.filter(field => Boolean(field.value) !== empty);
    if (!fields.length) return '';
    return `<section class="record-section" data-tone="${group.key}"><h3>${esc(group.title)}</h3><dl>${fields.map(field => `<div class="detail-row"><dt title="${esc(field.label)}">${esc(field.displayLabel)}</dt><dd>${esc(field.value || '—')}</dd></div>`).join('')}</dl></section>`;
  }).join('');
  const emptyCount = groups.flatMap(group => group.fields).filter(field => !field.value).length;
  return `<div class="record-sections">${render(false)}</div>${emptyCount ? `<details class="empty-fields"><summary>Пустые поля (${emptyCount})</summary><div class="record-sections">${render(true)}</div></details>` : ''}`;
}
let activeRecord = null;
async function openRecord(id, context = { parent: null, variants: [] }) {
  const version = ++recordVersion, op = operation;
  try {
    const r = await rpc('record', { id });
    if (version !== recordVersion || op !== operation || context.parent && !$('#' + context.parent).open) return;
    activeRecord = r; recordContext = context;
    $('#record-body').innerHTML = `<div class="record-intro"><h3>${esc(r.fields.name || 'Абонент')}</h3><p>${esc(r.address)}</p></div><div class="record-main-numbers"><div class="quick-metric" data-tone="meter"><div class="number-label">Номер ПУ</div><div class="number-value">${esc(r.fields.meter || '—')}</div></div><div class="quick-metric" data-tone="account"><div class="number-label">Лицевой счёт</div><div class="number-value">${esc(r.fields.account || '—')}</div></div>${ratioLine(r)}</div><section class="consumption-action"><button class="primary analysis-button" id="consumer-analyze" type="button" ${consumptionState !== 'ready' || !r.fields.account ? 'disabled' : ''} aria-describedby="analysis-availability">${icon('chart')}<span>Провести анализ потребления потребителя</span></button><p class="hint" id="analysis-availability">${consumptionState === 'ready' ? 'Все строки ЛС + ТУ суммируются по месяцам. Анализируем общий объём точки.' : 'Для анализа загрузите «ПО.xls» или «ПО.xlsx» в папку РЭС.'}</p></section>${renderRecordSections(r)}<div class="record-source">${esc(r.file)}<br>Лист «${esc(r.sheet)}», строка ${r.row}${isDemo ? '<br>Демонстрационные данные' : ''}</div><button class="secondary copy-record" id="copy-record">${icon('copy')}Скопировать данные</button>`;
    $('#record-body .record-main-numbers').insertAdjacentHTML('beforeend', pointLine(r));
    if (context.variants.length > 1) {
      $('#record-body').insertAdjacentHTML('afterbegin', `<div class="record-variants"><label for="record-variant">Строки этого ПУ в реестре: ${context.variants.length}</label><select id="record-variant">${context.variants.map(v => `<option value="${esc(v.id)}" ${v.id === id ? 'selected' : ''}>${esc([pointText(v), 'ЛС ' + (v.account || '—'), v.sheet + ', строка ' + v.row].join(' · '))}</option>`).join('')}</select></div>`);
    }
    $('#record-back').hidden = !context.parent;
    $('#record-back').setAttribute('aria-label', context.parent === 'tp-dialog' ? 'К списку ПУ' : context.parent === 'notes-dialog' ? 'К примечаниям' : 'К результатам');
    if (context.parent) { if (!$('#record-dialog').open) $('#record-dialog').showModal(); }
    else openDialog('record-dialog');
    $('#record-body').scrollTop = 0;
  } catch (error) { message('#form-message', error.message); }
}
const notesUI = initNotesUI({ request: rpc, openDialog, openRecord });
const loadMap = initLoadMap(rootUrl);
const diagnosticsUI = initDiagnosticsUI({ openDialog, showSettings, context: () => ({
  sourceState, registryState, registryError, filesState, filesError, selectedRes: selectedRes?.name,
  selectedFile: selectedFile?.name, pending: Boolean(pending), offline: !navigator.onLine, serverMode: proxy,
}) });
const analysisUI = initAnalysisUI({ request: monthlyRPC, isReady: () => consumptionState === 'ready', getIncoming: () => ({ ready: incomingState === 'ready', name: incomingFile?.name }), showConnection: showSettings, onMapOpen: loadMap.refresh });
$('#record-body').addEventListener('click', e => { if (e.target.closest('#consumer-analyze') && activeRecord) analysisUI.openConsumer(activeRecord.fields.account, { point: activeRecord.fields.point, pointNumber: activeRecord.fields.pointNumber, pointName: activeRecord.fields.pointName }); });
$('#contour-open').addEventListener('click', analysisUI.openTPs);
$('#tp-analyze').addEventListener('click', () => { if (tpSelection) analysisUI.openTP(tpSelection.name); });
$('#analysis-back').addEventListener('click', () => dialogControls.get('analysis-dialog').goBack());
function applyReading(box) {
  const parent=box.parentElement.parentElement, note=parent.querySelector('.reading-note'), formula=parent.querySelector('.reading-formula'), input=box.querySelector('input'), output=box.querySelector('output'), button=box.querySelector('button');
  note.hidden=true; formula.hidden=true;
  if (box.dataset.calculated==='true') { delete box.dataset.calculated; output.hidden=true;output.textContent='';input.hidden=false;input.value='';button.innerHTML=icon('check');button.setAttribute('aria-label','Рассчитать объём');input.focus();return; }
  try { const result=calculateReading(input.value,box.dataset.previous,box.dataset.ratio), fmt=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:6}).format(n);output.textContent=fmt(result.volume)+' кВт·ч';output.hidden=false;input.hidden=true;box.dataset.calculated='true';button.innerHTML=icon('close');button.setAttribute('aria-label','Очистить расчёт');formula.textContent=`(${fmt(result.actual)} − ${fmt(result.previous)}) × ${fmt(result.ratio)}`;formula.hidden=false;if(result.negative){note.textContent='Отрицательный объём. Проверьте показания и возможное переполнение счётчика.';note.hidden=false;} }
  catch(error){note.textContent=error.message;note.hidden=false;input.focus();}
}
document.addEventListener('click',e=>{const button=e.target.closest('[data-reading-action]');if(button)applyReading(button.closest('.reading-calculator'));});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.closest('.reading-calculator')){e.preventDefault();applyReading(e.target.closest('.reading-calculator'));}});
$('#settings-open').addEventListener('click', showSettings); $('#district-button').addEventListener('click', showEnterprises); $('#res-button').addEventListener('click', showRes);
document.addEventListener('click', e => {
  const indicator = e.target.closest('#base-indicator, #registry-indicator');
  if (indicator?.dataset.state === 'off') { diagnosticsUI.open(indicator.id === 'base-indicator' ? 'base' : 'registry'); return; }
  if (e.target.closest('[data-open-settings]')) showSettings();
  if (e.target.closest('[data-open-enterprises]')) showEnterprises();
  if (e.target.closest('[data-open-res]')) showRes();
});
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => dialogControls.get(button.closest('dialog').id).dismiss()));
document.querySelectorAll('dialog').forEach(dialog => {
  const controls = attachDialogSwipe(dialog, { close: () => dialog.close(), back: () => dialog.id === 'analysis-dialog' ? analysisUI.back() : dialog.id === 'tp-dialog' ? showTPPicker() : dialog.close(), canGoBack: () => dialog.id === 'analysis-dialog' ? analysisUI.canGoBack() : dialog.id === 'tp-dialog' ? Boolean(tpViewKey) : dialog.id === 'record-dialog' && Boolean(recordContext.parent && $('#' + recordContext.parent).open), prepareBack: dialog.id === 'tp-dialog' ? prepareTPReturn : null });
  dialogControls.set(dialog.id, controls);
  dialog.addEventListener('cancel', e => { e.preventDefault(); controls.dismiss(); });
  dialog.addEventListener('click', e => { if (e.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) controls.dismiss(); });
  const top = dialog.querySelector('[data-scroll-top]'), body = dialog.querySelector('.dialog-body');
  if (top) {
    body.addEventListener('scroll', () => { top.hidden = body.scrollTop < 260; }, { passive: true });
    top.addEventListener('click', () => body.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
    dialog.addEventListener('close', () => { top.hidden = true; });
  }
});
$('#record-dialog').addEventListener('close', () => { recordVersion++; activeRecord = null; });
$('#tp-dialog').addEventListener('close', () => { clearTimeout(tpFilterTimer); tpVersion++; tpBusy = false; });
$('#record-back').addEventListener('click', () => dialogControls.get('record-dialog').goBack());
$('#record-body').addEventListener('change', e => { if (e.target.id === 'record-variant') openRecord(e.target.value, recordContext); });
$('#tp-open').addEventListener('click', openTPs);
$('#tp-back').addEventListener('click', () => dialogControls.get('tp-dialog').goBack());
$('#tp-filter').addEventListener('input', () => {
  clearTimeout(tpFilterTimer);
  if (!tpViewKey) { tpPickerQuery = $('#tp-filter').value; tpPickerScroll = 0; $('#tp-body').scrollTop = 0; renderTPChoices(); }
  else { tpVersion++; tpFilterTimer = setTimeout(() => selectTP(tpViewKey), 160); }
});
$('#tp-list').addEventListener('click', e => { const b = e.target.closest('[data-tp]'); if (b) selectTP(b.dataset.tp); });
$('#tp-more').addEventListener('click', () => selectTP(tpSelection.key, true));
$('#tp-meters').addEventListener('click', e => { const b = e.target.closest('[data-tp-meter]'); if (!b) return; const meter = tpMeters[Number(b.dataset.tpMeter)]; openRecord(meter.variants[0].id, { parent: 'tp-dialog', variants: meter.variants }); });
$('#read-folders').addEventListener('click', refreshSources);
$('#folder-list').addEventListener('click', e => { const button = e.target.closest('[data-folder]'); if (button) selectFolder(Number(button.dataset.folder)); });
$('#res-list').addEventListener('click', e => { const button = e.target.closest('[data-res]'); if (button) selectRes(Number(button.dataset.res)); });
$('#confirm-mapping').addEventListener('click', () => confirmMapping());
$('#mapping-fields').addEventListener('change', updateMapPreview);
$('#local-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try { if (!isRegistryFile(file.name)) throw new Error(`Для поиска выберите файл «${REGISTRY_NAME}».`); selectedFolder = null; selectedRes = null; resFolders = []; resState = 'idle'; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; renderIndicators(); if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Реестр больше 40 МБ.'); await loadBuffer(await file.arrayBuffer(), { name: file.name, folder: 'Файл на устройстве', type: 'local', modified: file.lastModified }); }
  catch (error) { setBusy(false); message('#settings-message', error.message); }
  e.target.value = '';
});
$('#local-monthly').addEventListener('change', async e => {
  const file=e.target.files[0]; if(!file)return; const op=operation;
  try {
    if(!summary)throw new Error('Сначала откройте реестр и подтвердите его столбцы.');
    if(!isConsumptionFile(file.name))throw new Error(`Выберите «${CONSUMPTION_NAME}».`);
    if(file.size>(config.maxFileMB||40)*1048576)throw new Error('Файл больше 40 МБ.');
    resetMonthly(); analysisUI.reset(); setBusy(true,'Читаем файл потребления…');
    consumptionFile={name:file.name};consumptionState='checking';renderIndicators();
    const info = await loadMonthlyBuffer(await file.arrayBuffer()); if(op!==operation)return; consumptionInfo=info;
    consumptionState='ready';message('#settings-message','Потребление готово к анализу.');
  } catch(error){if(op===operation){consumptionState='error';consumptionError=error.message;message('#settings-message',error.message);}}
  finally{if(op===operation){setBusy(false);renderIndicators();}e.target.value='';}
});
$('#search-form').addEventListener('submit', e => { e.preventDefault(); doSearch(); });
$('#search-input').addEventListener('input', () => { $('#clear-query').hidden = !$('#search-input').value; submitted = false; searchVersion++; renderResults(); message('#form-message', ''); });
$('#clear-query').addEventListener('click', () => { $('#search-input').value = ''; $('#search-input').dispatchEvent(new Event('input')); $('#search-input').focus(); });
document.querySelectorAll('[name="field"]').forEach(input => input.addEventListener('change', () => { updateSearchMode(); submitted = false; results = []; searchVersion++; renderResults(); }));
$('#show-more').addEventListener('click', () => doSearch(true));
$('#demo-exit').addEventListener('click', () => clearDataset());
$('#results').addEventListener('click', e => { if (e.target.closest('#start-demo')) startDemo(); const button = e.target.closest('[data-record]'); if (button) openRecord(button.dataset.record); });
$('#search-modal-results').addEventListener('click', e => { const button = e.target.closest('[data-record]'); if (button) openRecord(button.dataset.record, { parent: 'search-results-dialog', variants: [] }); });
$('#example-queries').addEventListener('click', e => { const b = e.target.closest('[data-query]'); if (!b) return; $(`[name="field"][value="${b.dataset.field}"]`).checked = true; updateSearchMode(); $('#search-input').value = b.dataset.query; $('#clear-query').hidden = false; doSearch(); });
$('#record-body').addEventListener('click', async e => { if (!e.target.closest('#copy-record') || !activeRecord) return; try { await navigator.clipboard.writeText(activeRecord.labels.map((label, i) => `${label}: ${activeRecord.values[i] || '—'}`).join('\n')); toast('Данные скопированы'); } catch { toast('Браузер не разрешил копирование. Выделите текст карточки.'); } });

renderResults(); renderIndicators(); renderFolders();
await readConfiguration();
if (proxy && config.prepared && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => navigator.serviceWorker.getRegistration()).then(registration => registration && navigator.serviceWorker.ready).then(registration => {
    if (!registration) return;
    shellReady = true; renderIndicators();
  }).catch(() => { /* Online mode remains available. */ });
}
if (sourceState === 'ready' && await readFolders()) {
  const savedFolder = folders.find(f => f.path === prefs.folder?.path);
  if (savedFolder) await openFolder(savedFolder, { restore: true });
}
window.addEventListener('offline', () => {
  diskState = 'disconnected'; renderIndicators();
});

// Optional browser standard; uses exactly the same UI actions and current working area.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'search_subscribers', title: 'Найти абонента',
      description: 'Search the loaded subscriber registry and show results in the current interface. Requires a loaded registry.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, field: { type: 'string', enum: ['meter', 'account', 'address'] } }, required: ['query', 'field'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200 || !['meter','account','address'].includes(input.field)) throw new Error('Некорректный запрос.');
        if (!summary) throw new Error('Реестр не подключён.');
        $(`[name="field"][value="${input.field}"]`).checked = true; $('#search-input').value = input.query; updateSearchMode();
        const found = await doSearch(); if (!found) throw new Error('Поиск не выполнен.');
        return { total: found.total, records: found.records.map(r => ({ id: r.id, name: r.fields.name, meter: r.fields.meter, account: r.fields.account, address: r.address })) };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  } catch { /* Browsers without WebMCP use the regular interface. */ }
}
