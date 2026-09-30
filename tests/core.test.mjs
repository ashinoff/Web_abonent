import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { parseMatrix, buildIndex, search, detectLayout, restoreNumericIdentifiers } from '../public/core.js';
import { demo } from '../public/demo.js';

test('leading zeroes, exact matches, duplicates and partial lookup', () => {
  const parsed = parseMatrix(demo.sheets[0].matrix);
  const index = buildIndex([parsed]);
  assert.equal(index.records.length, 4);
  assert.equal(search(index, { query: '00123456' }).total, 1);
  assert.equal(search(index, { query: '123456' }).total, 0);
  assert.equal(search(index, { query: ' 0012 3456 ' }).total, 1);
  assert.equal(search(index, { query: '00000001001', field: 'account' }).total, 2);
  assert.equal(search(index, { query: '1234', partial: true }).total, 2);
  assert.equal(search(index, { query: 'Сочи примерная 12', field: 'address' }).total, 2);
});
test('flattened two-level header matching the provided 1C structure', () => {
  const top = ['№ п/п', 'ТУ', 'Номер ТУСТЕК', 'Номер ТУ', 'ЛС / ЛС СТЕК', 'Наименование договора', 'Основные реквизиты', 'Адрес точки учета'];
  const lower = ['Субабонент', 'Состояние ТУ', 'Населенный пункт', 'Улица', 'Дом', 'Корпус', 'Квартира', 'Телефон', 'Подстанция', 'Фидер10', 'Опора 10Кв', 'ТП', 'Максимальная мощность', 'Вид счетчика', 'Номер счетчика', 'Коэффициент трансформации'];
  const row = ['1', 'Здание', '0000777', '', '000001001', 'Учебный абонент', '', 'Вкл', 'Сочи', 'Примерная', '12', '', '', '', 'ПС Пример', 'ВЛ-1', '', 'ТП-100', '15', 'РиМ', '00123456', '1'];
  const parsed = parseMatrix([['Отчёт'], [], top, lower, row]);
  assert.equal(parsed.layout.flattened, true);
  assert.equal(parsed.records[0].fields.meter, '00123456');
  assert.equal(parsed.records[0].fields.account, '000001001');
  assert.equal(parsed.records[0].fields.transformerRatio, '1');
  assert.equal(parsed.records[0].address, 'Сочи, Примерная, д. 12');
  assert.equal(parsed.records[0].values.length, row.length);
});
test('quick TT ratio comes from the meter group, with original values and empty cells preserved', () => {
  const rows = [
    ['ЛС', 'Характеристики ТН', 'Прибор учета', ''],
    ['', 'Коэффициент трансформации', 'Номер счетчика', 'Коэффициент трансформации'],
    ['001', '600', '005', '40'],
    ['002', '600', '006', 0],
    ['003', '600', '007', ''],
    ['004', '600', '008', '12,5'],
  ];
  const merges = [{s:{r:0,c:0},e:{r:1,c:0}}, {s:{r:0,c:2},e:{r:0,c:3}}];
  const parsed = parseMatrix(rows, {merges});
  assert.deepEqual(parsed.records.map(r=>r.fields.transformerRatio), ['40','0','','12,5']);
  assert.equal(search(buildIndex([parsed]),{query:'005'}).records[0].fields.transformerRatio,'40');
  const combined = parseMatrix([['ЛС','Номер ПУ','Прибор учёта\nКоэфициент трансформации'],['001','005','100/5']]);
  assert.equal(combined.records[0].fields.transformerRatio,'100/5');
});
test('native Excel merged headers retain positions and unknown fields', () => {
  const rows = [['Отчёт'], ['ЛС / ЛС СТЕК', 'Наименование договора', 'Прибор учета', '', 'Дополнительное поле'], ['', '', 'Вид счетчика', 'Номер счетчика'], ['00001001', 'Пример', 'РиМ', '00123456', 'Сохранить']];
  const merges = [{s:{r:1,c:0},e:{r:2,c:0}}, {s:{r:1,c:1},e:{r:2,c:1}}, {s:{r:1,c:2},e:{r:1,c:3}}, {s:{r:1,c:4},e:{r:2,c:4}}];
  const parsed = parseMatrix(rows, { merges });
  assert.equal(parsed.records[0].fields.meter, '00123456');
  assert.equal(parsed.records[0].fields.account, '00001001');
  assert.equal(parsed.records[0].values[4], 'Сохранить');
});
test('real XLSX decoding preserves padded and long numeric identifiers', () => {
  const ws = XLSX.utils.aoa_to_sheet([['ЛС','Номер счетчика'], [123456789012, 12345]]);
  ws.B2.z = '00000000'; delete ws.B2.w;
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, ws, 'Реестр');
  const decoded = XLSX.read(XLSX.write(book, {type:'buffer',bookType:'xlsx'}), {type:'buffer',cellNF:true});
  const sheet = decoded.Sheets['Реестр'];
  const matrix = XLSX.utils.sheet_to_json(sheet, {header:1,raw:false,defval:''});
  restoreNumericIdentifiers(matrix, sheet, detectLayout(matrix));
  const r = parseMatrix(matrix).records[0];
  assert.equal(r.fields.account, '123456789012'); assert.equal(r.fields.meter, '00012345');
});
test('reject rounded numeric IDs instead of fabricating original values', () => {
  const ws = XLSX.utils.aoa_to_sheet([['ЛС','Номер счетчика'], [1234567890123456, 'ABC']]);
  const matrix = XLSX.utils.sheet_to_json(ws, {header:1,raw:false});
  assert.throws(() => restoreNumericIdentifiers(matrix, ws, detectLayout(matrix)), /Excel мог округлить/);
});
test('schema correction, empty rows, repeated headers, and zero are handled', () => {
  const rows = [['ЛС','Номер ПУ','Заметка'], ['a','b','0'], [], ['ЛС','Номер ПУ','Заметка'], ['c','d',0]];
  const parsed = parseMatrix(rows, {overrides:{meter:0,account:1}});
  assert.equal(parsed.records.length, 2); assert.equal(parsed.records[0].fields.meter, 'a'); assert.equal(parsed.records[1].values[2], '0');
});
test('25,000 rows across sheets are indexed and paginated correctly', () => {
  const extras = Array.from({length:42},(_,i)=>`Поле ${i+4}`);
  const rows = [['ЛС','Номер счетчика','ФИО',...extras], ...Array.from({length:25000},(_,i)=>[String(100000+i),String(i).padStart(8,'0'),'Пример',...extras.map((_,j)=>j%2?'':'Значение')])];
  const start = performance.now();
  const a = parseMatrix(rows,{sheet:'А'}), b = parseMatrix([rows[0],rows[1]],{sheet:'Б'});
  const index = buildIndex([a,b]);
  const result = search(index,{query:'00024999'});
  assert.equal(result.records[0].fields.account,'124999');
  assert.equal(search(index,{query:'00000000'}).total,2);
  const page = search(index,{query:'000',partial:true,offset:30,limit:30});
  assert.equal(page.records.length,30);
  console.log(`25,001 rows: parse + index + exact lookup ${(performance.now()-start).toFixed(1)} ms (Node, not phone benchmark)`);
});
