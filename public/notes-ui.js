import { initNotesMapUI } from './notes-map-ui.js';
import { mapNoteMatches } from './notes-map-data.js';

const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=n=>new Intl.NumberFormat('ru-RU').format(n);

export function initNotesUI({request,openDialog,openRecord,openUserNote=()=>{},deleteUserNote=()=>{},refreshUserNotes=()=>{},mapContext}) {
  const $=selector=>document.querySelector(selector);
  const dialog=$('#notes-dialog'),list=$('#notes-list'),filter=$('#notes-filter'),more=$('#notes-more');
  let summary=null,rows=[],version=0,timer,loading=false,mode='list',userNotes=[],userFingerprint='',busy=false,shared=false;
  const origin=()=>$('#notes-origin').value;
  const mapUI=initNotesMapUI({request,openRecord,openUserNote,deleteUserNote,context:mapContext,onMeta:text=>{$('#notes-meta').textContent=text;}});
  function switchMode(next) {
    if(!summary)return;
    version++;clearTimeout(timer);loading=false;mode=next;
    $('#notes-list-mode').setAttribute('aria-pressed',String(mode==='list'));
    $('#notes-map-mode').setAttribute('aria-pressed',String(mode==='map'));
    list.hidden=mode!=='list';more.hidden=true;$('#notes-message').hidden=true;
    mapUI.filter(filter.value.trim(),origin());
    if(mode==='map'){$('#notes-body').scrollTop=0;void mapUI.show(filter.value.trim());}
    else{mapUI.hide();void load();}
  }
  function update(data,working=false) {
    const changed=data!==summary;summary=data;busy=working;
    const count=(data?.notesCount || 0)+userNotes.length,button=$('#notes-open'),badge=$('#notes-badge');
    button.disabled=!data || busy;
    button.setAttribute('aria-label',data?`Уведомления: ${number(count)}, из реестра ${number(data.notesCount || 0)}, пользовательских ${number(userNotes.length)}`:'Уведомления: сначала загрузите реестр');
    button.title=button.getAttribute('aria-label');badge.textContent=number(count);badge.hidden=!count;
    if(changed && data)void refreshUserNotes();
  }
  function reset() {
    version++;clearTimeout(timer);loading=false;rows=[];summary=null;userNotes=[];userFingerprint='';
    mapUI.reset();mapUI.setUserNotes([]);mode='list';dialog.close();list.replaceChildren();filter.value='';$('#notes-origin').value='all';update(null);
  }
  function render() {
    list.innerHTML=rows.map((r,i)=>{
      const user=r.type==='user';
      const button=`<button type="button" class="meter-item note-item" data-note="${i}" data-origin="${user?'user':'registry'}"><span class="note-origin" data-origin="${user?'user':'registry'}">${user?'Пользовательское':'Из реестра'}${user?' · '+(shared?(r.pending?'Ожидает отправки':'Общее'):'На телефоне'):''}</span><span class="meter-item-head"><span class="meter-number"><span class="number-label">Номер ПУ</span><strong>${esc(r.fields.meter || '—')}</strong></span><span class="meter-open-label">Открыть</span></span><span class="meter-details"><span><span class="number-label">Лицевой счёт</span><strong>${esc(r.fields.account || '—')}</strong></span><span><span class="number-label">Точка учёта</span><strong>${esc([r.fields.point || r.fields.pointNumber,r.fields.pointName].filter(Boolean).join(' · ') || '—')}</strong></span></span><span class="meter-subscriber">${esc(r.fields.name || 'Абонент')}</span><span class="note-location">${esc([r.fields.tp,r.address].filter(Boolean).join(' · '))}</span><span class="note-text"><span class="number-label">${user?'Комментарий':'Примечание'}</span><span>${esc(r.note)}</span></span><span class="note-source">${user?esc(new Date(r.createdAt).toLocaleString('ru-RU')):esc(r.sheet)+' · строка '+r.row}</span></button>`;
      return user?`<article class="user-note-item">${button}<button type="button" class="user-note-delete" data-delete-user="${i}"><svg aria-hidden="true"><use href="#i-trash"/></svg>Удалить отметку</button></article>`:button;
    }).join('');
  }
  async function load(append=false,preserveScroll=false) {
    if(!summary || mode!=='list' || append && loading)return;
    clearTimeout(timer);const current=++version,scroll=$('#notes-body').scrollTop;loading=true;more.disabled=true;$('#notes-message').hidden=true;
    if(!append){rows=[];list.innerHTML='<p class="loading-row">Читаем уведомления…</p>';more.hidden=true;if(!preserveScroll)$('#notes-body').scrollTop=0;}
    try {
      const users=origin()==='registry'?[]:userNotes.filter(note=>mapNoteMatches(note,filter.value.trim()));
      const offset=rows.length,take=users.slice(offset,offset+100);
      const data=origin()==='user'?{notes:[],total:0,totalInRegistry:summary.notesCount || 0}:await request('notes',{query:filter.value.trim(),offset:Math.max(0,offset-users.length),limit:100-take.length});
      if(current!==version || !dialog.open)return;
      rows=[...rows,...take,...data.notes];render();
      const total=data.total+users.length;
      $('#notes-meta').textContent=`Найдено: ${number(total)} · Из реестра: ${number(summary.notesCount || 0)} · Пользовательских: ${number(userNotes.length)}`;
      more.hidden=rows.length>=total;
      if(!rows.length)list.innerHTML=`<p class="hint">${filter.value.trim()?'Совпадений нет. Измените запрос.':'Уведомлений нет. Пользовательскую отметку можно добавить рядом с адресом в карточке ПУ.'}</p>`;
      if(preserveScroll)$('#notes-body').scrollTop=scroll;
    }catch(error){if(current!==version)return;if(!append)list.replaceChildren();$('#notes-message').textContent=error.message;$('#notes-message').hidden=false;}
    finally{if(current===version){loading=false;more.disabled=false;}}
  }
  $('#notes-open').addEventListener('click',()=>{
    if(!summary)return;filter.value='';openDialog('notes-dialog');switchMode(mode);void refreshUserNotes(true);
  });
  const filterChanged=()=>{
    version++;clearTimeout(timer);
    if(mode==='map'){mapUI.filter(filter.value.trim(),origin());return;}
    more.disabled=true;timer=setTimeout(()=>load(),160);
  };
  filter.addEventListener('input',filterChanged);$('#notes-origin').addEventListener('change',filterChanged);
  $('#notes-list-mode').addEventListener('click',()=>switchMode('list'));
  $('#notes-map-mode').addEventListener('click',()=>switchMode('map'));
  more.addEventListener('click',()=>load(true));
  list.addEventListener('click',event=>{
    const remove=event.target.closest('[data-delete-user]');if(remove){void deleteUserNote(rows[Number(remove.dataset.deleteUser)]);return;}
    const button=event.target.closest('[data-note]');if(!button)return;
    const note=rows[Number(button.dataset.note)];
    if(note.type==='user')void openUserNote(note);else void openRecord(note.id,{parent:'notes-dialog',variants:[]});
  });
  dialog.addEventListener('close',()=>{version++;clearTimeout(timer);loading=false;mapUI.hide();});
  return {update,reset,setUserNotes(data){
    shared=Boolean(data.shared);const fingerprint=JSON.stringify(data.notifications);
    $('#user-notes-sync').textContent=data.message || '';$('#user-notes-sync').hidden=!data.message;
    if(fingerprint===userFingerprint)return;
    userFingerprint=fingerprint;userNotes=data.notifications;mapUI.setUserNotes(userNotes);update(summary,busy);
    if(dialog.open && mode==='list')void load(false,true);
  }};
}
