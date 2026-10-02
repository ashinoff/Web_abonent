import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMatrix, buildIndex, listNotes } from '../public/core.js';

const header = ['ЛС', 'Номер ПУ', 'ТУ', 'ТП', 'Примечание'];
test('notes count nonblank source cells across sheets, including repeated IDs and missing meters', () => {
  const a = parseMatrix([header, ['001','0001','Ввод 1','ТП-1','Проверить'], ['001','0001','Ввод 2','ТП-2','Проверить'], ['002','0002','Квартира','',' \u00a0 ']], { sheet: 'А' });
  const b = parseMatrix([header, ['003','','Дом','','Связаться с потребителем']], { sheet: 'Б' });
  const index = buildIndex([a,b]);
  assert.equal(index.hasNotesColumn, true); assert.equal(index.notes.length, 3);
  assert.deepEqual(listNotes(index).notes.map(n => [n.id,n.fields.pointName]), [['А:2','Ввод 1'],['А:3','Ввод 2'],['Б:2','Дом']]);
  assert.equal(listNotes(index,{query:'тп-2'}).total,1);
  assert.equal(listNotes(index,{query:'СВЯЗАТЬСЯ'}).notes[0].fields.account,'003');
  assert.equal(listNotes(index,{query:'нет совпадений'}).total,0);
  assert.equal(buildIndex([parseMatrix([['ЛС','Номер ПУ'],['1','2']])]).hasNotesColumn,false);
  assert.equal(buildIndex([parseMatrix([header,['1','2','','','']])]).notes.length,0);
});
test('merged header and repeated note columns retain every populated note, including zero', () => {
  const merged = parseMatrix([
    ['ЛС','Прибор учета','','Основные реквизиты'],
    ['','Номер ПУ','Тип счетчика','Примечание'],
    ['001','0001','РиМ','Проверить ТТ'],
  ], { merges:[{s:{r:0,c:0},e:{r:1,c:0}},{s:{r:0,c:1},e:{r:0,c:2}}] });
  assert.equal(listNotes(buildIndex([merged])).notes[0].note,'Проверить ТТ');
  const repeated = parseMatrix([['ЛС','Номер ПУ','Примечание','Примечание'], ['1','2',0,'<b>текст</b>']]);
  assert.deepEqual(listNotes(buildIndex([repeated])).notes.map(n=>n.note),['0','<b>текст</b>']);
});
test('notes filter searches the full registry before pagination', () => {
  const rows = [header,...Array.from({length:205},(_,i)=>['001',String(i),`Точка ${i}`,'ТП-1',`Заметка ${i}`])];
  const index = buildIndex([parseMatrix(rows)]);
  assert.equal(listNotes(index).notes.length,100);
  assert.equal(listNotes(index,{offset:200}).notes.length,5);
  assert.equal(listNotes(index,{query:'Заметка 204'}).notes[0].fields.meter,'204');
  assert.equal(listNotes(index,{query:'Заметка 204'}).totalInRegistry,205);
});
