import test from 'node:test';
import assert from 'node:assert/strict';
import { newestRegistry, isConsumptionFile } from '../public/source.js';
test('folder opens the latest registry, excluding Excel lock files and other formats', () => {
  const items = [
    {type:'file',name:'old.xlsx',modified:'2026-09-28T00:00:00Z'},
    {type:'file',name:'~$latest.xlsx',modified:'2026-09-30T12:00:00Z'},
    {type:'file',name:'photo.png',modified:'2026-09-30T12:00:00Z'},
    {type:'dir',name:'archive.xlsx',modified:'2026-09-30T12:00:00Z'},
    {type:'file',name:'new.XLSX',modified:'2026-09-30T00:00:00Z'},
  ];
  assert.equal(newestRegistry(items).name,'new.XLSX');
  assert.equal(newestRegistry([]),null);
  assert.equal(items[0].name,'old.xlsx');
});
test('consumption is reserved even when newer than the subscriber registry', () => {
  const registry = {type:'file',name:'Расширенный список.xlsx',modified:'2026-09-01T00:00:00Z'};
  for (const name of ['потребление.xlsx', 'ПОТРЕБЛЕНИЕ.XLS', ' Потребление .xlsm', 'Потребление_сентябрь_2026.xlsx', '2026-09 Потребление.csv']) {
    const consumption = {type:'file',name,modified:'2026-09-30T00:00:00Z'};
    assert.equal(isConsumptionFile(name),true);
    assert.equal(newestRegistry([consumption,registry]),registry);
    assert.equal(newestRegistry([registry,consumption]),registry);
    assert.equal(newestRegistry([consumption]),null);
  }
  assert.equal(newestRegistry([registry]),registry);
  assert.equal(isConsumptionFile('Реестр абонентов.xlsx'),false);
});
