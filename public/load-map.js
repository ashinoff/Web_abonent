const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const roles = [['registry','Реестр'],['consumption','ПО'],['incoming','Приём']];
const states = { ready:'В базе', pending:'Ожидает подготовки', stale:'Старая версия', missing:'Нет файла', error:'Ошибка' };
const date = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle:'short', timeStyle:'short' }) : '—';

export function initLoadMap(root) {
  const list = $('#load-map-list'), updated = $('#load-map-updated'), button = $('#load-map-refresh');
  let loading = false;
  function render(folders) {
    if (!folders.length) { list.innerHTML = '<div class="load-map-empty">Карта ещё формируется. Сервер проверит папки после запуска; обновите этот экран чуть позже.</div>'; return; }
    const groups = new Map();
    for (const folder of folders) {
      const key = folder.enterprise_path;
      if (!groups.has(key)) groups.set(key, { name: folder.enterprise_name, folders: [] });
      groups.get(key).folders.push(folder);
    }
    list.innerHTML = [...groups.values()].map(group => {
      const hasFiles = group.folders.some(folder => Object.values(folder.statuses || {}).some(item => item?.file || (item?.state && item.state !== 'missing')));
      return `<details class="load-map-enterprise"><summary><i class="load-map-lamp" data-state="${hasFiles ? 'present' : 'empty'}" aria-hidden="true"></i><strong>${esc(group.name)}</strong><small>${group.folders.length} РЭС · ${hasFiles ? 'есть файлы' : 'нет файлов'}</small><svg class="load-map-chevron" aria-hidden="true"><use href="#i-chevron"/></svg></summary><div class="load-map-res-list">${group.folders.map(folder => {
      const statuses = folder.statuses || {};
      const ready = roles.filter(([key]) => statuses[key]?.state === 'ready').length;
      return `<article class="load-map-res"><div class="load-map-res-title"><strong>${esc(folder.res_name)}</strong><small>${ready} из 3 готово</small></div><div class="load-map-statuses">${roles.map(([key,label]) => {
        const item = statuses[key] || { state:'missing' }, state = states[item.state] ? item.state : 'error';
        return `<span class="load-map-status" data-state="${state}" title="${esc(item.file || label)}"><i aria-hidden="true"></i>${label}: ${states[state]}</span>`;
      }).join('')}</div><small class="load-map-date">Проверено: ${esc(date(folder.checked_at))}</small></article>`;
    }).join('')}</div></details>`;
    }).join('');
  }
  async function refresh() {
    if (loading) return;
    loading = true; button.disabled = true; updated.textContent = 'Читаем карту из базы…';
    const key = 'abonent.load-map.v1:' + root();
    try {
      const response = await fetch(new URL('./api/load-map', location.href), { cache:'no-store', signal:AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Не удалось получить карту загрузки.');
      const data = await response.json();
      if (!Array.isArray(data.folders)) throw new Error('Неизвестный ответ базы.');
      render(data.folders);
      updated.textContent = `Данные базы · ${date(Date.now())}`;
      try { localStorage.setItem(key, JSON.stringify({ folders:data.folders, savedAt:Date.now() })); } catch {}
    } catch (error) {
      let cached; try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
      if (cached?.folders) {
        render(cached.folders);
        updated.textContent = `Сохранённая карта · ${date(cached.savedAt)}. Нет связи с базой.`;
      } else { list.innerHTML = `<div class="load-map-empty">${esc(error.message)}</div>`; updated.textContent = ''; }
    } finally { loading = false; button.disabled = false; }
  }
  button.addEventListener('click', refresh);
  return { refresh };
}
