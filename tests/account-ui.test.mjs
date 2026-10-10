import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {initAccountUI} from '../public/account-ui.js';

async function page(t,online=true){
  const window=new Window({url:'https://app.example.test/'});window.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  for(const [key,value]of Object.entries({window,document:window.document,location:window.location,localStorage:window.localStorage,navigator:{onLine:online},Event:window.Event})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);
  }
  return {window,$:selector=>window.document.querySelector(selector)};
}
const user={id:'test',name:'Тестовый сотрудник',login:'user.test',role:'user',active:true};
test('account login hides admin controls and stores only public identity for offline work',async t=>{
  const p=await page(t);const expiresAt=new Date(Date.now()+86400000).toISOString();
  const ui=initAccountUI({fetcher:async()=>Response.json({user,expiresAt})});await ui.start({enabled:true});
  assert.equal(p.$('#admin-tab').hidden,true);assert.equal(ui.isAdmin,false);assert.equal(p.$('#account-name').textContent,user.name);
  const saved=JSON.parse(localStorage.getItem('abonent.identity.v1'));assert.deepEqual(saved,{user,expiresAt});assert.equal(p.$('#login-password').value,'');
});
test('a valid previous session permits offline copies without a server request',async t=>{
  const p=await page(t,false);localStorage.setItem('abonent.identity.v1',JSON.stringify({user,expiresAt:new Date(Date.now()+86400000).toISOString()}));
  const ui=initAccountUI({fetcher:()=>{throw new Error('Must not use the network offline.');}});await ui.start({enabled:true});
  assert.equal(ui.user.id,user.id);assert.equal(p.$('#login-dialog').open,false);assert.match(p.$('#account-description').textContent,/Работа без связи/);
});
test('reconnecting during explicit offline selection does not refresh the session over the network',async t=>{
  const p=await page(t);let requests=0;const ui=initAccountUI({canRefresh:()=>false,fetcher:async()=>{requests++;return Response.json({user,expiresAt:new Date(Date.now()+86400000).toISOString()});}});
  await ui.start({enabled:true});assert.equal(requests,1);p.window.dispatchEvent(new Event('online'));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests,1);
});
test('a revoked session clears the cached identity and the mandatory login cannot be dismissed',async t=>{
  const p=await page(t);localStorage.setItem('abonent.identity.v1',JSON.stringify({user,expiresAt:new Date(Date.now()+86400000).toISOString()}));
  const ui=initAccountUI({reload(){},fetcher:async(url)=>Response.json(new URL(url).pathname.endsWith('login')?{user,expiresAt:new Date(Date.now()+86400000).toISOString()}:{user:null})});
  const opening=ui.start({enabled:true});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(p.$('#login-dialog').open,true);assert.equal(localStorage.getItem('abonent.identity.v1'),null);
  const cancel=new Event('cancel',{cancelable:true});p.$('#login-dialog').dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true);assert.equal(p.$('#login-dialog').open,true);
  p.$('#login-login').value=user.login;p.$('#login-password').value='Test-password-12345';p.$('#login-form').dispatchEvent(new Event('submit',{cancelable:true}));await opening;
  assert.equal(ui.user.id,user.id);assert.equal(p.$('#login-password').value,'');assert.equal(p.$('#login-dialog').open,false);
});
