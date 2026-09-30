import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { readMonthlyWorkbook, indexMonthly } from '../public/monthly.js';
import { parseMatrix } from '../public/core.js';
import { createAnalysisService } from '../public/analysis-service.js';

const months = Array.from({ length: 24 }, (_, i) => ({ y: 2024 + Math.floor(i / 12), m: i % 12 }));
const row = (account, name, volume, zone = 'Однозонный') => ({ account, accountKey: account, alias: account === '001' ? '009' : '', point: '07001', pointNumber: '', pointName: name, name: 'ООО «Учебное»', tp: 'ТП-1', zone, values: Array(24).fill(volume), source: name });

for (const bookType of ['biff8', 'xlsx']) test(`${bookType}: preserve both TU numbers and name when STEK is repeated`, () => {
  const matrix = [
    ['ЛС/Номер договора', '№ ТУ', 'Номер точки учета СТЕК', 'ФИО/ Наименование точки учёта', 'ТП', 'Тарифная зона', 'Итого ПО январь 2026', 'Итого ПО февраль 2026'],
    ['001', 7, '07001', 'Котельная', 'ТП-1', 'Однозонный', 10, 20],
    ['001', 8, '07001', 'Котельная', 'ТП-1', 'Однозонный', 30, 40],
  ];
  const ws = XLSX.utils.aoa_to_sheet(matrix); ws.B2.z = ws.B3.z = '0000';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, ws, 'ПО');
  const parsed = readMonthlyWorkbook(XLSX.write(book, { type: 'buffer', bookType }), XLSX);
  assert.deepEqual(parsed.rows.map(r => [r.account, r.pointNumber, r.point, r.pointName]), [['001', '0007', '07001', 'Котельная'], ['001', '0008', '07001', 'Котельная']]);
  const model = indexMonthly(parsed); assert.equal(model.rows.length, 2);
  const fields = parseMatrix([['ЛС', 'Номер ПУ', '№ ТУ', 'Номер ТУСТЕК', 'ТУ'], ['001', '01001', '0008', '07001', 'Котельная']]).records[0].fields;
  assert.equal(fields.pointNumber, '0008');
  const result = createAnalysisService(model).consumer('001', {}, null, fields);
  assert.deepEqual(result.result.meter.values, [30, 40]);
  assert.equal(result.result.total, 70); assert.equal(result.selectedPoint, true);
});

test('LS + TU name isolates the selected card, tariffs add once, TP keeps every distinct TU', () => {
  const a = row('001', 'Котельная', 100), night = row('001', 'Котельная', 30, 'Ночная');
  const b = row('001', 'Мастерская', 50), other = row('002', 'Котельная', 20);
  const model = indexMonthly({ months, rows: [a, { ...a }, night, b, other], warnings: [] });
  assert.equal(model.duplicates, 1); assert.equal(model.rows.length, 4);
  const records = parseMatrix([
    ['ЛС', 'Номер ПУ', 'ТУ', 'Номер ТУСТЕК', 'Максимальная мощность', 'ТП'],
    ['001', '01001', 'Котельная', '07001', '10', 'ТП-1'],
    ['001', '01002', 'Мастерская', '07001', '20', 'ТП-1'],
    ['002', '01003', 'Котельная', '07001', '5', 'ТП-1'],
  ]).records;
  const service = createAnalysisService(model, records);
  const selected = service.consumer('009', {}, null, { point: '07001', pointName: '  КОТЕЛЬНАЯ ' });
  assert.equal(selected.result.total, 130 * 24); assert.equal(selected.result.meter.power, 10);
  assert.equal(selected.result.meter.pointCount, 1); assert.equal(selected.result.meter.rowCount, 2);
  assert.equal(service.consumer('001', {}, null, records[1].fields).result.total, 50 * 24);
  assert.equal(service.consumer('001', {}, null, records[1].fields).result.meter.power, 20);
  const contour = service.contour('ТП-1', {});
  assert.equal(contour.total, 200 * 24); assert.equal(contour.pointCount, 3);
  assert.equal(contour.results.length, 2); assert.equal(contour.meterCount, 3);
  assert.throws(() => service.consumer('001', {}, null, { point: '07001' }), /несколько точек/);
  assert.throws(() => service.consumer('001', {}, null, { point: '07001', pointName: 'Неизвестная ТУ' }), /ЛС \+ ТУ не найдена/);
  assert.throws(() => service.consumer('001', {}, null, {}), /не указана ТУ/);
});

test('different TU names survive without STEK; conflicting copies of the same LS + TU still require correction', () => {
  const a = { ...row('001', 'Котельная', 100), point: '' }, b = { ...row('001', 'Мастерская', 200), point: '' };
  assert.equal(indexMonthly({ months, rows: [a, b], warnings: [] }).rows.length, 2);
  assert.throws(() => indexMonthly({ months, rows: [a, { ...a, values: Array(24).fill(200) }], warnings: [] }), /одна и та же ТУ.*разными объёмами/);
});
