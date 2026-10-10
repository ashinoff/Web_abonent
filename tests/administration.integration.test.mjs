import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createPreparedStore} from '../prepared-store.mjs';
import {createServer} from '../server.mjs';
import {sessionHash} from '../accounts.mjs';

// A separate test database is required. PGlite may be supplied by the local QA
// environment without adding a runtime dependency to the Amvera application.
test('accounts, session revocation and RES cleanup use actual PostgreSQL transactions',{skip:!process.env.TEST_DB_HOST&&!process.env.TEST_PGLITE_MODULE},async t=>{
  const env=Object.fromEntries(['HOST','PORT','NAME','USER','PASSWORD'].map(name=>['DB_'+name,process.env['TEST_DB_'+name]]));
  let pool;
  if(process.env.TEST_PGLITE_MODULE){
    const {PGlite}=await import(process.env.TEST_PGLITE_MODULE);const db=new PGlite();await db.waitReady;let queue=Promise.resolve();
    const serialized=work=>{const next=queue.then(work);queue=next.catch(()=>{});return next;};
    const query=async(sql,values=[])=>{const result=values.length?await db.query(sql,values):sql.includes(';')?{rows:[],affectedRows:0,...(await db.exec(sql)).at(-1)}:await db.query(sql);return{...result,rowCount:result.affectedRows??0};};
    pool={on(){},query:(...args)=>serialized(()=>query(...args)),end:()=>db.close()};
    // Reserve the serialized connection before allowing pool queries to proceed.
    pool.connect=async()=>{let release,start;const held=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{start=resolve;});serialized(async()=>{start();await held;});await started;return{query,release};};
    Object.assign(env,{DB_HOST:'test',DB_PORT:'5432',DB_NAME:'test',DB_USER:'test',DB_PASSWORD:'test'});
  }else pool=new pg.Pool({host:env.DB_HOST,port:Number(env.DB_PORT),database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,max:2});
  const store=createPreparedStore(env,{pool}),source='https://disk.yandex.ru/d/AdminTest'+randomUUID(),res='/ЭС/Первая',other='/ЭС/Вторая',file=res+'/реестр.xlsx';
  const password='Test-password-12345',login='root.'+randomUUID(),bootstrap={SUPER_ADMIN_LOGIN:login,SUPER_ADMIN_PASSWORD:password,YANDEX_PUBLIC_URL:source};
  const ids=[];let server;const originalFetch=globalThis.fetch;
  try{
    await store.ready();server=createServer({env:bootstrap,preparedStore:{...store,close:()=>{}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    async function api(path,{cookie='',method='GET',body,headers={}}={}){const response=await originalFetch(base+'/api/'+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,data:response.status===304?null:await response.json(),cookie:response.headers.get('set-cookie')};}
    const loginAs=async name=>{const result=await api('auth/login',{method:'POST',body:{login:name,password},headers:{'x-forwarded-proto':'https'}});assert.equal(result.status,200);assert.match(result.cookie,/HttpOnly; SameSite=Strict/);assert.match(result.cookie,/Secure/);return result.cookie.split(';')[0];};
    for(const path of ['directory','prepared','load-map','diagnostics','resources','admin/accounts'])assert.equal((await api(path)).status,401);
    assert.equal((await api('config')).data.publicUrl,'');
    assert.equal((await api('auth/login',{method:'POST',body:{login,password:'wrong'}})).status,401);
    const rootCookie=await loginAs(login);const root=(await api('auth/session',{cookie:rootCookie})).data.user;
    const create=async(role,name,cookie=rootCookie)=>{const result=await api('admin/accounts',{cookie,method:'POST',body:{role,login:name,name:'Тестовый сотрудник',password}});assert.equal(result.status,200);ids.push(result.data.account.id);assert.equal('password_hash'in result.data.account,false);return result.data.account;};
    const admin=await create('admin','admin.'+randomUUID()),user=await create('user','user.'+randomUUID());const adminCookie=await loginAs(admin.login),userCookie=await loginAs(user.login);
    await t.test('roles are enforced on direct HTTP requests',async()=>{
      assert.equal((await api('admin/accounts',{cookie:userCookie})).status,403);
      assert.equal((await api('admin/database',{cookie:userCookie})).status,403);
      const visible=(await api('admin/accounts',{cookie:adminCookie})).data.accounts;assert.ok(visible.length>=1);assert.ok(visible.every(item=>item.role==='user'));
      for(const role of ['admin','superadmin'])assert.equal((await api('admin/accounts',{cookie:adminCookie,method:'POST',body:{role,name:'Тест',login:'denied.'+randomUUID(),password}})).status,403);
      assert.equal((await api('admin/accounts/'+admin.id,{cookie:adminCookie,method:'PATCH',body:{name:'Запрещено'}})).status,403);
      assert.equal((await api('admin/accounts/'+user.id,{cookie:adminCookie,method:'PATCH',body:{role:'admin'}})).status,403);
      assert.equal((await api('admin/accounts/'+root.id,{cookie:rootCookie,method:'DELETE',body:{}})).status,409);
      assert.equal((await api('admin/accounts/'+root.id,{cookie:rootCookie,method:'PATCH',body:{name:'Изменить'}})).status,403);
      assert.equal((await api('admin/clear-events',{cookie:adminCookie,method:'POST',body:{},headers:{origin:'https://foreign.test'}})).status,403);
      const managed=await create('user','managed.'+randomUUID(),adminCookie);
      const managedCookie=await loginAs(managed.login);
      assert.equal((await api('admin/accounts/'+managed.id,{cookie:adminCookie,method:'DELETE',body:{}})).status,200);
      assert.equal((await api('diagnostics',{cookie:managedCookie})).status,401);
    });
    await t.test('password changes, disabling and deletion revoke existing sessions',async()=>{
      assert.equal((await api('admin/accounts/'+user.id,{cookie:adminCookie,method:'PATCH',body:{password:'Changed-password-123'}})).status,200);
      assert.equal((await api('diagnostics',{cookie:userCookie})).status,401);
      assert.equal((await api('auth/login',{method:'POST',body:{login:user.login,password}})).status,401);
      const changed=await api('auth/login',{method:'POST',body:{login:user.login,password:'Changed-password-123'}});assert.equal(changed.status,200);
      const changedCookie=changed.cookie.split(';')[0];assert.equal((await api('admin/accounts/'+user.id,{cookie:adminCookie,method:'PATCH',body:{active:false}})).status,200);
      assert.equal((await api('diagnostics',{cookie:changedCookie})).status,401);
      await assert.rejects(store.createSession(user.id,sessionHash('racing-token'),new Date(Date.now()+10000),'outdated-hash'),error=>error.status===401);
      assert.equal((await api('admin/accounts/'+user.id,{cookie:adminCookie,method:'DELETE',body:{}})).status,200);
    });
    const folder=path=>({path,name:path.split('/').at(-1),enterprisePath:'/ЭС',enterpriseName:'ЭС'}),data={format:1,role:'registry',sheets:[]};
    await store.putFolder(source,folder(res),{registry:{state:'ready',path:file,file:'реестр.xlsx'}});
    await store.putFolder(source,folder(other),{registry:{state:'pending',path:other+'/реестр.xlsx',file:'реестр.xlsx'}});
    await store.put(source,file,'registry','old',data);await store.put(source,other+'/реестр.xlsx','registry','other',data);await store.put('unrelated-source',file,'registry','other-source',data);
    await t.test('cleanup blocks online access and rejects late writes after immediate reopening',async()=>{
      const policy=await store.assertLoadAllowed(source,file);
      const clear=await api('admin/clear-data',{cookie:adminCookie,method:'POST',body:{resPath:res,confirm:true}});assert.equal(clear.status,200);assert.equal(clear.data.removed,1);
      assert.equal(await store.get(source,file,'registry'),null);assert.ok(await store.get(source,other+'/реестр.xlsx','registry'));assert.ok(await store.get('unrelated-source',file,'registry'));
      for(const path of ['directory?path=','resources?path=','download?path=','prepared?role=registry&path='])assert.equal((await api(path+encodeURIComponent(file),{cookie:adminCookie})).status,403);
      assert.equal((await originalFetch(base+'/api/prepared?role=registry&path='+encodeURIComponent(file),{method:'HEAD',headers:{cookie:adminCookie,'if-none-match':'"b2xk"'}})).status,403);
      assert.equal((await store.listAdminFolders(source)).find(item=>item.res_path===res).load_blocked,true);
      await store.setLoadPolicy(source,res,false,'test');
      await assert.rejects(store.put(source,file,'registry','late',data,policy),error=>error.code==='res_changed');
      await assert.rejects(store.markFile(source,file,'registry','ready',new Date(),policy),error=>error.code==='res_changed');
      assert.equal(await store.putFolder(source,folder(res),{registry:{state:'ready'}},policy),false);
      const repeated=createPreparedStore(env,{pool});assert.equal((await repeated.getLoadPolicy(source,file)).blocked,false);
      await store.setLoadPolicy(source,res,true,'test');assert.equal((await repeated.getLoadPolicy(source,file)).blocked,true);
      await store.setLoadPolicy(source,res,false,'test');await store.put(source,file,'registry','fresh',data,await store.assertLoadAllowed(source,file));
      const overview=await store.databaseOverview(source);assert.equal(overview.current_snapshot_count,2);
      const report=await api('admin/database',{cookie:adminCookie});assert.equal(report.status,200);assert.equal(report.data.folders.length,2);assert.ok(report.data.events.some(event=>event.code==='data_cleared'));
      assert.equal((await api('admin/clear-data',{cookie:adminCookie,method:'POST',body:{resPath:'/',confirm:true}})).status,200);
      await assert.rejects(store.assertLoadAllowed(source,'/Новое/РЭС/файл.xlsx'),error=>error.code==='res_blocked');
      const empty=await api('directory',{cookie:adminCookie});assert.equal(empty.status,200);assert.equal(empty.data._embedded.items.length,0);
      assert.equal(await store.get(source,other+'/реестр.xlsx','registry'),null);
      await store.setLoadPolicy(source,'/',false,'test');assert.equal((await store.assertLoadAllowed(source,'/Новое/РЭС/файл.xlsx')).blocked,false);
    });
    await store.ensureBootstrap({login,password:'Rotated-password-123',name:'Суперадминистратор'});assert.equal((await api('auth/session',{cookie:rootCookie})).data.user,null);
  }finally{
    await pool.query('DELETE FROM abonent_accounts WHERE id=ANY($1::uuid[]) OR login=$2',[ids,login]).catch(()=>{});
    for(const table of ['abonent_snapshots','abonent_folder_status','abonent_load_policy','abonent_admin_events'])await pool.query(`DELETE FROM ${table} WHERE source=$1 OR source=$2`,[source,'unrelated-source']).catch(()=>{});
    if(server)await new Promise(resolve=>server.close(resolve));await store.close();
  }
});
