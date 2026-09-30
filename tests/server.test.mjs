import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validPublicUrl, validDownloadUrl } from '../server.mjs';
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
    const index = await fetch(root); assert.equal(index.status,200); assert.match(await index.text(),/Найти абонента/);
    assert.equal((await (await fetch(root+'/api/config')).json()).proxy,true);
    assert.equal((await fetch(root+'/api/resources?public_key=https://evil.test')).status,503);
    assert.equal((await fetch(root+'/.env')).status,404);
    assert.equal((await fetch(root,{method:'POST'})).status,405);
  } finally { await new Promise(resolve => server.close(resolve)); }
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
    await clientFetch(root+'/api/resources?public_key=https://disk.yandex.ru/d/OtherRoot');
    assert.equal(upstream.searchParams.get('public_key'),config.publicUrl);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if (previous === undefined) delete process.env.YANDEX_PUBLIC_URL; else process.env.YANDEX_PUBLIC_URL=previous;
  }
});
