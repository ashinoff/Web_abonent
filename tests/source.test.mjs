import test from 'node:test';
import assert from 'node:assert/strict';
import {findRegistry,findConsumption,findIncoming,isConsumptionFile,isIncomingFile} from '../public/source.js';
test('fixed XLS and XLSX sources select newest, using XLSX on ties',()=>{
  const xls={type:'file',name:'Расширенный список.xls',modified:'2026-09-01T00:00:00Z'},xlsx={...xls,name:'Расширенный список.xlsx'}, newer={...xls,modified:'2026-09-30T00:00:00Z'};
  assert.equal(findRegistry([xls,xlsx]),xlsx);assert.equal(findRegistry([xlsx,newer]),newer);
  assert.equal(findRegistry(['new.xlsx','Расширенный список (1).xls','~$Расширенный список.xls','Реестр.xls'].map(name=>({type:'file',name}))),null);
  assert.equal(findRegistry([{type:'dir',name:xls.name}]),null);
});
test('registry, monthly and incoming books have independent exact names',()=>{
  const books=['Расширенный список.xlsx','ПО по месячно.XLS','прием.xlsx','Потребление.xls','прием (1).xls'].map(name=>({type:'file',name}));
  assert.equal(findRegistry(books),books[0]);assert.equal(findConsumption(books),books[1]);assert.equal(findIncoming(books),books[2]);
  assert.equal(isConsumptionFile('ПО ПО МЕСЯЧНО.XLSX'),true);assert.equal(isIncomingFile('ПРИЁМ.xls'),true);
  assert.equal(findConsumption([books[0],books[3]]),null);assert.equal(findIncoming([{type:'dir',name:'прием.xls'}]),null);
});
