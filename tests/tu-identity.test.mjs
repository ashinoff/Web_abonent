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

test('LS + TU selects all input rows, tariffs add once, TP keeps every distinct TU', () => {
  const a = row('001', 'Котельная', 100), night = row('001', 'Котельная', 30, 'Ночная');
  const b = row('001', 'Мастерская', 50), other = row('002', 'Котельная', 20);
  const model = indexMonthly({ months, rows: [a, { ...a, source: 'Ввод 2' }, night, b, other], warnings: [] });
  assert.equal(model.rows.length, 5);
  const records = parseMatrix([
    ['ЛС', 'Номер ПУ', 'ТУ', 'Номер ТУСТЕК', 'Максимальная мощность', 'ТП'],
    ['001', '01001', 'Котельная', '07001', '10', 'ТП-1'],
    ['001', '01002', 'Мастерская', '07001', '20', 'ТП-1'],
    ['002', '01003', 'Котельная', '07001', '5', 'ТП-1'],
  ]).records;
  const service = createAnalysisService(model, records);
  const selected = service.consumer('009', {}, null, { point: '07001', pointName: '  КОТЕЛЬНАЯ ' });
  assert.equal(selected.result.total, 230 * 24); assert.equal(selected.result.meter.power, 10);
  assert.equal(selected.result.meter.pointCount, 1); assert.equal(selected.result.meter.rowCount, 3);
  assert.equal(service.consumer('001', {}, null, records[1].fields).result.total, 50 * 24);
  assert.equal(service.consumer('001', {}, null, records[1].fields).result.meter.power, 20);
  const contour = service.contour('ТП-1', {});
  assert.equal(contour.total, 300 * 24); assert.equal(contour.pointCount, 3);
  assert.equal(contour.results.length, 2); assert.equal(contour.meterCount, 3);
  assert.throws(() => service.consumer('001', {}, null, { point: '07001' }), /несколько точек/);
  assert.throws(() => service.consumer('001', {}, null, { point: '07001', pointName: 'Неизвестная ТУ' }), /ЛС \+ ТУ не найдена/);
  assert.throws(() => service.consumer('001', {}, null, {}), /не указана ТУ/);
});

test('TU names without STEK still distinguish points and allow multiple input rows', () => {
  const a = { ...row('001', 'Котельная', 100), point: '' }, b = { ...row('001', 'Мастерская', 200), point: '' };
  assert.equal(indexMonthly({ months, rows: [a, b], warnings: [] }).rows.length, 2);
  const model = indexMonthly({ months, rows: [a, { ...a, values: Array(24).fill(200) }, b], warnings: [] });
  assert.equal(createAnalysisService(model).consumer('001', {}, null, {pointName:'Котельная'}).result.total,300*24);
});

for (const bookType of ['biff8', 'xlsx']) test(`${bookType}: alternating and equal input volumes add within one TU`, () => {
  const header = ['ЛС/Номер договора', 'Номер точки учета СТЕК', 'ТУ', 'ТП', 'Тарифная зона', 'Итого ПО январь 2026', 'Итого ПО февраль 2026', 'Итого ПО март 2026', 'Итого ПО апрель 2026'];
  const matrix = [header,
    ['001','07001','Котельная','ТП-1','Однозонный',100,0,30,40],
    ['001','07001','Котельная','ТП-1','Однозонный',0,120,30,40],
    ['001','07002','Мастерская','ТП-1','Однозонный',5,5,5,5],
  ];
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), 'ПО');
  const model = indexMonthly(readMonthlyWorkbook(XLSX.write(book, {type:'buffer',bookType}), XLSX));
  const records = parseMatrix([['ЛС','ТУ','Номер ТУСТЕК','Номер ПУ','ТП','Максимальная мощность','Коэф ТТ'],
    ['001','Котельная','07001','01001','ТП-1',50,60], ['001','Котельная','07001','01002','ТП-1',50,60],
    ['001','Мастерская','07002','01003','ТП-1',10,1],
  ]).records;
  const service = createAnalysisService(model, records);
  for (const record of records.slice(0,2)) {
    const result = service.consumer('001', {}, null, record.fields).result;
    assert.deepEqual(result.meter.values,[100,120,60,80]); assert.equal(result.total,360);
    assert.equal(result.meter.pointCount,1); assert.equal(result.meter.rowCount,2); assert.equal(result.meter.power,50);
    assert.deepEqual(result.meter.sources,['ПО:2','ПО:3']);
  }
  const contour = service.contour('ТП-1', {});
  assert.deepEqual(contour.values,[105,125,65,85]); assert.equal(contour.total,380);
  assert.equal(contour.pointCount,2); assert.equal(contour.results.length,1); assert.equal(contour.meterCount,3);
});

test('one TU with inputs from two TPs sums individually and splits correctly by contour', () => {
  const a = {...row('001','Котельная',0), values:months.map((_,i)=>i%2?0:100)}, b = {...a,tp:'ТП-2',values:months.map((_,i)=>i%2?120:0)};
  const service = createAnalysisService(indexMonthly({months,rows:[a,b],warnings:[]}));
  assert.deepEqual(service.consumer('001', {}, null, {point:'07001',pointName:'Котельная'}).result.meter.values,months.map((_,i)=>i%2?120:100));
  assert.equal(service.contour('ТП-1', {}).total,1200); assert.equal(service.contour('ТП-2', {}).total,1440);
});

test('flags and recommendations use the combined monthly history, not each input separately', () => {
  const a={...row('001','Котельная',0),values:months.map((_,i)=>i<12?1000:0)}, b={...a,values:months.map((_,i)=>i<12?0:1000)};
  const analyse=rows=>createAnalysisService(indexMonthly({months,rows,warnings:[]})).consumer('001',{},null,{point:'07001',pointName:'Котельная'}).result;
  const actual=analyse([a,b]), reference=analyse([{...a,values:Array(24).fill(1000)}]);
  assert.deepEqual(actual.meter.values,reference.meter.values); assert.deepEqual(actual.flags,reference.flags);
  assert.equal(actual.score,reference.score); assert.equal(actual.lossKwh,reference.lossKwh); assert.equal(actual.total,24000);
});
