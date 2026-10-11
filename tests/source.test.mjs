import test from 'node:test';
import assert from 'node:assert/strict';
import {findRegistry,findConsumption,findIncoming,findInstant,findEvents,isConsumptionFile,isIncomingFile,isInstantFile,isEventsFile,isExcelFile,findSource} from '../public/source.js';
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

test('optional journals recognise export numbers and titles while selecting one latest file',()=>{
  for (const name of ['31. журнал.xlsx','31 мгновенные значения.XLS','31_2026-10-11.xlsx','31-замеры.xls','31.xlsx','Мгновенные значения.xlsx','мгновенные значения (1).XLS']) assert.equal(isInstantFile(name),true,name);
  for (const name of ['46. События.xlsx','46 события.XLS','46_2026-10-11.xlsx','46-журнал.xls','46.xlsx','События по точкам учёта.xlsx','СОБЫТИЯ ПО ТОЧКАМ УЧЕТА (1).XLS']) assert.equal(isEventsFile(name),true,name);
  for (const name of ['310. данные.xlsx','31.xlsm','~$31. журнал.xlsx','46. журнал.xlsx','ПО.xlsx']) assert.equal(isInstantFile(name),false,name);
  for (const name of ['460. данные.xlsx','46.xlsm','~$46. журнал.xlsx','31. журнал.xlsx','ПО.xlsx']) assert.equal(isEventsFile(name),false,name);
  const old={type:'file',name:'31. прошлый.xlsx',path:'/ЭС/РЭС/31. прошлый.xlsx',modified:'2026-10-01'}, recent={...old,name:'Мгновенные значения.xls',path:'/ЭС/РЭС/Мгновенные значения.xls',modified:'2026-10-11'}, tie={...recent,name:'31. новый.xlsx',path:'/ЭС/РЭС/31. новый.xlsx'};
  assert.equal(findInstant([old,recent]),recent); assert.equal(findInstant([old,recent,tie]),tie);
  const event={...recent,name:'46. события.xlsx',path:'/ЭС/РЭС/46. события.xlsx'};
  assert.equal(findEvents([old,event]),event);assert.equal(findSource([old,event],'events'),event);
  assert.equal(findSource([old,event],'instant',{instant:{path:event.path}}),event);
  assert.equal(findSource([old],'events',{events:{path:event.path}}),null);
  assert.equal(findEvents([{...event,type:'dir'}]),null);
});
