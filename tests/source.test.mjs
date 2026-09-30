import test from 'node:test';
import assert from 'node:assert/strict';
import { findRegistry, findConsumption, isConsumptionFile } from '../public/source.js';
test('only the fixed XLS registry is selected, regardless of newer unrelated files', () => {
  const registry = {type:'file',name:'Расширенный список.xls',modified:'2026-09-01T00:00:00Z'};
  const others = ['new.xlsx','Расширенный список.xlsx','Расширенный список (1).xls','~$Расширенный список.xls','Реестр.xls','Потребление.xls'].map(name=>({type:'file',name,modified:'2026-09-30T00:00:00Z'}));
  assert.equal(findRegistry([...others,registry]),registry);
  assert.equal(findRegistry(others),null);
  assert.equal(findRegistry([{type:'dir',name:registry.name}]),null);
  assert.equal(findRegistry([{type:'file',name:'РАСШИРЕННЫЙ СПИСОК.XLS'}]).name,'РАСШИРЕННЫЙ СПИСОК.XLS');
  assert.equal(findRegistry([]),null);
});
test('monthly consumption uses only its fixed XLS name, separately from the registry', () => {
  const registry = { type:'file', name:'Расширенный список.xls' };
  const monthly = { type:'file', name:'По по месячно.xls' };
  const ignored = ['Потребление.xls', 'По по месячно.xlsx', 'По по месячно (1).xls', '~$По по месячно.xls', 'По по месячно.pdf'].map(name => ({ type:'file', name }));
  assert.equal(findConsumption([...ignored, registry, monthly]), monthly);
  assert.equal(findConsumption(ignored), null);
  assert.equal(findConsumption([{ type:'dir', name:monthly.name }]), null);
  assert.equal(findConsumption([]), null);
  assert.equal(isConsumptionFile('ПО ПО МЕСЯЧНО.XLS'), true);
  assert.equal(findRegistry([monthly, ...ignored, registry]), registry);
  assert.equal(findRegistry([monthly]), null);
});
