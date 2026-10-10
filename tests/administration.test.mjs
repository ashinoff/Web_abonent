import test from 'node:test';
import assert from 'node:assert/strict';
import {hashPassword,verifyPassword,accountLogin,accountPassword,superAdminConfig,assertManager,publicAccount} from '../accounts.mjs';
import {resScope,assertPolicy,preparationIssue} from '../admin-store.mjs';
import {createPreparedService} from '../prepared-service.mjs';

test('passwords use independent salts; identity and roles expose no password hashes',async()=>{
  const password='A-long-test-password';const a=await hashPassword(password),b=await hashPassword(password);
  assert.notEqual(a,b);assert.equal(await verifyPassword(password,a),true);assert.equal(await verifyPassword('wrong',a),false);
  assert.equal(await verifyPassword(password,'invalid'),false);
  assert.equal(accountLogin(' ТЕСТ.Admin '),'тест.admin');assert.throws(()=>accountLogin('../admin'));assert.throws(()=>accountPassword('short'));
  assert.equal(superAdminConfig({}),null);assert.throws(()=>superAdminConfig({SUPER_ADMIN_LOGIN:'admin'}));
  const safe=publicAccount({id:'1',full_name:'Имя',login:'admin',role:'superadmin',password_hash:a});assert.equal('password_hash'in safe,false);
  assertManager({role:'superadmin'},{role:'admin'});assertManager({role:'admin'},{role:'user'});
  for(const role of ['admin','superadmin'])assert.throws(()=>assertManager({role:'admin'},{role}),error=>error.status===403);
  assert.throws(()=>assertManager({role:'superadmin'},{role:'superadmin',is_bootstrap:true}),error=>error.status===403);
});

test('a clear followed by immediate reopening still rejects jobs from the old generation',()=>{
  assert.equal(resScope('/Предприятие/РЭС/файл.xlsx'),'/Предприятие/РЭС');assert.equal(resScope('/'),null);
  for(const path of ['/ЭС//РЭС','/ЭС/../РЭС','/ЭС/./РЭС','relative'])assert.throws(()=>resScope(path));
  const old={blocked:false,generation:'0',globalGeneration:'0'};
  assert.throws(()=>assertPolicy({...old,blocked:true},old),error=>error.code==='res_blocked');
  assert.throws(()=>assertPolicy({...old,generation:'2'},old),error=>error.code==='res_changed');
  assert.throws(()=>assertPolicy({...old,globalGeneration:'2'},old),error=>error.code==='res_changed');
  assert.equal(preparationIssue(new Error('password=secret host=private')).message.includes('secret'),false);
});

test('catalog scans discover a blocked RES without reading or downloading its contents',async()=>{
  const path='/ЭС/Закрытая',calls=[],folders=[];
  const service=createPreparedService({source:'test',store:{listFolders:async()=>[],getLoadPolicy:async()=>({blocked:true}),
    assertLoadAllowed:async()=>{throw Object.assign(new Error('Загрузка закрыта.'),{status:403});},
    putFolder:async(source,folder,statuses)=>folders.push({folder,statuses})},yandex:async url=>{
    calls.push(url.searchParams.get('path'));const items=url.searchParams.get('path')==='/'?[{type:'dir',path:'/ЭС',name:'ЭС'}]:[{type:'dir',path,name:'Закрытая'}];
    return Response.json({type:'dir',_embedded:{items,total:items.length}});
  }});
  await service.syncAll({prepare:false});assert.deepEqual(calls,['/','/ЭС']);assert.equal(folders[0].statuses.registry.state,'blocked');
  await assert.rejects(service.fromDatabase(path+'/файл.xlsx','registry'),error=>error.status===403);assert.deepEqual(calls,['/','/ЭС']);
});
