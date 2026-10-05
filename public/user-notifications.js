import { validLocation } from './notes-map-data.js';

const keyOf = ({ source,resPath }) => JSON.stringify([source,resPath]);
const empty = ctx => ({ key:keyOf(ctx),source:ctx.source,resPath:ctx.resPath,shared:ctx.shared,
  generation:null,revision:'0',notifications:[],pending:[] });

export function createNotificationCache(indexedDB = globalThis.indexedDB) {
  let opening;
  function database() {
    opening ||= new Promise((resolve,reject)=>{
      if (!indexedDB) { reject(new Error('Телефон не разрешил сохранить уведомление.')); return; }
      const request=indexedDB.open('abonent-notifications-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('areas',{keyPath:'key'});
      request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
    }).catch(error=>{ opening=null; throw error; });
    return opening;
  }
  return {
    async read(ctx) {
      const db=await database();
      return new Promise((resolve,reject)=>{
        const request=db.transaction('areas').objectStore('areas').get(keyOf(ctx));
        request.onsuccess=()=>resolve(request.result || empty(ctx)); request.onerror=()=>reject(request.error);
      });
    },
    async change(ctx,work) {
      const db=await database();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('areas','readwrite'),store=tx.objectStore('areas'); let value,problem;
        const request=store.get(keyOf(ctx));
        request.onsuccess=()=>{
          try { value=request.result || empty(ctx); work(value); store.put(value); }
          catch(error) { problem=error; tx.abort(); }
        };
        tx.oncomplete=()=>resolve(value); tx.onabort=tx.onerror=()=>reject(problem || tx.error || new Error('Не удалось сохранить уведомления на телефоне.'));
      });
    },
    async all() {
      const db=await database();
      return new Promise((resolve,reject)=>{
        const request=db.transaction('areas').objectStore('areas').getAll();
        request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
      });
    },
    async close() { (await opening)?.close(); opening=null; },
  };
}

export function visibleUserNotifications(state) {
  const records=new Map(state.notifications.map(note=>[note.id,{...note,pending:false}]));
  for (const operation of state.pending) {
    if (operation.kind==='delete') records.delete(operation.id);
    else records.set(operation.id,{...operation.notification,pending:true});
  }
  return [...records.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}

const recordFields=['meter','account','point','pointNumber','pointName','name','tp','locality','street','house','building'];
export function notificationFromRecord(record,note,location,id=globalThis.crypto.randomUUID()) {
  if (!validLocation(location)) throw new Error('Укажите место потребителя на карте.');
  if (!note.trim() || note.length>2000) throw new Error('Напишите комментарий до 2000 символов.');
  const fields=Object.fromEntries(recordFields.filter(key=>record.fields?.[key]).map(key=>[key,String(record.fields[key]).trim().slice(0,300)]));
  if (!fields.meter && !fields.account) throw new Error('Для отметки нужен номер ПУ или лицевого счёта.');
  return { id,fields,address:String(record.address || '').slice(0,700),note:note.trim(),type:'user',
    location:{lat:location.lat,lon:location.lon,precision:'manual'},createdAt:new Date().toISOString() };
}

export function createUserNotifications({ context,cache=createNotificationCache(),fetcher=(...args)=>fetch(...args),online=()=>navigator.onLine } = {}) {
  const listeners=new Set(),jobs=new Map(),messages=new Map(); let current='';
  const notify=async ctx=>{
    if (keyOf(ctx)!==keyOf(context())) return;
    try {
      const state=await cache.read(ctx);
      if (keyOf(ctx)!==keyOf(context())) return;
      const message=messages.get(keyOf(ctx)) || (state.pending.length ? online() && ctx.shared ? 'Отправляем изменения в общие уведомления…' : ctx.shared ? 'Изменения на телефоне. Отправим при появлении связи.' : 'Уведомления сохранены на этом устройстве.' : '');
      const data={notifications:visibleUserNotifications(state),pendingCount:state.pending.length,message,shared:ctx.shared};
      listeners.forEach(listener=>listener(data));
    } catch(error) { listeners.forEach(listener=>listener({notifications:[],pendingCount:0,message:error.message})); }
  };
  const endpoint=ctx=>{ const url=new URL(ctx.endpoint); url.searchParams.set('res',ctx.resPath); return url; };
  async function request(ctx,method='GET',body) {
    const response=await fetcher(endpoint(ctx),{ method,cache:'no-store',signal:AbortSignal.timeout(15000),
      ...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {}) });
    const data=await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Не удалось обновить общие уведомления.'),{status:response.status,code:data.code});
    if (!Number.isSafeInteger(data.generation) || data.generation<0 || !/^\d+$/.test(String(data.revision)) || !Array.isArray(data.notifications) || data.notifications.some(note=>note.type!=='user' || !validLocation(note.location))) throw new Error('Неизвестный формат общих уведомлений.');
    return data;
  }
  async function accept(ctx,data,ack) {
    let removed=false;
    await cache.change(ctx,state=>{
      if (state.generation!==null && data.generation<state.generation) return;
      if (state.generation===data.generation && BigInt(data.revision)<BigInt(state.revision)) {
        if(ack)state.pending=state.pending.filter(op=>op.token!==ack);
        return;
      }
      state.notifications=data.notifications; state.generation=data.generation; state.revision=data.revision;
      state.pending=state.pending.filter(op=>{
        if (op.token===ack) return false;
        if ((op.generation ?? 0)!==data.generation) { removed=true; return false; }
        // A lost POST response is acknowledged by the next complete snapshot.
        return !(op.kind==='create' && data.notifications.some(note=>note.id===op.id));
      });
    });
    if (removed) messages.set(keyOf(ctx),'Общие уведомления РЭС очищены. Старые изменения с телефона не восстанавливаются.');
  }
  async function sync(ctx=context()) {
    if (!ctx.resPath) { await notify(ctx); return; }
    if (!ctx.shared || !ctx.endpoint || !online() || ctx.autoSync===false) { await notify(ctx); return; }
    const key=keyOf(ctx);
    if (!jobs.has(key)) {
      const job=(async()=>{
        try {
          messages.delete(key); await accept(ctx,await request(ctx));
          const pending=(await cache.read(ctx)).pending;
          for (const op of pending) {
            // Re-read: another tab may have cancelled this operation meanwhile.
            if (!(await cache.read(ctx)).pending.some(item=>item.token===op.token)) continue;
            try {
              const body={resPath:ctx.resPath,generation:op.generation ?? 0};
              if (op.kind==='create') {
                const {id,fields,address,note,location}=op.notification;
                body.notification={id,fields,address,note,location};
              } else body.id=op.id;
              await accept(ctx,await request(ctx,op.kind==='create'?'POST':'DELETE',body),op.token);
            } catch(error) {
              if (error.code==='notification_deleted') {
                await cache.change(ctx,state=>{ state.pending=state.pending.filter(item=>item.token!==op.token); });
                messages.set(key,'Отметка уже удалена другим сотрудником.');
              } else if (error.code==='notifications_cleared') { await accept(ctx,await request(ctx)); break; }
              else throw error;
            }
          }
        } catch(error) { messages.set(key,'Нет синхронизации: '+error.message+' Сохранённые отметки доступны на телефоне.'); }
        finally { await notify(ctx); }
      })().finally(()=>jobs.delete(key));
      jobs.set(key,job);
    }
    return jobs.get(key);
  }
  return {
    subscribe(listener) { listeners.add(listener); return ()=>listeners.delete(listener); },
    changeContext() {
      const ctx=context(),key=keyOf(ctx)+'|'+Boolean(ctx.shared)+'|'+(ctx.autoSync!==false);
      if (key===current) return;
      current=key; void notify(ctx); void sync(ctx);
    },
    sync,
    async syncAll() {
      const ctx=context();
      if (!ctx.endpoint || !online()) return;
      try {
        for (const area of await cache.all()) if (area.source===ctx.source && area.shared && area.pending.length)
          await sync({...ctx,resPath:area.resPath,shared:true,autoSync:true});
        await sync();
      } catch(error) { messages.set(keyOf(ctx),error.message); await notify(ctx); }
    },
    async add(record,note,location) {
      const ctx={...context()};
      if (!ctx.resPath) throw new Error('Сначала выберите РЭС и откройте его реестр.');
      if (ctx.shared && online()) await sync({...ctx,autoSync:true});
      const notification=notificationFromRecord(record,note,location);
      await cache.change(ctx,state=>{
        state.shared=ctx.shared;
        state.pending.push({kind:'create',id:notification.id,notification,generation:state.generation,token:globalThis.crypto.randomUUID()});
      });
      messages.delete(keyOf(ctx)); await notify(ctx); void sync({...ctx,autoSync:true}); return notification;
    },
    async remove(id) {
      const ctx={...context()};
      await cache.change(ctx,state=>{
        state.pending=state.pending.filter(op=>op.id!==id);
        if (ctx.shared) state.pending.push({kind:'delete',id,generation:state.generation,token:globalThis.crypto.randomUUID()});
        else state.notifications=state.notifications.filter(note=>note.id!==id);
      });
      messages.delete(keyOf(ctx)); await notify(ctx); void sync({...ctx,autoSync:true});
    },
    async clear(resPath,source=context().source) {
      const ctx={...context(),source,resPath,shared:true};
      if (!ctx.endpoint || !online()) throw new Error('Для очистки общих уведомлений нужна связь с базой.');
      await jobs.get(keyOf(ctx));
      const data=await request(ctx);
      const cleared=await request(ctx,'DELETE',{resPath,generation:data.generation});
      await cache.change(ctx,state=>{state.generation=cleared.generation;state.revision=cleared.revision;state.notifications=[];state.pending=[];});
      messages.delete(keyOf(ctx)); await notify(ctx);
    },
    refresh:()=>notify(context()),
    close:()=>cache.close(),
  };
}
