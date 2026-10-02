import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { readMonthlyWorkbook, parseMonthlyMatrix } from '../public/monthly.js';
import { splitYears } from '../public/chart-years.js';

const names = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const matrix = () => [
  ['Полезный отпуск по\u00a0 всем точкам учета за Январь 2022 г. - Август 2026 г.'],
  ['ФЭС. Дагомысский РЭС. РРЭС'],
  ['ЛС/Номер договора', 'ТУ', ...Array.from({ length: 56 }, (_, i) => `Итого ПО(кВт*ч) ${names[i % 12]}`), 'ВСЕГО ПО(кВт*ч) за 56 месяцев'],
  ['00001', 'Учебная точка', ...Array.from({ length: 56 }, (_, i) => i === 1 ? '' : i), ''],
];
for (const bookType of ['biff8', 'xlsx']) test(`${bookType}: Jan 2022 – Aug 2026 title assigns 56 months and five overlaid years`, () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix()), 'ПО');
  const data = readMonthlyWorkbook(XLSX.write(book, { bookType, type: 'buffer' }), XLSX);
  assert.equal(data.months.length, 56);
  assert.deepEqual(data.months[0], { y: 2022, m: 0 });
  assert.deepEqual(data.months.at(-1), { y: 2026, m: 7 });
  const years = splitYears(data.months, data.rows[0].values);
  assert.deepEqual(years.map(s => s.year), [2022, 2023, 2024, 2025, 2026]);
  assert.equal(new Set(years.map(s => s.color)).size, 5);
  assert.deepEqual(years.map(s => s.values[0]), [0, 12, 24, 36, 48]);
  assert.equal(years[0].values[1], null); assert.equal(years[0].included[1], true);
  assert.equal(years[4].values[7], 55);
  assert.deepEqual(years[4].values.slice(8), [null, null, null, null]);
  assert.deepEqual(years[4].included.slice(8), [false, false, false, false]);
});
test('partial first year starts in its calendar month; series do not mutate inputs', () => {
  const months = [{ y: 2025, m: 10 }, { y: 2025, m: 11 }, { y: 2026, m: 0 }], values = [10, null, 0];
  const years = splitYears(months, values);
  assert.deepEqual(years[0].values, [...Array(10).fill(null), 10, null]);
  assert.deepEqual(years[0].included, [...Array(10).fill(false), true, true]);
  assert.equal(years[1].values[0], 0); assert.deepEqual(values, [10, null, 0]);
});
test('title split across cells is authoritative; contradictory years and truncated period are rejected', () => {
  const rows = matrix();
  rows[0] = ['Полезный отпуск по всем точкам учета за', 'Январь 2022 г.', '—', 'Август 2026 г.'];
  assert.equal(parseMonthlyMatrix(rows).months.length, 56);
  rows[2][2] += ' 2023';
  assert.throws(() => parseMonthlyMatrix(rows), /не совпадают/);
  const short = matrix(); short[0][0] = short[0][0].replace('Август', 'Июль');
  assert.throws(() => parseMonthlyMatrix(short), /Количество/);
});
