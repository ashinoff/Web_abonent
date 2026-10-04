import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validPublicUrl, validDownloadUrl } from '../server.mjs';
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
test('public source and download address restrictions', () => {
  assert.equal(validPublicUrl('https://disk.yandex.ru/d/Example'),true);
  for(const s of ['http://disk.yandex.ru/d/x','https://disk.yandex.ru.evil.test/d/x','http://127.0.0.1','https://user:pass@disk.yandex.ru/d/x']) assert.equal(validPublicUrl(s),false);
  assert.equal(validDownloadUrl('https://downloader.disk.yandex.ru/disk/abc'),true);
  assert.equal(validDownloadUrl('https://yandex.ru.evil.test/'),false);
});
test('static serving, API configuration and rejected arbitrary remote source', async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const index = await fetch(root); assert.equal(index.status,200); assert.match(await index.text(),/id="search-form"/);
    assert.equal((await (await fetch(root+'/api/config')).json()).proxy,true);
    assert.equal((await fetch(root+'/api/resources?public_key=https://evil.test')).status,503);
    assert.equal((await fetch(root+'/.env')).status,404);
    assert.equal((await fetch(root,{method:'POST'})).status,405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('API and static errors do not expose the database host or absolute filesystem path', async () => {
  const previous=process.env.YANDEX_PUBLIC_URL;
  process.env.YANDEX_PUBLIC_URL='https://disk.yandex.ru/d/ErrorTest';
  const server=createServer({preparedStore:{listFolders:async()=>{throw new Error('connect ECONNREFUSED 10.20.30.40:5432');},close:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const root=`http://127.0.0.1:${server.address().port}`;
    const database=await fetch(root+'/api/load-map');
    assert.equal(database.status,502);
    assert.doesNotMatch(await database.text(),/10\.20\.30\.40|ECONNREFUSED/);
    const invalid=await fetch(root+'/%E0%A4%A');
    assert.equal(invalid.status,400);
    assert.doesNotMatch(await invalid.text(),/\/workspace|URI malformed/);
    const nul=await fetch(root+'/index.html%00');
    assert.equal(nul.status,400);
    assert.doesNotMatch(await nul.text(),/\/workspace|public\/index/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if(previous===undefined) delete process.env.YANDEX_PUBLIC_URL; else process.env.YANDEX_PUBLIC_URL=previous;
  }
});
test('Amvera environment supplies the shared source; query parameters cannot replace it', async t => {
  const previous = process.env.YANDEX_PUBLIC_URL;
  const clientFetch = globalThis.fetch;
  process.env.YANDEX_PUBLIC_URL = '  https://disk.yandex.ru/d/ConfiguredRoot  ';
  let upstream;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    if (String(input).startsWith('https://cloud-api.yandex.net/')) {
      upstream = new URL(input);
      return Response.json({type:'dir',_embedded:{items:[],total:0}});
    }
    return clientFetch(input, options);
  });
  const server = createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const config = await (await clientFetch(root+'/api/config')).json();
    assert.equal(config.configured,true);
    assert.equal(config.publicUrl,'https://disk.yandex.ru/d/ConfiguredRoot');
    assert.equal((await clientFetch(root+'/api/resources?path=/District')).status,200);
    assert.equal(upstream.searchParams.get('public_key'),config.publicUrl);
    assert.equal(upstream.searchParams.get('path'),'/District');
    const nested = '/Сочинские ЭС/Дагомысский РЭС/По по месячно.xls';
    assert.equal((await clientFetch(root+'/api/resources?path='+encodeURIComponent(nested))).status,200);
    assert.equal(upstream.searchParams.get('path'),nested);
    assert.equal(upstream.searchParams.get('public_key'),config.publicUrl);
    await clientFetch(root+'/api/resources?public_key=https://disk.yandex.ru/d/OtherRoot');
    assert.equal(upstream.searchParams.get('public_key'),config.publicUrl);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if (previous === undefined) delete process.env.YANDEX_PUBLIC_URL; else process.env.YANDEX_PUBLIC_URL=previous;
  }
});
test('five parallel users stream independent files and share only in-flight metadata', async t => {
  const previous=process.env.YANDEX_PUBLIC_URL, clientFetch=globalThis.fetch;
  process.env.YANDEX_PUBLIC_URL='https://disk.yandex.ru/d/ConcurrencyTest';
  let metadataCalls=0, downloads=0;
  const chunk=new Uint8Array(32768).fill(37), chunkCount=64;
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const url=String(input);
    if(url.startsWith('https://cloud-api.yandex.net/')){
      metadataCalls++;await pause(30);return Response.json({href:'https://downloader.disk.yandex.ru/test-file'});
    }
    if(url.startsWith('https://downloader.disk.yandex.ru/')){
      downloads++;let sent=0;
      return new Response(new ReadableStream({async pull(c){await pause(1);if(sent++<chunkCount)c.enqueue(chunk);else c.close();}}),{headers:{'content-length':String(chunk.length*chunkCount)}});
    }
    return clientFetch(input,options);
  });
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const results=await Promise.all(Array.from({length:5},async()=>{
      const response=await clientFetch(base+'/api/download?path=/PO.xlsx');
      assert.equal(response.status,200);assert.equal(Number(response.headers.get('content-length')),chunk.length*chunkCount);
      const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.length,chunk.length*chunkCount);assert.ok(bytes.every(n=>n===37));
      return bytes.length;
    }));
    assert.equal(results.length,5);assert.equal(downloads,5);assert.equal(metadataCalls,1);
    assert.equal((await clientFetch(base+'/api/config')).status,200);
    await (await clientFetch(base+'/api/download?path=/PO.xlsx')).arrayBuffer();
    assert.equal(metadataCalls,2,'refresh must fetch new metadata rather than reuse a stale file link');
  }finally{await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.YANDEX_PUBLIC_URL;else process.env.YANDEX_PUBLIC_URL=previous;}
});
test('closing one download aborts only its upstream stream and leaves other users working', async t => {
  const previous=process.env.YANDEX_PUBLIC_URL,clientFetch=globalThis.fetch;
  process.env.YANDEX_PUBLIC_URL='https://disk.yandex.ru/d/DisconnectTest';
  let slowAborted=false;
  t.mock.method(globalThis,'fetch',async(input,options)=>{
    const url=new URL(String(input));
    if(url.hostname==='cloud-api.yandex.net')return Response.json({href:'https://downloader.disk.yandex.ru'+url.searchParams.get('path')});
    if(url.hostname==='downloader.disk.yandex.ru'){
      if(url.pathname==='/slow.xlsx'){
        let timer;
        const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(1024));timer=setInterval(()=>c.enqueue(new Uint8Array(1024)),20);options.signal.addEventListener('abort',()=>{slowAborted=true;clearInterval(timer);},{once:true});},cancel(){clearInterval(timer);}});
        return new Response(stream);
      }
      return new Response(Uint8Array.from([7,8,9]));
    }
    return clientFetch(input,options);
  });
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`, controller=new AbortController();
    const slow=await clientFetch(base+'/api/download?path=/slow.xlsx',{signal:controller.signal});
    const reader=slow.body.getReader();assert.equal((await reader.read()).done,false);controller.abort();
    const other=await clientFetch(base+'/api/download?path=/other.xlsx');assert.deepEqual([...new Uint8Array(await other.arrayBuffer())],[7,8,9]);
    for(let i=0;i<20&&!slowAborted;i++)await pause(10);
    assert.equal(slowAborted,true);assert.equal((await clientFetch(base+'/api/config')).status,200);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.YANDEX_PUBLIC_URL;else process.env.YANDEX_PUBLIC_URL=previous;}
});
