import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRecordFields, recordSection } from '../public/record-sections.js';

test('real registry headers retain all fields, values and empty cells in semantic sections', () => {
  const labels = ['№ п/п', 'ТУ', 'Номер ТУСТЕК', 'Номер ТУ', 'ЛС / ЛС СТЕК', 'Наименование договора',
    'Основные реквизиты · Состояние ТУ', 'Основные реквизиты · Субабонент',
    ...['Населенный пункт','Улица','Дом','Телефон','Корпус','Квартира'].map(x=>'Адрес точки учета · '+x),
    ...['Подстанция','Фидер10','ТП','Максимальная мощность','Опора 10Кв'].map(x=>'Подключение · '+x),
    ...['Вид счетчика','Номер счетчика','Коэффициент трансформации'].map(x=>'Прибор учета · '+x),
    ...['Показания с квитанции показания','Проверка схемы дата'].map(x=>'События · '+x),
    'Рассчитанные величины · Итоговый ПО',
    ...['А','В','С'].flatMap(phase=>['Тип ТТ','Заводской номер ТТ','Госповерка ТТ','Межповерочный интервал ТТ','Окончание срок поверки ТТ'].map(x=>`Характеристики ТТ · ${x} (${phase})`)),
    ...['Тип ТН','Заводской номер ТН','Госповерка ТН','Межповерочный интервал ТН','Окончание срок поверки ТН'].map(x=>'Характеристики ТН · '+x),
    'Дополнительно · Неизвестное поле'];
  const values = labels.map((_,i)=>i%4===0?'':i===1?0:`Значение ${i}`);
  const groups = groupRecordFields(labels, values);
  const fields = groups.flatMap(g=>g.fields).sort((a,b)=>a.index-b.index);
  assert.equal(fields.length,labels.length);
  assert.deepEqual(fields.map(f=>f.label),labels);
  assert.deepEqual(fields.map(f=>f.value),values.map(String));
  assert.equal(groups.find(g=>g.key==='tt').fields.length,15);
  assert.equal(groups.find(g=>g.key==='tn').fields.length,5);
  assert.equal(groups.find(g=>g.key==='connection').fields.length,5);
  assert.equal(groups.find(g=>g.key==='other').fields[0].displayLabel,'Дополнительно · Неизвестное поле');
  assert.equal(groups.find(g=>g.key==='meter').fields[2].displayLabel,'Коэффициент трансформации');
});
test('flat headers and headers using ё have the same grouping', () => {
  for (const [label,key] of [['Лицевой счёт','account'],['Номер ТУ','point'],['Телефон','address'],['Фидер10','connection'],['Прибор учёта · Коэффициент трансформации','meter'],['Номер счётчика','meter'],['Госповерка ТТ (А)','tt'],['Тип ТН','tn'],['Итоговый ПО','calculated']]) assert.equal(recordSection(label),key);
});
