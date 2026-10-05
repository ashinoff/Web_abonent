import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { initUserNoteEditor } from '../public/user-note-editor.js';
import { initNotesUI } from '../public/notes-ui.js';
import { mapRouteLinks } from '../public/map-routes.js';

const record={id:'Лист:2',fields:{meter:'0001',account:'001',locality:'Тестовый',street:'Учебная',house:'12',name:'Тестовый потребитель'},address:'Тестовый, Учебная, 12'};
async function page(t) {
  const window=new Window({url:'https://app.test/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  window.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  const handlers=new Map(),markers=[],restores=[];
  const map={invalidateSize(){},setView(){},fitBounds(){},panTo(){},on(event,handler){handlers.set(event,handler);return this;}};
  const L={map:()=>map,divIcon:value=>value,layerGroup:()=>({addTo(){return this;},clearLayers(){markers.splice(0);}}),
    tileLayer:()=>({addTo(){return this;},on(){return this;}}),marker:(position,options)=>({position,options,remove(){},bindPopup(value){this.popup=value;return this;},on(){return this;},addTo(){markers.push(this);return this;}})};
  for(const [key,value]of Object.entries({window,document:window.document,localStorage:window.localStorage,navigator:{onLine:true},L})){
    const prior=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});restores.push(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key];});
  }
  window.HTMLElement.prototype.scrollIntoView=()=>{};
  t.after(async()=>{await window.happyDOM.close();restores.forEach(restore=>restore());});
  return {window,$:selector=>window.document.querySelector(selector),L,handlers,markers};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await delay(5);}assert.fail('UI did not settle');}

test('PU map editor preserves the parent card and saves only after a place and comment are chosen',async t=>{
  const p=await page(t),saved=[];p.$('#record-dialog').showModal();
  const editor=initUserNoteEditor({context:()=>({shared:true}),save:async(...args)=>saved.push(args),loadLeaflet:async()=>p.L});
  await editor.open(record);assert.equal(p.$('#record-dialog').open,true);assert.equal(p.$('#user-note-dialog').open,true);
  p.$('#user-note-comment').value='Проверить';p.$('#user-note-form').dispatchEvent(new p.window.Event('submit',{cancelable:true}));
  assert.equal(saved.length,0);assert.match(p.$('#user-note-status').textContent,/укажите место/);
  p.handlers.get('click')({latlng:{lat:43.6,lng:39.72}});
  p.$('#user-note-comment').value='Проверить <script>не HTML</script>';p.$('#user-note-form').dispatchEvent(new p.window.Event('submit',{cancelable:true}));
  await until(()=>saved.length===1 && !p.$('#user-note-dialog').open);
  assert.equal(saved[0][0].fields.meter,'0001');assert.equal(saved[0][1],'Проверить <script>не HTML</script>');assert.equal(saved[0][2].lat,43.6);
  assert.equal(p.$('#record-dialog').open,true);
});
test('a late map load cannot overwrite manually entered coordinates, and closing cancels late address lookup',async t=>{
  const p=await page(t);let finishMap,finishLookup,signal;
  const editor=initUserNoteEditor({context:()=>({endpoint:'https://app.test/api/map-geocode'}),save:async()=>{},
    loadLeaflet:()=>new Promise(resolve=>{finishMap=resolve;}),fetcher:(_url,options)=>{signal=options.signal;return new Promise(resolve=>{finishLookup=resolve;});}});
  const opening=editor.open(record);p.$('#user-note-lat').value='43,6';p.$('#user-note-lon').value='39,72';p.$('#user-note-coordinates').click();
  finishMap(p.L);await opening;assert.equal(p.$('#user-note-lat').value,'43.6');
  p.$('#user-note-find').click();p.$('#user-note-dialog').close();assert.equal(signal.aborted,true);
  finishLookup(Response.json({candidates:[{lat:44,lon:40}]}));await delay(10);assert.equal(p.$('#user-note-dialog').open,false);
});
test('combined notifications paginate both sources, escape comments, filter users and expose deletion only for user items',async t=>{
  const p=await page(t),opened=[],deleted=[];
  const registry=[{...record,note:'Из Excel',sheet:'Лист',row:2}];
  const users=Array.from({length:105},(_,i)=>({...record,id:'user-'+i,type:'user',note:i===0?'<img src=x onerror=alert(1)>':'Комментарий '+i,location:{lat:43.6,lon:39.72},createdAt:new Date().toISOString()}));
  const ui=initNotesUI({request:async(_action,payload)=>({notes:registry.slice(payload.offset,payload.offset+payload.limit),total:1,totalInRegistry:1}),
    openDialog:()=>p.$('#notes-dialog').showModal(),openRecord:id=>opened.push(id),openUserNote:note=>opened.push(note.id),deleteUserNote:note=>deleted.push(note.id),mapContext:()=>({scope:'ui-test'})});
  ui.update({notesCount:1,hasNotesColumn:true});ui.setUserNotes({notifications:users,shared:true});p.$('#notes-open').click();
  await until(()=>p.$('#notes-list').querySelectorAll('[data-note]').length===100);
  assert.equal(p.$('#notes-badge').textContent,'106');assert.equal(p.$('#notes-list').querySelector('img'),null);
  p.$('#notes-more').click();await until(()=>p.$('#notes-list').querySelectorAll('[data-note]').length===106);
  assert.equal(p.$('#notes-list').querySelectorAll('[data-delete-user]').length,105);
  p.$('[data-delete-user="0"]').click();assert.deepEqual(deleted,['user-0']);
  p.$('[data-note="0"]').click();assert.deepEqual(opened,['user-0']);
  p.$('#notes-origin').value='registry';p.$('#notes-origin').dispatchEvent(new p.window.Event('change'));
  await until(()=>p.$('#notes-list').querySelectorAll('[data-note]').length===1);assert.equal(p.$('#notes-list').querySelector('[data-delete-user]'),null);
  ui.reset();
});
test('map uses distinct user and registry markers and a mixed marker when both share the same location',async t=>{
  const p=await page(t);
  const {initNotesMapUI}=await import('../public/notes-map-ui.js');
  const registry={...record,note:'Excel',fields:{...record.fields,latitude:'43.6',longitude:'39.72'}};
  const user={...record,id:'user',note:'Комментарий',type:'user',location:{lat:43.61,lon:39.73}};
  const ui=initNotesMapUI({request:async()=>[registry],context:()=>({scope:'types'}),openRecord:()=>{},onMeta:()=>{},loadLeaflet:async()=>p.L});
  ui.setUserNotes([user]);await ui.show();assert.equal(p.markers.length,2);
  assert.ok(p.markers.some(marker=>marker.options.icon.className.includes('registry-marker')));assert.ok(p.markers.some(marker=>marker.options.icon.className.includes('user-marker')));
  for(const marker of p.markers){
    const [lat,lon]=marker.position,google=new URL(marker.popup.querySelector('[data-route-provider="google"]').href),yandex=new URL(marker.popup.querySelector('[data-route-provider="yandex"]').href);
    assert.equal(google.searchParams.get('destination'),`${lat},${lon}`);assert.equal(google.searchParams.has('origin'),false);
    assert.equal(yandex.searchParams.get('rtext'),`~${lat},${lon}`);assert.equal(yandex.searchParams.get('rtt'),'auto');
    assert.equal(google.searchParams.has('query'),false);assert.equal(marker.popup.querySelector('.map-route-link').rel,'noopener noreferrer');
    marker.popup.querySelector('.map-popup-address').click();
    assert.equal(new URL(p.$('#notes-map-detail [data-route-provider="google"]').href).searchParams.get('destination'),`${lat},${lon}`);
  }
  ui.setUserNotes([{...user,location:{lat:43.6,lon:39.72}}]);assert.equal(p.markers.length,1);assert.match(p.markers[0].options.icon.className,/mixed-marker/);
  assert.equal(p.markers[0].popup.querySelectorAll('.map-route-link').length,2);
  assert.equal(new URL(p.markers[0].popup.querySelector('[data-route-provider="google"]').href).searchParams.get('destination'),'43.6,39.72');
  assert.equal(new URL(mapRouteLinks({lat:0,lon:-73.987654321})[0].href).searchParams.get('rtext'),'~0,-73.987654321');
  assert.deepEqual(mapRouteLinks(null),[]);assert.deepEqual(mapRouteLinks({lat:NaN,lon:39}),[]);
  ui.filter('','user');assert.match(p.markers[0].options.icon.className,/user-marker/);ui.reset();
});
