import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedBuffer } from '../public/download-buffer.js';

function response(chunks, length = null, cancelled = () => {}) {
  return new Response(new ReadableStream({
    pull(controller) { chunks.length ? controller.enqueue(Uint8Array.from(chunks.shift())) : controller.close(); },
    cancel: cancelled,
  }), { headers: length == null ? {} : { 'content-length': String(length) } });
}
test('bounded download preserves all bytes with known, unknown and changed file sizes', async () => {
  for (const [declared, hint] of [[6,0],[null,0],[null,6],[null,2],[null,10],[2,0]]) {
    const buffer = await readBoundedBuffer(response([[1,2],[3],[4,5,6]],declared),12,hint);
    assert.deepEqual([...new Uint8Array(buffer)],[1,2,3,4,5,6]);
  }
  assert.equal((await readBoundedBuffer(response([],0),12)).byteLength,0);
});
test('oversized and interrupted downloads are cancelled instead of returning partial data', async () => {
  let cancelled=0;
  await assert.rejects(readBoundedBuffer(response([[1]],30,()=>cancelled++),12),/допустимый размер/);
  await assert.rejects(readBoundedBuffer(response([[1,2],[3,4],[5,6],[7]],null,()=>cancelled++),5),/допустимый размер/);
  assert.equal(cancelled,2);
  const broken=new Response(new ReadableStream({ start(c){ c.error(new Error('network interrupted')); } }));
  await assert.rejects(readBoundedBuffer(broken,12),/network interrupted/);
});
