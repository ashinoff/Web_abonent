import { open, readFile, writeFile } from 'node:fs/promises';
import { sourceRoleKeys } from './public/source.js';

try {
  const [, , path, output, role, filename] = process.argv;
  if (!path || !output || !sourceRoleKeys.includes(role)) throw new Error('Некорректный запрос подготовки.');
  let prepared;
  if (role === 'events' && !/\.xlsb$/i.test(filename || '')) {
    const file = await open(path, 'r'), signature = Buffer.alloc(4);
    try { await file.read(signature, 0, 4, 0); } finally { await file.close(); }
    if (signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      const { readEventJournalXLSX } = await import('./journal-stream.mjs');
      prepared = await readEventJournalXLSX(path);
    }
  }
  if (!prepared) {
    const { prepareWorkbook } = await import('./prepared-workbook.mjs');
    prepared = prepareWorkbook(await readFile(path), role, filename);
  }
  await writeFile(output, JSON.stringify(prepared));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
