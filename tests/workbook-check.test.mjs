import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { inspectExcelWorkbook } from '../public/workbook-check.js';

function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Месяцы');
  return XLSX.write(book, { bookType:'biff8', type:'array' });
}
test('incoming XLS is read without imposing a balance schema or changing values', () => {
  const buffer = workbook([['Месяц', 'ПО'], ['Сентябрь', 0]]);
  assert.deepEqual(inspectExcelWorkbook(buffer, XLSX), { sheets:1 });
  assert.equal(XLSX.read(buffer).Sheets['Месяцы'].B2.v, 0);
});
test('a filename alone cannot turn on incoming readiness for text, damaged or empty books', () => {
  assert.throws(() => inspectExcelWorkbook(new TextEncoder().encode('not an Excel file').buffer, XLSX), /книгой Excel/);
  assert.throws(() => inspectExcelWorkbook(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]).buffer, XLSX));
  assert.throws(() => inspectExcelWorkbook(workbook([]), XLSX), /заполненных листов/);
});
