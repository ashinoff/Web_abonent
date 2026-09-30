import test from 'node:test';
import assert from 'node:assert/strict';
import {findRegistry,findConsumption,findIncoming,isConsumptionFile,isIncomingFile,isExcelFile,findSource} from '../public/source.js';
test('fixed XLS and XLSX sources select newest, using XLSX on ties',()=>{
  const xls={type:'file',name:'Расширенный список.xls',modified:'2026-09-01T00:00:00Z'},xlsx={...xls,name:'Расширенный список.xlsx'}, newer={...xls,modified:'2026-09-30T00:00:00Z'};
  assert.equal(findRegistry([xls,xlsx]),xlsx);assert.equal(findRegistry([xlsx,newer]),newer);
  assert.equal(findRegistry(['new.xlsx','Расширенный список (1).xls','~$Расширенный список.xls','Реестр.xls'].map(name=>({type:'file',name}))),null);
  assert.equal(findRegistry([{type:'dir',name:xls.name}]),null);
});
test('monthly aliases ignore case and select one newest workbook across both names',()=>{
  for (const name of ['ПО.xlsx','По.xls','по.XLSX','пО.XlS','ПО по месячно.xlsx','По По Месячно.XLS']) assert.equal(isConsumptionFile(name),true,name);
  for (const name of ['ПО.xlsm','ПО.csv','ПО (1).xlsx','~$ПО.xlsx','Потребление.xls']) assert.equal(isConsumptionFile(name),false,name);
  const old={type:'file',name:'ПО по месячно.xlsx',modified:'2026-09-29T00:00:00Z'}, latest={type:'file',name:'По.xls',modified:'2026-09-30T00:00:00Z'}, tie={...latest,name:'по.XLSX'};
  assert.equal(findConsumption([old,latest]),latest);
  assert.equal(findConsumption([latest,tie,old]),tie);
});
test('manual choice accepts arbitrary Excel names only from the current RES listing',()=>{
  const auto={type:'file',name:'ПО.xlsx',path:'/ЭС/РЭС/ПО.xlsx'}, manual={type:'file',name:'Отпуск за месяц.XLS',path:'/ЭС/РЭС/Отпуск за месяц.XLS'};
  const choices={consumption:{path:manual.path}};
  assert.equal(findSource([auto,manual],'consumption'),auto);
  assert.equal(findSource([auto,manual],'consumption',choices),manual);
  assert.equal(findSource([auto],'consumption',choices),null);
  assert.equal(findSource([{...manual,path:'/ЭС/Другая РЭС/Отпуск за месяц.XLS'}],'consumption',choices),null);
  assert.equal(findSource([{...manual,type:'dir'}],'consumption',choices),null);
  assert.equal(findSource([{...manual,name:'Инструкция.pdf'}],'consumption',choices),null);
  assert.equal(isExcelFile('~$Отпуск.xlsx'),false);
  assert.equal(findSource([auto,manual],'unknown',choices),null);
});
test('registry, monthly and incoming books have independent exact names',()=>{
  const books=['Расширенный список.xlsx','ПО по месячно.XLS','прием.xlsx','Потребление.xls','прием (1).xls'].map(name=>({type:'file',name}));
  assert.equal(findRegistry(books),books[0]);assert.equal(findConsumption(books),books[1]);assert.equal(findIncoming(books),books[2]);
  assert.equal(isConsumptionFile('ПО ПО МЕСЯЧНО.XLSX'),true);assert.equal(isIncomingFile('ПРИЁМ.xls'),true);
  assert.equal(findConsumption([books[0],books[3]]),null);assert.equal(findIncoming([{type:'dir',name:'прием.xls'}]),null);
});
