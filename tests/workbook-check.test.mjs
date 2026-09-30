import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { inspectMonthlyWorkbook } from '../public/workbook-check.js';

function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Месяцы');
  return XLSX.write(book, { bookType:'biff8', type:'array' });
}
test('monthly XLS is read without requiring subscriber columns or changing its values', () => {
  const buffer = workbook([['Месяц', 'ПО'], ['Сентябрь', 0]]);
  assert.deepEqual(inspectMonthlyWorkbook(buffer, XLSX), { sheets:1 });
  assert.equal(XLSX.read(buffer).Sheets['Месяцы'].B2.v, 0);
});
test('a filename alone cannot turn on monthly readiness for text, damaged or empty books', () => {
  assert.throws(() => inspectMonthlyWorkbook(new TextEncoder().encode('not an Excel file').buffer, XLSX), /книгой Excel/);
  assert.throws(() => inspectMonthlyWorkbook(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]).buffer, XLSX));
  assert.throws(() => inspectMonthlyWorkbook(workbook([]), XLSX), /заполненных листов/);
});
