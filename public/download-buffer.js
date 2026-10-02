// Reuse one allocation when the file size is known, rather than retaining
// every network chunk and another complete copy at the same time.
export async function readBoundedBuffer(response, maxBytes, expectedSize = 0) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) { await response.body?.cancel(); throw new Error('Файл превышает допустимый размер.'); }
  const hint = declared > 0 ? declared : expectedSize;
  const capacity = Number.isSafeInteger(hint) && hint > 0 && hint <= maxBytes ? hint : Math.min(65536, maxBytes);
  let bytes = new Uint8Array(capacity), length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      const next = length + value.byteLength;
      if (next > maxBytes) throw new Error('Файл превышает допустимый размер.');
      if (next > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(next, bytes.length * 2)));
        grown.set(bytes.subarray(0, length)); bytes = grown;
      }
      bytes.set(value, length); length = next;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return length === bytes.length ? bytes.buffer : bytes.buffer.slice(0, length);
}
