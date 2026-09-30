import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import {readMonthlyWorkbook,parseMonthlyMatrix,indexMonthly,numeric,strictSum} from '../public/monthly.js';
import {createAnalysisService} from '../public/analysis-service.js';
import {normalizeSettings} from '../public/analysis-settings.js';
import {calculateReading} from '../public/readings.js';
import {parseMatrix} from '../public/core.js';
const names=['июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь','январь','февраль','март','апрель','май'];
const months=Array.from({length:27},(_,i)=>({y:2024+Math.floor((i+5)/12),m:(i+5)%12}));
const header=['ЛС/Номер договора','№ ТУ','Наименование договора','Лицевой счет СТЕК','Номер точки учета СТЕК','ТП','Тарифная зона',...Array.from({length:27},(_,i)=>`Итого\nПО(кВт*ч)\n${names[i%12]}`),'ВСЕГО ПО(кВт*ч) за 27 месяцев'];
const sample=['909,000','926,000','937,000','892,000','918,000','875,000','898,000','874,000',...Array(19).fill(0)];
const matrix=()=>[['Полезный отпуск по всем точкам учета за Июнь 2024 г. - Август 2026 г.'],['Учебный РЭС','29.09.2026'],[],[...header],['000001','','ООО «Учебное»','009001','07001','ТП-1','Однозонный',...sample,'7 229,000']];
const row=(account,point,tp,values,alias='')=>({account,accountKey:account,alias,point,tp,values,name:'ООО «Учебное»',zone:'Однозонный',source:point});
const service=(rows,records=[])=>createAnalysisService(indexMonthly({rows,months,warnings:[]}),records);
test('report title supplies all 27 years/months; totals are not monthly values',()=>{
  const p=parseMonthlyMatrix(matrix());assert.deepEqual(p.months,months);assert.equal(p.rows[0].values.length,27);assert.equal(p.rows[0].values.reduce((s,v)=>s+v),7229);assert.equal(p.rows[0].account,'000001');assert.equal(p.rows[0].values[26],0);
  const a=matrix();a[4][8]='';const q=parseMonthlyMatrix(a);assert.equal(q.rows[0].values[1],null);
  assert.equal(numeric('1\u00a0234,56'),1234.56);assert.equal(numeric(''),null);assert.equal(numeric('—'),null);
});
test('do not guess a year or silently accept missing months',()=>{
  const a=matrix();a[0]=['Отчёт'];assert.throws(()=>parseMonthlyMatrix(a),/нет года/);
  const b=matrix();b[3][8]='Итого ПО сентябрь';assert.throws(()=>parseMonthlyMatrix(b),/не совпадают/);
  const c=matrix();c[0][0]=c[0][0].replace('Август','Июль');assert.throws(()=>parseMonthlyMatrix(c),/Количество/);
});
for(const bookType of ['biff8','xlsx']) test(`real ${bookType} decoding: exact account padding, numbers, zeroes and blanks`,()=>{
  const ws=XLSX.utils.aoa_to_sheet(matrix());ws.A5={t:'n',v:1,z:'000000'};const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,ws,'ПО');
  const p=readMonthlyWorkbook(XLSX.write(book,{type:'buffer',bookType}),XLSX);assert.equal(p.rows[0].account,'000001');assert.equal(p.rows[0].values[0],909);assert.equal(p.rows[0].values[26],0);
});
test('same-TU input rows stay additive even with equal values and equal tariff zones',()=>{
  const a=row('001','P1','ТП-1',Array(27).fill(10));
  const p=indexMonthly({months,rows:[a,{...a,alias:'009'},{...a,values:Array(27).fill(20)},{...a,zone:'Ночная'}],warnings:[]});
  assert.equal(p.rows.length,4);assert.deepEqual(strictSum(p.accounts.get('001'),27),Array(27).fill(50));
  assert.equal(p.aliases.get('009').has('001'),true);assert.deepEqual(p.warnings,[]);
});
test('LS aggregates points exactly once; TP isolates its portion and never multiplies by TT',()=>{
  const a=row('001','P1','ТП-1',Array(27).fill(100),'009'),b=row('001','P2','ТП-2',Array(27).fill(50)),c=row('002','P3','ТП-1',Array(27).fill(20));
  const records=[{fields:{account:'001',point:'P1',meter:'M1',tp:'ТП-1',power:'10',transformerRatio:'60'}},{fields:{account:'001',point:'P2',meter:'M2',tp:'ТП-2',power:'20'}},{fields:{account:'001',point:'P1',meter:'M1',tp:'ТП-1',power:'10'}}];
  const s=service([a,b,c],records);assert.equal(s.consumer('009',{}).result.total,4050);assert.equal(s.consumer('001',{}).result.meter.power,30);assert.equal(s.contour('ТП-1',{}).total,3240);assert.equal(s.contour('ТП-1',{}).meterCount,1);assert.equal(s.consumer('001',{},'ТП-1').result.total,2700);assert.equal(s.contour('ТП-1',{}).incoming.values,null);
});
test('individual flags and scores never change when other consumers change',()=>{
  const own=row('001','P1','ТП-1',sample.map(numeric));
  const others=Array.from({length:10},(_,i)=>row('A'+i,'Q'+i,'ТП-1',Array(27).fill(900+i)));
  const single=service([own]).consumer('001',{}).result, grouped=service([own,...others]).consumer('001',{}).result;
  assert.deepEqual(single.flags,grouped.flags);assert.equal(single.score,grouped.score);assert.ok(!single.flags.some(f=>['S5','S8','S9','S11'].includes(f.code)));
  const contour=service([own,...others]).consumer('001',{},'ТП-1').result;assert.ok(contour.flags.some(f=>f.code==='S5'));
});
test('missing data remains unknown, genuine zero is a distinct class, alias conflicts block matching',()=>{
  assert.deepEqual(strictSum([{values:[null,0]},{values:[20,0]}],2),[null,0]);
  const s=service([row('1','P1','ТП-1',Array(27).fill(null)),row('2','P2','ТП-1',Array(27).fill(0))]);assert.equal(s.consumer('1',{}).result.cls,'unknown');assert.equal(s.consumer('2',{}).result.cls,'dead');assert.equal(s.contour('ТП-1',{}).total,null);
  assert.throws(()=>service([row('1','P1','ТП-1',sample.map(numeric),'X'),row('2','P2','ТП-1',sample.map(numeric),'X')]).consumer('X',{}),/нескольким договорам/);
});
test('settings switch off a flag and bound thresholds; no stale cached result',()=>{
  const s=service([row('1','P1','ТП-1',[...Array(12).fill(1000),...Array(15).fill(200)])]);const first=s.consumer('1',{});assert.ok(first.result.flags.some(f=>f.code==='S3'));
  const changed=s.consumer('1',{algOff:{step:true}});assert.ok(!changed.result.flags.some(f=>f.code==='S3'));
  const c=normalizeSettings({red:30,amber:50,lossRed:100,lossAmber:500,levels:{step:999}});assert.equal(c.amber,25);assert.equal(c.lossAmber,100);assert.equal(c.levels.step,2);
});
test('quick reading calculation uses receipt and TT, supports decimals and reset-ready pure inputs',()=>{
  const parsed=parseMatrix([['Номер счетчика','ЛС','Прибор учета · Коэффициент трансформации','События · Показания с квитанции показания'],['001','001','60','1 620,5']]);
  const f=parsed.records[0].fields;assert.equal(calculateReading('1 700,5',f.receipt,f.transformerRatio).volume,4800);assert.equal(calculateReading('10','0','1').volume,10);
  assert.equal(calculateReading('10','20','2').negative,true);assert.throws(()=>calculateReading('','','1'),/Введите/);assert.throws(()=>calculateReading('10','','1'),/квитанции/);assert.throws(()=>calculateReading('10','5','0'),/коэффициента/);
});
test('TP comparison ignores other contours and normalizes spelling within the same TP',()=>{
 const a=row('1','P1','ТП-1',Array(27).fill(100)),b=row('1','P2','тп – 1',Array(27).fill(50));
 const outsiders=Array.from({length:10},(_,i)=>row('X'+i,'Z'+i,'ТП-2',Array(27).fill(1000+i)));
 const s=service([a,b]),t=service([a,b,...outsiders]);assert.equal(s.contour('ТП-1',{}).results.length,1);assert.equal(s.contour('ТП-1',{}).total,4050);assert.deepEqual(s.consumer('1',{},'ТП-1').result.flags,t.consumer('1',{},'ТП-1').result.flags);
});
