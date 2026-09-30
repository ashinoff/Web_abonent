import { clean } from './core.js';
import { demo } from './demo.js';
import { newestRegistry, newestConsumption } from './source.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = n => new Intl.NumberFormat('ru-RU').format(n);
const recordsText = n => `${number(n)} ${n % 100 >= 11 && n % 100 <= 14 ? 'записей' : n % 10 === 1 ? 'запись' : n % 10 >= 2 && n % 10 <= 4 ? 'записи' : 'записей'}`;
const formatDate = value => value ? new Date(value).toLocaleDateString('ru-RU') : '';
const ratioLine = record => `<div class="transformer-ratio"><span>Коэф ТТ =</span> <strong>${esc(record.fields.transformerRatio || '—')}</strong></div>`;
const initial = window.ABONENT_CONFIG || {};
let config = { ...initial }, proxy = false, folders = [], selectedFolder = null, selectedFile = null;
let sourceState = 'loading', diskState = 'checking', directoryState = 'loading', folderRead = null;
let consumptionFile = null, consumptionState = 'idle', registryState = 'idle', busyText = '';
let summary = null, pending = null, currentSource = null, isDemo = false, busy = false, operation = 0;
let results = [], resultTotal = 0, submitted = false, searchVersion = 0, worker, requestId = 0, prefs = {};
const requests = new Map();
try { prefs = JSON.parse(localStorage.getItem('abonent.preferences.v1') || '{}'); } catch { /* Preferences are optional. */ }
function savePrefs() { try { localStorage.setItem('abonent.preferences.v1', JSON.stringify(prefs)); } catch { /* Private browsing can disable storage. */ } }
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url));
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
    const timer = setTimeout(() => resetWorker(new Error('Чтение реестра заняло слишком много времени. Попробуйте файл меньшего размера.')), 120000);
    requests.set(id, { resolve, reject, timer });
    w.postMessage({ id, action, payload }, transfer);
  });
}
function message(target, value, loading = false) { const el = $(target); el.textContent = value; el.hidden = !value; el.classList.toggle('loading', loading); }
function toast(value) { $('#toast').textContent = value; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 3000); }
function setBusy(value, text = '') {
  busy = value; busyText = text;
  for (const sel of ['#confirm-mapping', '#local-file', '#search-submit']) $(sel).disabled = value;
  $('#read-folders').disabled = value || sourceState === 'loading' || directoryState === 'loading';
  document.querySelectorAll('.choice-item').forEach(el => { el.disabled = value; });
  $('#refresh').disabled = value;
  if (text || !value) message('#settings-message', text, value);
  updateSource(); renderIndicators(); renderResults();
}
function openDialog(id) {
  for (const dialog of document.querySelectorAll('dialog[open]')) if (dialog.id !== id) dialog.close();
  const dialog = $('#' + id);
  if (!dialog.open) dialog.showModal();
}
function showSettings() { renderIndicators(); openDialog('settings-dialog'); }
function showEnterprises() {
  openDialog('enterprise-dialog'); renderFolders();
  if (sourceState !== 'loading' && directoryState !== 'ready' && !busy) readFolders();
}
function rootUrl() { return clean(config.publicUrl); }
function renderIndicators() {
  const diskText = diskState === 'connected' ? 'Общая папка доступна' : diskState === 'checking' ? 'Проверяем подключение…' : sourceState === 'missing' ? 'Общая папка не подключена' : 'Не удалось прочитать папку';
  const registryText = registryState === 'ready' ? 'Реестр готов к поиску' : registryState === 'checking' ? busyText || 'Проверяем реестр…' : registryState === 'error' ? pending ? 'Подтвердите столбцы в настройках' : 'Реестр не загружен' : 'Сначала выберите предприятие';
  const consumptionText = consumptionState === 'found' ? 'Найден: ' + consumptionFile.name : consumptionState === 'checking' ? 'Ищем файл в папке предприятия…' : consumptionState === 'missing' ? 'Файл «Потребление» не найден' : consumptionState === 'error' ? 'Не удалось проверить наличие файла' : 'Сначала выберите предприятие';
  for (const [name, state, label] of [
    ['disk', diskState === 'connected' ? 'on' : diskState === 'checking' ? 'checking' : 'off', diskText],
    ['registry', registryState === 'ready' ? 'on' : registryState === 'checking' ? 'checking' : registryState === 'idle' ? 'idle' : 'off', registryText],
    ['consumption', consumptionState === 'found' ? 'on' : consumptionState === 'checking' ? 'checking' : consumptionState === 'idle' ? 'idle' : 'off', consumptionText],
  ]) {
    const indicator = $('#' + name + '-indicator');
    indicator.dataset.state = state; indicator.title = label;
    $('#' + name + '-indicator-label').textContent = label;
  }
  $('#disk-detail').textContent = diskText;
  $('#enterprise-detail').textContent = selectedFolder?.name || 'Не выбрано';
  $('#registry-detail').textContent = currentSource?.type === 'local' ? currentSource.name + ' · с устройства' : currentSource?.type === 'demo' ? 'Демонстрационный реестр' : (selectedFile ? selectedFile.name + ' · ' : '') + registryText;
  $('#consumption-detail').textContent = consumptionText;
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
    } else if (response.status === 404 || response.ok) {
      proxy = false; config = { ...initial }; // Static hosting uses its fixed config.js only.
    } else throw new Error('Настройки сервера недоступны.');
    sourceState = rootUrl() ? 'ready' : 'missing';
    if (rootUrl()) validateRoot(rootUrl());
  } catch { sourceState = 'error'; }
  if (sourceState !== 'ready') { diskState = 'disconnected'; directoryState = 'error'; consumptionFile = null; consumptionState = selectedFolder ? 'error' : 'idle'; registryState = selectedFolder ? 'error' : 'idle'; }
  renderSourceState();
}
function validateRoot(value) {
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password && !u.port && ['disk.yandex.ru', 'disk.yandex.com', 'disk.yandex.net', 'disk.360.yandex.ru', 'yadi.sk'].includes(u.hostname) && /^\/(d|i)\/[\w-]+\/?$/.test(u.pathname)) return `${u.origin}${u.pathname}`; } catch {}
  throw new Error('Адрес общей папки настроен некорректно. Обратитесь к администратору приложения.');
}
async function apiRequest(action, path = '/', offset = 0) {
  const base = config.apiBase || (proxy ? new URL('./api/', location.href).href : 'https://cloud-api.yandex.net/v1/disk/public/');
  const endpoint = proxy || config.apiBase ? action : action === 'download' ? 'resources/download' : 'resources';
  const url = new URL(endpoint, base.endsWith('/') ? base : base + '/');
  if (!proxy && !config.apiBase) url.searchParams.set('public_key', validateRoot(rootUrl()));
  url.searchParams.set('path', path);
  if (action === 'resources') { url.searchParams.set('offset', offset); url.searchParams.set('limit', 100); url.searchParams.set('sort', 'name'); }
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(action === 'download' ? 90000 : 25000), credentials: 'same-origin' }); }
  catch { throw new Error(proxy ? 'Нет ответа от Яндекс Диска. Проверьте соединение и повторите.' : 'Браузер не смог получить файл с Яндекс Диска. Откройте Excel с устройства или используйте версию на Амвере.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const text = { 404: 'Папка не найдена. Проверьте ссылку и доступ.', 403: 'Доступ к файлу ограничен. Разрешите скачивание по ссылке.', 429: 'Слишком много запросов к Диску. Повторите позже.', 413: 'Файл превышает 40 МБ.' };
    throw new Error(body.error && !/^[A-Za-z]+Error$/.test(body.error) ? body.error : text[response.status] || 'Не удалось получить данные Яндекс Диска.');
  }
  return response;
}
async function listFolder(path) {
  let all = [], offset = 0;
  while (true) {
    const data = await (await apiRequest('resources', path, offset)).json();
    if (data.type !== 'dir') throw new Error('По ссылке расположен файл. Нужна общая папка с предприятиями электрических сетей.');
    const part = data._embedded?.items || []; all.push(...part); offset += part.length;
    if (!part.length || offset >= (data._embedded?.total ?? offset)) break;
    if (offset > 10000) throw new Error('В папке слишком много файлов. Разделите её на папки предприятий.');
  }
  return all;
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
      if (prefs.root !== root) { folders = []; selectedFolder = null; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; clearDataset(); prefs = { root }; savePrefs(); }
      folders = (await listFolder('/')).filter(f => f.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      directoryState = 'ready'; diskState = 'connected';
      if (!selectedFolder) { consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; }
      return true;
    } catch (error) {
      directoryState = 'error'; diskState = 'disconnected'; consumptionFile = null; consumptionState = selectedFolder ? 'error' : 'idle'; registryState = selectedFolder ? 'error' : 'idle';
      message('#settings-message', error.message);
      return false;
    } finally { renderSourceState(); }
  })();
  try { return await folderRead; } finally { folderRead = null; }
}
async function refreshSources() {
  if (busy || folderRead) return;
  message('#settings-message', '');
  await readConfiguration();
  if (sourceState !== 'ready' || !await readFolders()) return;
  const folder = folders.find(f => f.path === selectedFolder?.path || f.path === prefs.folder?.path);
  if (folder) await openFolder(folder);
  else if (selectedFolder || prefs.folder) {
    clearDataset(); selectedFolder = null; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle';
    prefs = { root: rootUrl() }; savePrefs(); updateSource(); renderIndicators();
    message('#settings-message', 'Выбранное предприятие больше не найдено. Выберите другое на главном экране.');
  }
}
async function selectFolder(i) {
  if (busy || !folders[i]) return;
  $('#enterprise-dialog').close();
  await openFolder(folders[i]);
}
async function openFolder(folder) {
  if (busy) return;
  clearDataset();
  selectedFolder = folder; selectedFile = null; consumptionFile = null; consumptionState = 'checking'; registryState = 'checking'; diskState = 'checking';
  if (prefs.folder?.path !== folder.path || prefs.root !== rootUrl()) prefs = { root: rootUrl() };
  prefs.folder = { name: folder.name, path: folder.path }; savePrefs();
  renderFolders();
  let listed = false;
  try {
    setBusy(true, 'Читаем реестры предприятия…');
    const items = await listFolder(folder.path); listed = true; diskState = 'connected';
    consumptionFile = newestConsumption(items); consumptionState = consumptionFile ? 'found' : 'missing';
    selectedFile = newestRegistry(items);
    setBusy(false);
    if (!selectedFile) { registryState = 'error'; renderIndicators(); message('#settings-message', 'Реестр абонентов не найден. Добавьте Excel в папку предприятия. Файл «Потребление» в поиске не используется.'); showSettings(); return; }
    await downloadFile();
  } catch (error) {
    if (!listed) { diskState = 'disconnected'; consumptionFile = null; consumptionState = selectedFolder ? 'error' : 'idle'; registryState = selectedFolder ? 'error' : 'idle'; }
    setBusy(false); message('#settings-message', error.message); showSettings();
  }
}
async function boundedBuffer(response) {
  const max = (config.maxFileMB || 40) * 1048576;
  if (Number(response.headers.get('content-length')) > max) throw new Error(`Реестр больше ${config.maxFileMB || 40} МБ.`);
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > max) throw new Error('Реестр превышает допустимый размер.'); chunks.push(value); }
  } catch (error) { await reader.cancel(); throw error; }
  const buffer = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return buffer.buffer;
}
async function downloadFile() {
  if (busy || !selectedFile || !selectedFolder) return;
  let file = selectedFile; const folder = selectedFolder;
  try {
    if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Реестр больше 40 МБ. Разделите его на несколько файлов.');
    setBusy(true, 'Загружаем реестр…');
    const latest = await (await apiRequest('resources', file.path)).json();
    if (latest.type !== 'file') throw new Error('Выбранный реестр больше не найден. Обновите реестр предприятия.');
    file = { ...file, ...latest }; selectedFile = file;
    let response = await apiRequest('download', file.path);
    if (!proxy && !config.apiBase) {
      const { href } = await response.json();
      const url = new URL(href);
      if (url.protocol !== 'https:' || !['yandex.ru','yandex.net','yandex.com','yandexdisk.com'].some(h => url.hostname === h || url.hostname.endsWith('.' + h))) throw new Error('Неподдерживаемый адрес скачивания.');
      try { response = await fetch(href, { signal: AbortSignal.timeout(90000) }); } catch { throw new Error('Браузер заблокировал скачивание с Диска. Откройте Excel с устройства или используйте версию на Амвере.'); }
      if (!response.ok) throw new Error('Не удалось скачать Excel. Проверьте доступ по ссылке.');
    }
    const buffer = await boundedBuffer(response);
    await loadBuffer(buffer, { name: file.name, folder: folder.name, modified: file.modified, type: 'disk', root: rootUrl(), folderInfo: folder, fileInfo: file });
  } catch (error) { registryState = 'error'; setBusy(false); message('#settings-message', error.message); showSettings(); }
}
function clearDataset() {
  operation++; searchVersion++; resetWorker(); summary = null; pending = null; currentSource = null; isDemo = false; submitted = false; results = []; resultTotal = 0;
  $('#mapping-section').hidden = true; $('#search-input').value = ''; $('#clear-query').hidden = true;
  updateSource(); renderResults();
}
async function loadBuffer(buffer, source) {
  clearDataset(); const op = operation;
  setBusy(true, 'Читаем Excel и определяем столбцы…');
  const data = await rpc('load', { buffer, file: source.name }, [buffer]);
  if (operation !== op) return;
  pending = { ...data, source };
  if (source.type === 'disk' && prefs.mappingSignature === signature(data) && prefs.folder?.path === source.folderInfo.path && prefs.root === source.root) {
    await confirmMapping(prefs.overrides || {}, true);
  } else if (source.type === 'disk' && !data.skipped.length && data.sheets.every(s => !s.layout.flattened && s.layout.mapping.meter !== undefined && s.layout.mapping.account !== undefined)) {
    const overrides = Object.fromEntries(data.sheets.map(s => [s.sheet, { meter: s.layout.mapping.meter, account: s.layout.mapping.account }]));
    await confirmMapping(overrides, true);
  } else { if (source.type === 'disk') registryState = 'error'; renderMapping(); setBusy(false); renderResults(); showSettings(); $('#mapping-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
function signature(data) { return JSON.stringify(data.sheets.map(s => [s.sheet, s.layout.labels])); }
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
    if (currentSource.type === 'disk') {
      prefs = { root: currentSource.root, folder: { name: currentSource.folderInfo.name, path: currentSource.folderInfo.path }, file: { name: currentSource.fileInfo.name, path: currentSource.fileInfo.path }, mappingSignature: signature(pending), overrides };
      savePrefs();
    }
    registryState = currentSource.type === 'disk' ? 'ready' : 'idle';
    pending = null; $('#mapping-section').hidden = true; setBusy(false); updateSource(); renderResults();
    $('#settings-dialog').close(); toast(`Реестр готов: ${recordsText(summary.count)}`);
    if (data.skipped.length) message('#form-message', `Пропущено листов: ${data.skipped.length}. ${data.skipped.map(s => s.sheet + ': ' + s.error).join(' ')}`);
  } catch (error) { if (pending?.source.type === 'disk') registryState = 'error'; setBusy(false); message('#settings-message', error.message); showSettings(); }
}
async function startDemo() {
  if (busy) return;
  try {
    clearDataset(); selectedFolder = null; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; setBusy(true); summary = await rpc('demo', demo); isDemo = true;
    currentSource = { name: 'Демонстрационный реестр', folder: 'Сочинские ЭС · пример', type: 'demo' };
    updateSource(); renderResults(); $('#search-input').focus();
  } catch (error) { message('#form-message', error.message); }
  finally { setBusy(false); }
}
function updateSource() {
  $('#source-name').textContent = currentSource?.name || 'Реестр не подключён';
  $('#source-meta').textContent = busy && busyText ? busyText : summary ? `${recordsText(summary.count)} · ${currentSource.modified ? 'Файл от ' + formatDate(currentSource.modified) : currentSource.type === 'local' ? 'Файл с устройства' : 'Готов к поиску'}` : 'Выберите предприятие';
  $('#district-label').textContent = currentSource?.folder || selectedFolder?.name || 'Выберите предприятие';
  $('#refresh').hidden = currentSource?.type !== 'disk';
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
  $('.switch-label').hidden = type === 'address';
  $('#match-hint').textContent = type === 'address' ? 'По всем словам адреса' : $('#partial').checked ? 'Номер содержит запрос' : 'Точное совпадение';
}
function emptyState(title, text, type = 'search', actions = '') { return `<div class="empty-state"><div class="empty-mark">${icon(type)}</div><h3>${title}</h3><p>${text}</p>${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`; }
function renderResults() {
  $('#show-more').hidden = true; $('#results-count').textContent = ''; $('#results-title').textContent = submitted ? 'Найденные абоненты' : 'Результаты поиска';
  if (!summary && busy) { $('#results').innerHTML = emptyState('Загружаем реестр', busyText || 'Подготавливаем поиск…', 'file'); return; }
  if (!summary) {
    $('#results').innerHTML = emptyState(pending ? 'Проверьте столбцы реестра' : 'Выберите предприятие', pending ? 'Подтвердите номера ПУ и лицевых счетов в настройках.' : 'Выберите предприятие электрических сетей. Реестр абонентов загрузится автоматически.', 'folder', `<button class="secondary" ${pending ? 'data-open-settings' : 'data-open-enterprises'}>${pending ? 'Открыть настройки' : 'Выбрать предприятие'}</button>` + (pending ? '' : '<button class="text-button" id="start-demo">Посмотреть пример</button>'));
    return;
  }
  if (!submitted) { $('#results').innerHTML = emptyState('Можно искать', `В реестре ${recordsText(summary.count)}. Введите номер ПУ, лицевой счёт или адрес.`, 'search'); return; }
  $('#results-count').textContent = recordsText(resultTotal);
  if (!results.length) { $('#results').innerHTML = emptyState('Совпадений нет', field() === 'address' ? 'Попробуйте указать только улицу и номер дома.' : 'Проверьте номер и выбранное предприятие. Можно включить поиск по части номера.'); return; }
  $('#results').innerHTML = results.map(r => `<article class="result-card"><div class="result-top"><h3 class="result-name">${esc(r.fields.name || 'Абонент без наименования')}</h3>${r.fields.status ? `<span class="status ${/откл/i.test(r.fields.status) ? 'off' : ''}">${esc(r.fields.status)}</span>` : ''}</div><p class="result-address">${icon('pin')}<span>${esc(r.address || 'Адрес не указан в реестре')}</span></p><div class="result-numbers"><div><div class="number-label">НОМЕР ПУ</div><div class="number-value">${esc(r.fields.meter || '—')}</div></div><div><div class="number-label">ЛИЦЕВОЙ СЧЁТ</div><div class="number-value">${esc(r.fields.account || '—')}</div></div>${ratioLine(r)}</div><div class="result-bottom"><span>${esc(r.fields.tp || r.sheet)} · строка ${r.row}</span><button class="record-open" data-record="${esc(r.id)}">Все данные</button></div></article>`).join('');
  $('#show-more').hidden = results.length >= resultTotal;
}
async function doSearch(more = false) {
  const query = clean($('#search-input').value);
  if (!summary) { message('#form-message', pending ? 'Подтвердите столбцы реестра в настройках.' : 'Сначала подключите реестр в настройках.'); return; }
  if (!query) { message('#form-message', 'Введите номер или адрес для поиска.'); $('#search-input').focus(); return; }
  const version = ++searchVersion;
  $('#search-submit').disabled = true; $('#show-more').disabled = true; message('#form-message', '');
  try {
    const found = await rpc('search', { query, field: field(), partial: $('#partial').checked, offset: more ? results.length : 0, limit: 30 });
    if (version !== searchVersion) return;
    results = more ? [...results, ...found.records] : found.records; resultTotal = found.total; submitted = true; renderResults();
    if (!more && window.innerWidth < 701) { $('#search-input').blur(); $('.results-column').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    return found;
  } catch (error) { message('#form-message', error.message); }
  finally { $('#search-submit').disabled = false; $('#show-more').disabled = false; }
}
let activeRecord = null;
async function openRecord(id) {
  try {
    const r = await rpc('record', { id }); activeRecord = r;
    const rows = r.labels.map((label, i) => `<div class="detail-row"><dt>${esc(label)}</dt><dd>${esc(r.values[i] || '—')}</dd></div>`);
    const populated = rows.filter((_, i) => r.values[i]), blank = rows.filter((_, i) => !r.values[i]);
    $('#record-body').innerHTML = `<div class="record-intro"><h3>${esc(r.fields.name || 'Абонент')}</h3><p>${esc(r.address)}</p></div><div class="record-main-numbers"><div><div class="number-label">Номер ПУ</div><div class="number-value">${esc(r.fields.meter || '—')}</div></div><div><div class="number-label">Лицевой счёт</div><div class="number-value">${esc(r.fields.account || '—')}</div></div>${ratioLine(r)}</div><section class="consumption-action"><button class="primary analysis-button" type="button" disabled aria-describedby="analysis-availability">${icon('chart')}<span>Провести анализ потребления потребителя</span><span class="soon-badge">Скоро</span></button><p class="hint" id="analysis-availability">${currentSource?.type === 'disk' && consumptionFile ? `Файл «${esc(consumptionFile.name)}» найден. Анализ будет доступен на следующем этапе.` : 'Анализ будет доступен на следующем этапе. Для него нужен файл «Потребление» в папке предприятия.'}</p></section><div class="details-title">ВСЕ ПОЛЯ СТРОКИ</div><dl>${populated.join('')}</dl>${blank.length ? `<details><summary class="hint">Пустые поля (${blank.length})</summary><dl>${blank.join('')}</dl></details>` : ''}<div class="record-source">${esc(r.file)}<br>Лист «${esc(r.sheet)}», строка ${r.row}${isDemo ? '<br>Демонстрационные данные' : ''}</div><button class="secondary copy-record" id="copy-record">${icon('copy')}Скопировать данные</button>`;
    $('#record-dialog').showModal();
  } catch (error) { message('#form-message', error.message); }
}
$('#settings-open').addEventListener('click', showSettings); $('#district-button').addEventListener('click', showEnterprises);
document.addEventListener('click', e => { if (e.target.closest('[data-open-settings]')) showSettings(); if (e.target.closest('[data-open-enterprises]')) showEnterprises(); });
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); }));
$('#read-folders').addEventListener('click', refreshSources);
$('#folder-list').addEventListener('click', e => { const button = e.target.closest('[data-folder]'); if (button) selectFolder(Number(button.dataset.folder)); });
$('#confirm-mapping').addEventListener('click', () => confirmMapping());
$('#mapping-fields').addEventListener('change', updateMapPreview);
$('#local-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try { selectedFolder = null; selectedFile = null; consumptionFile = null; consumptionState = 'idle'; registryState = 'idle'; renderIndicators(); if (file.size > (config.maxFileMB || 40) * 1048576) throw new Error('Реестр больше 40 МБ.'); await loadBuffer(await file.arrayBuffer(), { name: file.name, folder: 'Файл на устройстве', type: 'local', modified: file.lastModified }); }
  catch (error) { setBusy(false); message('#settings-message', error.message); }
  e.target.value = '';
});
$('#search-form').addEventListener('submit', e => { e.preventDefault(); doSearch(); });
$('#search-input').addEventListener('input', () => { $('#clear-query').hidden = !$('#search-input').value; submitted = false; searchVersion++; renderResults(); message('#form-message', ''); });
$('#clear-query').addEventListener('click', () => { $('#search-input').value = ''; $('#search-input').dispatchEvent(new Event('input')); $('#search-input').focus(); });
document.querySelectorAll('[name="field"]').forEach(input => input.addEventListener('change', () => { updateSearchMode(); submitted = false; results = []; searchVersion++; renderResults(); }));
$('#partial').addEventListener('change', () => { updateSearchMode(); submitted = false; searchVersion++; renderResults(); });
$('#show-more').addEventListener('click', () => doSearch(true));
$('#refresh').addEventListener('click', () => { if (currentSource?.type !== 'disk') return; const folder = currentSource.folderInfo; openFolder(folder); });
$('#demo-exit').addEventListener('click', clearDataset);
$('#results').addEventListener('click', e => { if (e.target.closest('#start-demo')) startDemo(); const button = e.target.closest('[data-record]'); if (button) openRecord(button.dataset.record); });
$('#example-queries').addEventListener('click', e => { const b = e.target.closest('[data-query]'); if (!b) return; $(`[name="field"][value="${b.dataset.field}"]`).checked = true; updateSearchMode(); $('#search-input').value = b.dataset.query; $('#clear-query').hidden = false; doSearch(); });
$('#record-body').addEventListener('click', async e => { if (!e.target.closest('#copy-record') || !activeRecord) return; try { await navigator.clipboard.writeText(activeRecord.labels.map((label, i) => `${label}: ${activeRecord.values[i] || '—'}`).join('\n')); toast('Данные скопированы'); } catch { toast('Браузер не разрешил копирование. Выделите текст карточки.'); } });

renderResults(); renderIndicators(); renderFolders();
await readConfiguration();
if (sourceState === 'ready' && await readFolders()) {
  const savedFolder = folders.find(f => f.path === prefs.folder?.path);
  if (savedFolder) await openFolder(savedFolder);
}
window.addEventListener('offline', () => {
  diskState = 'disconnected'; consumptionFile = null; consumptionState = selectedFolder ? 'error' : 'idle'; registryState = selectedFolder ? 'error' : 'idle'; renderIndicators();
});

// Optional browser standard; uses exactly the same UI actions and current working area.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'search_subscribers', title: 'Найти абонента',
      description: 'Search the loaded subscriber registry and show results in the current interface. Requires a loaded registry.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, field: { type: 'string', enum: ['meter', 'account', 'address'] }, partial: { type: 'boolean' } }, required: ['query', 'field'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200 || !['meter','account','address'].includes(input.field) || (input.partial !== undefined && typeof input.partial !== 'boolean')) throw new Error('Некорректный запрос.');
        if (!summary) throw new Error('Реестр не подключён.');
        $(`[name="field"][value="${input.field}"]`).checked = true; $('#search-input').value = input.query; $('#partial').checked = Boolean(input.partial); updateSearchMode();
        const found = await doSearch(); if (!found) throw new Error('Поиск не выполнен.');
        return { total: found.total, records: found.records.map(r => ({ id: r.id, name: r.fields.name, meter: r.fields.meter, account: r.fields.account, address: r.address })) };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  } catch { /* Browsers without WebMCP use the regular interface. */ }
}
