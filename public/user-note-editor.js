import { loadMapLibrary } from './map-library.js';
import { mapAddress,registryLocation,exactCandidate,validLocation,groupMapNotes } from './notes-map-data.js';

export function initUserNoteEditor({ save,context,onSaved=()=>{},loadLeaflet=loadMapLibrary,fetcher=(...args)=>fetch(...args) }) {
  const $=selector=>document.querySelector(selector),dialog=$('#user-note-dialog');
  const status=$('#user-note-status'),canvas=$('#user-note-map'),submit=$('#user-note-save'),find=$('#user-note-find');
  let record=null,location=null,map,L,marker,version=0,controller=null,saving=false;
  const message=value=>{status.textContent=value;status.hidden=!value;};
  function select(value) {
    if (!validLocation(value)) throw new Error('Проверьте широту и долготу.');
    location={lat:value.lat,lon:value.lon,precision:'manual'};
    $('#user-note-lat').value=String(value.lat); $('#user-note-lon').value=String(value.lon);
    $('#user-note-location').textContent=`Место выбрано: ${value.lat.toFixed(5)}, ${value.lon.toFixed(5)}`;
    marker?.remove();
    if (map) marker=L.marker([value.lat,value.lon],{icon:L.divIcon({className:'notification-map-marker user-marker',html:'<span>+</span>',iconSize:[34,34],iconAnchor:[17,34]})}).addTo(map);
  }
  async function open(value) {
    const run=++version; controller?.abort(); record=value;location=null;saving=false;
    submit.disabled=false;find.disabled=!navigator.onLine || !context().endpoint || !mapAddress(value);
    $('#user-note-address').textContent=value.address || 'Адрес не указан в реестре';
    $('#user-note-consumer').textContent=[value.fields.name,'ПУ '+(value.fields.meter || '—'),'ЛС '+(value.fields.account || '—')].filter(Boolean).join(' · ');
    $('#user-note-comment').value='';$('#user-note-candidates').replaceChildren();
    $('#user-note-location').textContent='Нажмите на нужный дом на карте.';
    $('#user-note-lat').value='';$('#user-note-lon').value='';
    $('#user-note-sharing').textContent=context().shared ? 'Отметку и комментарий увидят сотрудники, открывшие этот РЭС. Без связи сохраним на телефоне и отправим позже.' : 'Эта отметка сохранится на этом устройстве.';
    $('#user-note-provider').textContent=context().provider || 'photon.komoot.io';
    if (!dialog.open) dialog.showModal();
    message(navigator.onLine ? '' : 'Без связи подложка карты может быть недоступна. Можно указать координаты или использовать своё местоположение.');
    try {
      L=await loadLeaflet();if(run!==version || !dialog.open)return;
      if (!map) {
        map=L.map(canvas,{center:[44.8,39.1],zoom:8});
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}).addTo(map)
          .on('tileerror',()=>{if(dialog.open)message('Подложка карты не загрузилась. Выбранное место и координаты можно сохранить.');});
        map.on('click',event=>{select({lat:event.latlng.lat,lon:event.latlng.lng});message('Место выбрано. Добавьте комментарий и сохраните отметку.');});
      }
      map.invalidateSize(); marker?.remove();marker=null;
      const initial=location || registryLocation(record.fields);
      if(initial){select(initial);map.setView?.([initial.lat,initial.lon],17);}
      else map.setView?.([44.8,39.1],8);
    }catch(error){if(run===version)message('Карта не открылась. Можно ввести координаты вручную. '+error.message);}
  }
  find.addEventListener('click',async()=>{
    if (!record || !context().endpoint || !navigator.onLine) return;
    const run=version;controller?.abort();const request=new AbortController();controller=request;find.disabled=true;
    message('Ищем адрес дома…');
    try {
      const response=await fetcher(context().endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:mapAddress(record)}),signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])});
      const data=await response.json();if(!response.ok)throw new Error(data.error || 'Адрес не найден.');
      if(run!==version || request.signal.aborted)return;
      const candidates=(data.candidates || []).filter(validLocation).slice(0,5);
      const exact=exactCandidate(groupMapNotes([record])[0],candidates);
      $('#user-note-candidates').replaceChildren();
      if(exact){select(exact);map?.setView?.([exact.lat,exact.lon],17);message('Дом найден. Проверьте место, добавьте комментарий и сохраните.');}
      else {
        message(candidates.length ? 'Выберите найденное место или нажмите на нужный дом на карте.' : 'Дом не найден. Укажите место на карте или введите координаты.');
        for(const value of candidates){
          const button=document.createElement('button');button.type='button';button.className='map-candidate';button.textContent=value.label || `${value.lat}, ${value.lon}`;
          button.addEventListener('click',()=>{select(value);map?.setView?.([value.lat,value.lon],17);message('Проверьте место и сохраните отметку с комментарием.');});$('#user-note-candidates').append(button);
        }
      }
    }catch(error){if(run===version && !request.signal.aborted)message(error.message);}
    finally{if(run===version)find.disabled=!navigator.onLine;}
  });
  $('#user-note-coordinates').addEventListener('click',()=>{
    try{const lat=Number($('#user-note-lat').value.trim().replace(',','.')),lon=Number($('#user-note-lon').value.trim().replace(',','.'));
      if(!$('#user-note-lat').value.trim() || !$('#user-note-lon').value.trim())throw new Error('Введите широту и долготу.');
      select({lat,lon});map?.setView?.([lat,lon],17);message('Место выбрано. Добавьте комментарий.');
    }catch(error){message(error.message);}
  });
  $('#user-note-my-location').addEventListener('click',()=>{
    if(!navigator.geolocation){message('Браузер не поддерживает определение местоположения.');return;}
    const run=version;message('Определяем ваше местоположение…');
    navigator.geolocation.getCurrentPosition(position=>{
      if(run!==version || !dialog.open)return;
      select({lat:position.coords.latitude,lon:position.coords.longitude});map?.setView?.([location.lat,location.lon],17);
      message('Показано ваше место. При необходимости передвиньте отметку на дом потребителя.');
    },()=>{if(run===version)message('Не удалось получить местоположение. Выберите дом на карте или укажите координаты.');},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
  });
  $('#user-note-form').addEventListener('submit',async event=>{
    event.preventDefault();if(saving || !record)return;
    const run=version;
    try {
      if(!validLocation(location))throw new Error('Сначала укажите место потребителя на карте.');
      if(!$('#user-note-comment').value.trim())throw new Error('Напишите комментарий к отметке.');
      saving=true;submit.disabled=true;message('Сохраняем отметку…');
      await save(record,$('#user-note-comment').value,location);
      if(run!==version)return;
      dialog.close();onSaved();
    }catch(error){if(run===version)message(error.message);}
    finally{if(run===version){saving=false;submit.disabled=false;}}
  });
  dialog.addEventListener('close',()=>{version++;controller?.abort();record=null;location=null;});
  return {open,reset(){dialog.close();version++;controller?.abort();record=null;}};
}
