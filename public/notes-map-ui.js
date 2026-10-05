import { groupMapNotes,visibleMapGroups,exactCandidate,validLocation,readMapLocations,saveMapLocation } from './notes-map-data.js';
import { loadMapLibrary } from './map-library.js';
import { createMapRoutes } from './map-routes.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const number = value => new Intl.NumberFormat('ru-RU').format(value);
export function initNotesMapUI({ request,openRecord,openUserNote=()=>{},deleteUserNote=()=>{},context,onMeta,loadLeaflet = loadMapLibrary,fetcher = (...args) => fetch(...args) }) {
  const $ = selector => document.querySelector(selector);
  const panel = $('#notes-map-panel'), canvas = $('#notes-map-canvas'), status = $('#notes-map-status');
  const find = $('#notes-map-find'), stopButton = $('#notes-map-stop'), details = $('#notes-map-detail');
  let map, layer, L, groups = [], scope = '', loaded = false, visible = false, query = '', generation = 0;
  let controller = null, loading = false, selected = '', placing = '', preview = null, previewMarker = null;
  let userNotes = [], origin = 'all';
  const visibleGroups = value => visibleMapGroups(value,query,origin);
  const showStatus = text => { status.textContent = text; status.hidden = !text; };
  const currentGroup = key => groups.find(group => group.key === key);
  function stop(text = '') {
    controller?.abort(); controller = null; loading = false;
    stopButton.hidden = true; find.hidden = false; find.disabled = !loaded || !navigator.onLine;
    if (text) showStatus(text);
  }
  function cancelPlacement() {
    placing = ''; preview = null; if (previewMarker) { previewMarker.remove(); previewMarker = null; }
    $('#notes-map-save').hidden = true; $('#notes-map-cancel').hidden = true;
    canvas.classList.remove('placing');
  }
  function fit() {
    if (!map) return;
    const locations = visibleGroups(groups).map(group => group.location).filter(validLocation);
    if (locations.length) map.fitBounds(locations.map(value => [value.lat,value.lon]), { padding:[36,36],maxZoom:17,animate:false });
  }
  function recordButton(note) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'map-note-card';
    button.dataset.origin = note.type === 'user' ? 'user' : 'registry';
    button.innerHTML = `<span class="note-origin" data-origin="${button.dataset.origin}">${note.type === 'user' ? 'Пользовательское' : 'Из реестра'}</span><span class="map-note-name">${esc(note.fields.name || 'Абонент')}</span><span class="map-note-ids">ПУ ${esc(note.fields.meter || '—')} · ЛС ${esc(note.fields.account || '—')}</span><span class="map-note-text">${esc(note.note)}</span><span class="map-note-open">Открыть карточку →</span>`;
    button.addEventListener('click', () => note.type === 'user' ? openUserNote(note) : openRecord(note.id,{ parent:'notes-dialog',variants:[] }));
    if (note.type !== 'user') return button;
    const wrapper=document.createElement('div');wrapper.className='map-user-note';wrapper.append(button);
    const remove=document.createElement('button');remove.type='button';remove.className='user-note-delete';remove.textContent='Удалить отметку';
    remove.addEventListener('click',()=>deleteUserNote(note));wrapper.append(remove);return wrapper;
  }
  function selectGroup(key) {
    cancelPlacement(); selected = key; const group = currentGroup(key); if (!group) return;
    details.replaceChildren(); details.hidden = false;
    const heading = document.createElement('h3'); heading.textContent = group.address || 'Адрес не указан'; details.append(heading);
    const routes=createMapRoutes(group.location);if(routes)details.append(routes);
    const visibleGroup = visibleGroups([group])[0];
    for (const note of visibleGroup?.notes || []) details.append(recordButton(note));
    if (group.candidates.length && !group.location) {
      const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Проверьте найденные места и выберите нужное:'; details.append(hint);
      group.candidates.forEach(candidate => {
        const button = document.createElement('button'); button.className = 'map-candidate'; button.type = 'button';
        button.textContent = candidate.label || `${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)}`;
        button.addEventListener('click', () => { storeLocation(group,{ ...candidate,precision:'manual' }); selectGroup(key); fit(); }); details.append(button);
      });
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary map-place';
    button.textContent = group.location ? 'Исправить место на карте' : 'Указать место на карте';
    button.addEventListener('click', () => {
      stop(); placing = key; canvas.classList.add('placing');
      $('#notes-map-cancel').hidden = false; showStatus('Нажмите на нужный дом на карте, затем «Сохранить место».');
      canvas.scrollIntoView({ block:'center',behavior:'smooth' });
    }); if (!group.notes.some(note=>note.type==='user')) details.append(button);
    if (validLocation(group.location)) {
      const label = document.createElement('p'); label.className = 'hint';
      label.textContent = group.location.precision === 'registry' ? 'Координаты из реестра.' : group.location.precision === 'manual' ? 'Место указано вручную.' : 'Дом найден по адресу. При необходимости исправьте место.';
      details.append(label); map.panTo([group.location.lat,group.location.lon]);
    }
  }
  function storeLocation(group,location) {
    group.location = { lat:location.lat,lon:location.lon,precision:location.precision || 'manual' }; group.state = 'ready'; group.candidates = [];
    const saved = saveMapLocation(scope,group.key,group.location);
    if (!saved) showStatus('Место отмечено. Телефон не разрешил сохранить координаты после закрытия сайта.');
    render(); return saved;
  }
  function render() {
    if (!map || !visible) return;
    layer.clearLayers(); const filtered = visibleGroups(groups), placed = filtered.filter(group => validLocation(group.location));
    const total = filtered.reduce((sum,group) => sum + group.notes.length,0), located = placed.reduce((sum,group) => sum + group.notes.length,0);
    onMeta(`На карте: ${number(located)} из ${number(total)} уведомлений`);
    const positions = new Map();
    for (const group of placed) {
      const p = group.location, key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
      if (!positions.has(key)) positions.set(key,[]); positions.get(key).push(group);
    }
    for (const atPoint of positions.values()) {
      const count = atPoint.reduce((sum,group) => sum + group.notes.length,0), p = atPoint[0].location;
      const types=new Set(atPoint.flatMap(group=>group.notes.map(note=>note.type==='user'?'user':'registry')));
      const kind=types.size>1?'mixed':[...types][0];
      const marker = L.marker([p.lat,p.lon],{ title:atPoint.map(group => group.address).join(' · '),icon:L.divIcon({ className:`notification-map-marker ${kind}-marker`,html:`<span>${number(count)}</span>`,iconSize:[34,34],iconAnchor:[17,34] }) });
      const popup = document.createElement('div'); popup.className = 'map-popup';
      popup.append(createMapRoutes(p));
      atPoint.forEach(group => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'map-popup-address'; button.textContent = group.address || 'Адрес не указан';
        button.addEventListener('click', () => { selectGroup(group.key); details.scrollIntoView({ block:'nearest',behavior:'smooth' }); }); popup.append(button);
        group.notes.forEach(note => popup.append(recordButton(note)));
      });
      marker.bindPopup(popup,{ maxWidth:300,maxHeight:300 }).on('click',() => { if (atPoint.length === 1) selectGroup(atPoint[0].key); }).addTo(layer);
    }
    $('#notes-map-empty').hidden = total > 0;
    const unresolved = filtered.filter(group => !validLocation(group.location));
    $('#notes-map-unplaced').hidden = !unresolved.length;
    $('#notes-map-unplaced-title').textContent = `Нужно уточнить: ${number(unresolved.length)} адресов`;
    const list = $('#notes-map-unplaced-list'); list.replaceChildren();
    unresolved.forEach(group => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'map-unplaced-address';
      button.innerHTML = `<strong>${esc(group.address || 'Адрес не указан')}</strong><span>${number(group.notes.length)} уведомлений · ${group.state === 'not_found' ? 'место не найдено' : group.candidates.length ? 'выберите место' : 'указать место'}</span>`;
      button.addEventListener('click', () => selectGroup(group.key)); list.append(button);
    });
    find.disabled = loading || !loaded || !navigator.onLine || !unresolved.some(group => group.address && group.state === 'pending');
    if (!selected || !filtered.some(group => group.key === selected)) { selected = ''; details.hidden = true; }
  }
  async function show(value = '') {
    visible = true; query = value; panel.hidden = false; const version = ++generation;
    showStatus(loaded ? '' : 'Читаем адреса уведомлений…');
    try {
      L = await loadLeaflet(); if (version !== generation || !visible) return;
      if (!map) {
        map = L.map(canvas,{ center:[44.8,39.1],zoom:8,scrollWheelZoom:true }); layer = L.layerGroup().addTo(map);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{ maxZoom:19,referrerPolicy:'strict-origin-when-cross-origin',attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map)
          .on('tileerror', () => { if (visible) showStatus(navigator.onLine ? 'Подложка карты не загрузилась. Попробуйте позже; уведомления доступны ниже.' : 'Без интернета подложка карты может быть недоступна. Сохранённые отметки и уведомления доступны.'); });
        map.on('click',event => {
          if (!placing) return;
          preview = { lat:event.latlng.lat,lon:event.latlng.lng,precision:'manual' };
          previewMarker?.remove(); previewMarker = L.circleMarker([preview.lat,preview.lon],{ radius:10,color:'#ee861c',weight:3 }).addTo(map);
          $('#notes-map-save').hidden = false;
        });
      }
      map.invalidateSize();
      if (!loaded) {
        const info = context(), data = await request('mapNotes');
        if (version !== generation || !visible) return;
        scope = info.scope; groups = groupMapNotes([...data,...userNotes]); const saved = readMapLocations(scope);
        groups.forEach(group => { if (!group.location && saved.has(group.key)) { group.location = saved.get(group.key); group.state = 'ready'; } });
        loaded = true;
      }
      const info = context(); $('#notes-map-provider').textContent = info.provider || 'photon.komoot.io';
      $('#notes-map-disclosure').hidden = !groups.some(group => group.address && !group.location);
      render(); fit(); showStatus(navigator.onLine ? '' : 'Без интернета доступны сохранённые отметки. Для поиска новых адресов и загрузки карты нужна связь.');
    } catch (error) { if (version === generation) showStatus(error.message || 'Не удалось открыть карту.'); }
  }
  async function geocode() {
    if (loading || !navigator.onLine) return;
    const info = context(); if (!info.endpoint) { showStatus('Для поиска адресов откройте сайт на Амвере. Место можно указать вручную.'); return; }
    const pending = visibleGroups(groups).filter(group => group.address && !group.location && group.state === 'pending').slice(0,50).map(group => currentGroup(group.key));
    if (!pending.length) return;
    const run = new AbortController(), version = generation; controller = run; loading = true;
    find.hidden = true; stopButton.hidden = false;
    let done = 0;
    try {
      for (const group of pending) {
        if (run.signal.aborted || version !== generation) return;
        showStatus(`Ищем адреса: ${number(done + 1)} из ${number(pending.length)}…`);
        const response = await fetcher(info.endpoint,{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ address:group.address }),signal:run.signal,cache:'no-store' });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось определить адрес.');
        if (run.signal.aborted || version !== generation) return;
        group.candidates = (data.candidates || []).filter(validLocation).slice(0,5);
        const exact = exactCandidate(group,group.candidates);
        if (exact) storeLocation(group,exact); else { group.state = group.candidates.length ? 'choose' : 'not_found'; render(); }
        done++;
      }
      fit(); showStatus('Поиск завершён. Адреса без точного совпадения можно выбрать из найденных мест или указать на карте.' + (pending.length === 50 ? ' Нажмите «Найти адреса» для следующей части.' : ''));
    } catch (error) { if (!run.signal.aborted && version === generation) showStatus(error.message); }
    finally { if (controller === run) { stop(); render(); } }
  }
  function hide() { visible = false; generation++; stop(); cancelPlacement(); panel.hidden = true; }
  function reset() { hide(); groups = []; scope = ''; loaded = false; selected = ''; details.replaceChildren(); details.hidden = true; layer?.clearLayers(); showStatus(''); }
  find.addEventListener('click',geocode);
  stopButton.addEventListener('click',() => stop('Поиск остановлен. Найденные отметки сохранены; можно продолжить позже.'));
  $('#notes-map-fit').addEventListener('click',fit);
  $('#notes-map-save').addEventListener('click',() => {
    const group = currentGroup(placing); if (group && validLocation(preview)) { const saved = storeLocation(group,preview); cancelPlacement(); if (saved) showStatus('Место сохранено на телефоне.'); selectGroup(group.key); }
  });
  $('#notes-map-cancel').addEventListener('click',() => { cancelPlacement(); showStatus(''); });
  window.addEventListener('offline',() => { if (visible) { stop('Связь пропала. Найденные отметки доступны; продолжите поиск со связью.'); render(); } });
  window.addEventListener('online',() => { if (visible) { showStatus('Связь появилась. Можно продолжить поиск адресов.'); render(); } });
  return { show,hide,reset,filter(value,type='all') { query=value;origin=type;if(loaded){render();fit();} },
    setUserNotes(notes) {
      userNotes=notes;if(!loaded)return;
      stop();cancelPlacement();
      groups=[...groups.filter(group=>!group.notes.some(note=>note.type==='user')),...groupMapNotes(notes)];
      if(visible){render();if(selected && currentGroup(selected))selectGroup(selected);}
    },
  };
}
