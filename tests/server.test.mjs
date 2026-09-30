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
    assert.equal((await fetch(root+'/api/resources?public_key=https://evil.test')).status,400);
    assert.equal((await fetch(root+'/.env')).status,404);
    assert.equal((await fetch(root,{method:'POST'})).status,405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
