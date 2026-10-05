import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createNotificationCache,createUserNotifications,notificationFromRecord } from '../public/user-notifications.js';
import { validateNotification,notificationRes } from '../user-notifications.mjs';
import { parseMatrix,buildIndex,notificationRecord } from '../public/core.js';
import { createServer } from '../server.mjs';

const source='https://disk.yandex.ru/d/NotificationTest',resPath='/ЭС А/РЭС 1';
const record={address:'Тестовый, Учебная, 12',fields:{meter:'000123',account:'00001',point:'00002',name:'Тестовый потребитель',locality:'Тестовый',street:'Учебная',house:'12',phone:'never-share'}};
const location={lat:43.6,lon:39.72};
const publicNote=value=>{const {id,fields,address,note,location}=value;return {id,fields,address,note,location};};
function api() {
  const areas=new Map(),calls=[];
  const area=path=>{if(!areas.has(path))areas.set(path,{generation:0,revision:0,notes:new Map(),deleted:new Set()});return areas.get(path);};
  const snapshot=a=>({generation:a.generation,revision:String(a.revision),notifications:[...a.notes.values()]});
  const fetcher=async(url,options={})=>{
    const path=new URL(url).searchParams.get('res'),body=options.body?JSON.parse(options.body):null,method=options.method || 'GET';
    calls.push({path,method,body});const a=area(path);
    if(method==='GET')return Response.json(snapshot(a));
    if(body.generation!==a.generation)return Response.json({code:'notifications_cleared',error:'РЭС очищен'},{status:409});
    if(method==='POST'){
      const note=body.notification;
      if(a.deleted.has(note.id))return Response.json({code:'notification_deleted',error:'Отметка удалена'},{status:410});
      if(!a.notes.has(note.id)){a.notes.set(note.id,{...validateNotification(note),createdAt:new Date().toISOString()});a.revision++;}
    }else if(body.id){a.notes.delete(body.id);a.deleted.add(body.id);a.revision++;}
    else{a.notes.clear();a.deleted.clear();a.generation++;a.revision++;}
    return Response.json(snapshot(a));
  };
  return {fetcher,area,calls,snapshot};
}
function client(t,backend,{path=resPath,idb=new IDBFactory(),online=true}={}) {
  const cache=createNotificationCache(idb),state={path,online,autoSync:true};
  const context=()=>({source,resPath:state.path,shared:true,endpoint:'https://app.test/api/user-notifications',autoSync:state.autoSync});
  const service=createUserNotifications({context,cache,fetcher:backend.fetcher,online:()=>state.online});
  let view;service.subscribe(data=>{view=data;});
  t.after(()=>service.close());
  return {service,state,cache,context,view:()=>view};
}

test('notification payload contains only bounded consumer fields and requires a comment and coordinates',()=>{
  const note=notificationFromRecord(record,' Проверить ТТ ',location);
  assert.equal(note.fields.phone,undefined);assert.equal(note.note,'Проверить ТТ');
  assert.equal(validateNotification(publicNote(note)).type,'user');
  for(const patch of [{note:'   '},{note:'a'.repeat(2001)},{location:{lat:86,lon:39}},{fields:{meter:'123',phone:'private'}},{id:'bad-id'}])assert.throws(()=>validateNotification({...publicNote(note),...patch}));
  for(const path of ['/','/РЭС','/ЭС/../РЭС','/ЭС/РЭС/ещё','/ЭС/\0РЭС'])assert.throws(()=>notificationRes(path));
  assert.equal(notificationRes(resPath),resPath);
});
test('shared notification resolves to the same PU and TU after registry row order changes',()=>{
  const index=buildIndex([parseMatrix([['Номер ПУ','ЛС','Номер ТУСТЕК','Наименование договора'],['555','999','different','Другой'],['000123','00001','00002','Новая подпись']],{sheet:'Новый лист'})]);
  assert.equal(notificationRecord(index,record.fields).id,'Новый лист:3');
  assert.throws(()=>notificationRecord(index,{...record.fields,point:'00003'}),/не найден/);
});
test('two phones share create and delete, while other RES keep independent notifications',async t=>{
  const backend=api(),a=client(t,backend),b=client(t,backend),other=client(t,backend,{path:'/ЭС А/РЭС 2'});
  const saved=await a.service.add(record,'Проверить прибор',location);await a.service.sync();await b.service.sync();await other.service.sync();
  assert.equal(b.view().notifications[0].id,saved.id);assert.equal(b.view().notifications[0].pending,false);assert.equal(other.view().notifications.length,0);
  await b.service.remove(saved.id);await b.service.sync();await a.service.sync();assert.equal(a.view().notifications.length,0);
  assert.ok(backend.calls.filter(call=>call.method==='POST').every(call=>call.body.notification.fields.phone===undefined));
});
test('offline note survives reload, uploads on reconnect and repeated synchronization creates only one item',async t=>{
  const backend=api(),idb=new IDBFactory(),a=client(t,backend,{idb,online:false});
  const saved=await a.service.add(record,'Проверить доступ',location);assert.equal(backend.calls.length,0);assert.equal(a.view().notifications[0].pending,true);
  const reloaded=client(t,backend,{idb});await reloaded.service.sync();await reloaded.service.sync();
  assert.equal(backend.area(resPath).notes.size,1);assert.equal(reloaded.view().notifications[0].id,saved.id);assert.equal(reloaded.view().pendingCount,0);
});
test('explicit offline RES selection reads only local notifications even when the network is on',async t=>{
  const backend=api(),a=client(t,backend);a.state.autoSync=false;
  a.service.changeContext();await a.service.sync();assert.equal(backend.calls.length,0);
  await a.service.add(record,'Осознанное сохранение при связи',location);await a.service.sync({...a.context(),autoSync:true});
  assert.equal(backend.area(resPath).notes.size,1);
});
test('clearing one RES does not touch another or resurrect stale offline creations and deletions',async t=>{
  const backend=api(),a=client(t,backend),offline=client(t,backend),other=client(t,backend,{path:'/ЭС А/РЭС 2'});
  await a.service.add(record,'До очистки',location);await a.service.sync();await offline.service.sync();
  await other.service.add(record,'Другой РЭС',location);await other.service.sync();
  offline.state.online=false;await offline.service.add(record,'Старая офлайн-отметка',location);
  await a.service.clear(resPath);assert.equal(backend.area(resPath).generation,1);
  offline.state.online=true;await offline.service.sync();assert.equal(offline.view().notifications.length,0);assert.match(offline.view().message,/очищены/);
  assert.equal(backend.area('/ЭС А/РЭС 2').notes.size,1);
  await a.service.add(record,'После очистки',location);await a.service.sync();assert.equal(backend.area(resPath).notes.size,1);
});
test('a deleted note with a lost POST response cannot be recreated by a retry',async t=>{
  const backend=api(),a=client(t,backend,{online:false});const note=await a.service.add(record,'Поздняя отправка',location);
  backend.area(resPath).deleted.add(note.id);a.state.online=true;await a.service.sync();
  assert.equal(a.view().notifications.length,0);assert.equal(a.view().pendingCount,0);assert.match(a.view().message,/удалена/);
});
test('connection errors retain queued comments, and a quota error never reports a successful save',async t=>{
  const backend=api(),a=client(t,backend,{online:false});await a.service.add(record,'Не терять',location);a.state.online=true;
  backend.fetcher=async()=>{throw new Error('offline');};
  const broken=createUserNotifications({context:a.context,cache:a.cache,fetcher:backend.fetcher,online:()=>true});
  await broken.sync();assert.equal((await a.cache.read(a.context())).pending.length,1);
  const full=createUserNotifications({context:a.context,cache:{read:async()=>({notifications:[],pending:[]}),change:async()=>{throw new Error('QuotaExceededError');}},online:()=>false});
  await assert.rejects(full.add(record,'Нет места',location),/QuotaExceeded/);
});
test('concurrent writes to one phone cache retain both pending notes',async t=>{
  const backend=api(),a=client(t,backend,{online:false});
  await Promise.all([a.service.add(record,'Первая',location),a.service.add(record,'Вторая',location)]);
  assert.equal((await a.cache.read(a.context())).pending.length,2);
});
test('late snapshots cannot overwrite a newer revision or restore a cleared generation across tabs',async t=>{
  const backend=api(),a=client(t,backend);
  async function holdSnapshot(work) {
    let release,received;
    const gate=new Promise(resolve=>{release=resolve;}),captured=new Promise(resolve=>{received=resolve;});
    const slow=createUserNotifications({context:a.context,cache:a.cache,online:()=>true,fetcher:async(...args)=>{
      const response=await backend.fetcher(...args);received();await gate;return response;
    }});
    const sync=slow.sync();await captured;await work();release();await sync;
  }
  let note;
  await holdSnapshot(async()=>{note=await a.service.add(record,'Свежая отметка',location);await a.service.sync();});
  assert.equal((await a.cache.read(a.context())).notifications[0].id,note.id);
  await holdSnapshot(()=>a.service.clear(resPath));
  const state=await a.cache.read(a.context());assert.equal(state.generation,1);assert.equal(state.notifications.length,0);
});
test('notification API uses configured source and known RES, rejects unsafe writes and leaves registry files alone',async t=>{
  const prior=process.env.YANDEX_PUBLIC_URL;process.env.YANDEX_PUBLIC_URL=source;
  const calls=[],snapshot={generation:0,revision:'0',notifications:[]};
  const store={listFolders:async()=>[{res_path:resPath}],listUserNotifications:async(...args)=>{calls.push(args);return snapshot;},
    addUserNotification:async(...args)=>{calls.push(args);return snapshot;},deleteUserNotification:async(...args)=>{calls.push(args);return snapshot;},
    clearUserNotifications:async(...args)=>{calls.push(args);return snapshot;},close:async()=>{}};
  const server=createServer({preparedStore:store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));if(prior===undefined)delete process.env.YANDEX_PUBLIC_URL;else process.env.YANDEX_PUBLIC_URL=prior;});
  const endpoint=`http://127.0.0.1:${server.address().port}/api/user-notifications`,note=publicNote(notificationFromRecord(record,'Общее',location));
  assert.equal((await fetch(endpoint+'?res='+encodeURIComponent(resPath))).status,200);assert.equal(calls[0][0],source);
  assert.equal((await fetch(endpoint+'?res='+encodeURIComponent('/ЭС Б/Нет РЭС'))).status,404);
  const send=(body,headers={'Content-Type':'application/json'},method='POST')=>fetch(endpoint,{method,headers,body:JSON.stringify(body)});
  assert.equal((await send({resPath,generation:0,notification:note})).status,200);assert.equal(calls.at(-1)[3].type,'user');
  assert.equal((await send({resPath,generation:0,notification:note,source:'evil'})).status,400);
  assert.equal((await send({resPath,generation:0,notification:note},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await send({resPath,generation:0,notification:note},{'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'})).status,415);
  assert.equal((await send({resPath,generation:0},undefined,'DELETE')).status,200);
  assert.deepEqual(calls.at(-1),[source,resPath,0]);
});
