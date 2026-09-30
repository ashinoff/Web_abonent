import test from 'node:test';
import assert from 'node:assert/strict';
import { findRegistry, newestConsumption, isConsumptionFile } from '../public/source.js';
test('only the fixed XLS registry is selected, regardless of newer unrelated files', () => {
  const registry = {type:'file',name:'Расширенный список.xls',modified:'2026-09-01T00:00:00Z'};
  const others = ['new.xlsx','Расширенный список.xlsx','Расширенный список (1).xls','~$Расширенный список.xls','Реестр.xls','Потребление.xls'].map(name=>({type:'file',name,modified:'2026-09-30T00:00:00Z'}));
  assert.equal(findRegistry([...others,registry]),registry);
  assert.equal(findRegistry(others),null);
  assert.equal(findRegistry([{type:'dir',name:registry.name}]),null);
  assert.equal(findRegistry([{type:'file',name:'РАСШИРЕННЫЙ СПИСОК.XLS'}]).name,'РАСШИРЕННЫЙ СПИСОК.XLS');
  assert.equal(findRegistry([]),null);
});
test('consumption is reserved even when newer than the subscriber registry', () => {
  const registry = {type:'file',name:'Расширенный список.xls',modified:'2026-09-01T00:00:00Z'};
  for (const name of ['потребление.xlsx', 'ПОТРЕБЛЕНИЕ.XLS', ' Потребление .xlsm', 'Потребление_сентябрь_2026.xlsx', '2026-09 Потребление.csv']) {
    const consumption = {type:'file',name,modified:'2026-09-30T00:00:00Z'};
    assert.equal(isConsumptionFile(name),true);
    assert.equal(findRegistry([consumption,registry]),registry);
    assert.equal(findRegistry([registry,consumption]),registry);
    assert.equal(findRegistry([consumption]),null);
  }
  assert.equal(findRegistry([registry]),registry);
  assert.equal(isConsumptionFile('Реестр абонентов.xlsx'),false);
});
test('consumption discovery uses only actual workbooks in the current enterprise', () => {
  const consumption = {type:'file',name:'Потребление сентябрь.XLSX',modified:'2026-09-30T00:00:00Z'};
  const registry = {type:'file',name:'Расширенный список.xls',modified:'2026-09-29T00:00:00Z'};
  const items = [registry, consumption,
    {type:'file',name:'~$Потребление.xlsx',modified:'2026-10-01T00:00:00Z'},
    {type:'file',name:'Потребление.pdf',modified:'2026-10-01T00:00:00Z'},
    {type:'dir',name:'Потребление.xlsx',modified:'2026-10-01T00:00:00Z'},
    {type:'file',name:'Потребление август.xlsx',modified:'2026-08-31T00:00:00Z'}];
  assert.equal(newestConsumption(items),consumption);
  assert.equal(findRegistry(items),registry);
  assert.equal(newestConsumption([registry]),null);
  assert.equal(newestConsumption([]),null);
});
