import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { readJournalWorkbook, eventKind, eventKinds, serialKey, parseJournalTimestamp, INSTANT_FIELDS, INSTANT_METRICS, createEventAggregator, normalizeEventPack, EVENTS_PACKAGE_VERSION, eventClassification, detectEventHeader } from '../public/journals.js';

const eventHeaders=['ТУ','Тип ПУ','Серийный','Абонент','Лимит','Дата и время','Тип','Событие','Инициатор','Дополнительная информация'];
const instantHeaders=['Точка учета','Время',
  'минимальная мощность (A+)(КВт) из профиля энергии 30/60 минут','средняя мощность (A+)(КВт) из профиля энергии 30/60 минут','максимальная мощность (A+)(КВт) из профиля энергии 30/60 минут',
  'минимальная мощность (A-)(КВт) из профиля энергии 30/60 минут','средняя мощность (A-)(КВт) из профиля энергии 30/60 минут','максимальная мощность (A-)(КВт) из профиля энергии 30/60 минут',
  '(R+)(КВар) мин','(R+)(КВар) среднее','(R+)(КВар) макс','(R-)(КВар) мин','(R-)(КВар) среднее','(R-)(КВар) макс',
  'Активная мощность по сумме фаз (КВт)',...[1,2,3].map(p=>'Активная мощность по фазе '+p+' (КВт)'),
  'Реактивная мощность по сумме фаз (КВар)',...[1,2,3].map(p=>'Реактивная мощность по фазе '+p+' (КВар)'),
  'Полная мощность по сумме фаз (КВА)',...[1,2,3].map(p=>'Полная мощность по фазе '+p+' (КВА)'),
  ...[1,2,3].map(p=>'Напряжение на фазе '+p+' (В)'),...[1,2,3].map(p=>'Ток в фазе '+p+' (А)'), 'Ток в нулевом проводе (А)','Общий коэффициент мощности',
  ...[1,2,3].map(p=>'Коэффициент мощности по фазе '+p+' cos(f)'), 'Частота',
  ...[1,2,3].map(p=>'Коэффициент искажения синусоидальности кривой фазного напряжения (Ku) по фазе'+p),
  ...[1,2,3].map(p=>'Коэффициент реактивной мощности tg(f), фаза '+p),...['A','B','C'].map(p=>'Угол между векторами U I, фазы '+p+', град'), 'Температура (С)', 'GUID Прибора учета', ''];
function excel(sheets,bookType='xlsx') {
  const book=XLSX.utils.book_new();
  for(const [name,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  return XLSX.write(book,{type:'buffer',bookType});
}
const row = (serial,at,metrics={}) => [`Область\\Улица\\Кадастр 23:01:1234567:8901\\ПУ Тест-300, №${serial}`,at,...INSTANT_FIELDS.map(k=>metrics[k]??null),'private-guid-not-stored',1];
const instant = (rows,bookType='xlsx') => excel({'Лист1':[
  ['Мгновенные значения за период'],['с 01.08.2026 по 01.09.2026'],['без учета коэффициентов трансформации'],instantHeaders,...rows,
]},bookType);
const event = (serial,at,details) => ['private-point','private-model',serial,'private-name','private-limit',at,'private-type','private-event','private-author',details];

for(const bookType of ['xlsx','biff8']) test(`${bookType}: journal46 retains C/F/J evidence in compact monthly groups and counts raw duplicate registrations`,()=>{
  const text='Вскрытый элемент устройства "Клеммная крышка"\nПолное исходное пояснение';
  const pack=readJournalWorkbook(excel({'Лист1':[['События за период'],eventHeaders,event('000123','06.03.2026 12:55:33',text),event('000123','06.03.2026 12:55:33',text),event('000123','06.03.2026 12:55:34','Неизвестный исходный текст')]},bookType),XLSX,'events');
  assert.equal(pack.rows,undefined);assert.equal(pack.aggregationVersion,EVENTS_PACKAGE_VERSION);assert.equal(pack.groups.length,2);
  const opening=pack.groups.find(g=>g.codes.length),other=pack.groups.find(g=>!g.codes.length);
  assert.equal(opening.serial,'000123');assert.equal(opening.count,2);assert.equal(opening.examples[0].at,'2026-03-06T12:55:33');assert.equal(opening.examples[0].description,text);
  assert.equal(other.first,'2026-03-06T12:55:34');assert.equal(other.examples[0].description,'Неизвестный исходный текст');
  assert.equal(pack.stats.rows,3);assert.equal(pack.stats.accepted,3);assert.equal(pack.stats.repeatedRows,1);
  assert.ok(!JSON.stringify(pack).includes('private-'));
});

test('strict local dates reject impossible/ambiguous/timezoned values and preserve Excel date serials',()=>{
  assert.equal(parseJournalTimestamp('31.08.2026 15:15'),'2026-08-31T15:15:00');
  assert.equal(parseJournalTimestamp('29.02.2024'),'2024-02-29T00:00:00');
  assert.equal(parseJournalTimestamp('2026-01-01T00:00:00'),'2026-01-01T00:00:00');
  assert.equal(parseJournalTimestamp(1,XLSX,true),'1904-01-02T00:00:00');
  for(const value of ['29.02.2026','31.04.2026 10:10','06/03/2026','01.01.2026 24:00','2026-01-01T00:00:00Z','2026-01-01T00:00:00+03:00'])assert.equal(parseJournalTimestamp(value),null);
});

test('events with invalid date are skipped and identities keep explicit leading zeros',()=>{
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([eventHeaders,event(123,'01.01.2026','Вскрытый элемент устройства "Корпус"'),event('000123','31.02.2026','Недостоверная дата'),event(1234567890123456,'01.01.2026','Потерянный номер')]);
  sheet.C2.z='000000';XLSX.utils.book_append_sheet(book,sheet,'Лист1');
  const pack=readJournalWorkbook(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),XLSX,'events');
  assert.equal(pack.groups[0].serial,'000123');assert.equal(pack.stats.invalidDates,1);assert.equal(pack.stats.invalidSerials,1);assert.equal(pack.stats.skipped,2);
  assert.equal(serialKey(' 00 A 12 '),'00a12');assert.notEqual(serialKey('00123'),serialKey('123'));
});

test('event classifier handles all six requested elements and excludes restoration/closure',()=>{
  const cases=[['Клеммная крышка','J46_TERMINAL_COVER'],['Клеммная колодка','J46_TERMINAL_BLOCK'],['Электронная пломба','J46_ELECTRONIC_SEAL'],['Корпус','J46_CASE'],['Магнитная пломба переменного поля','J46_MAGNET_AC'],['Магнитная пломба постоянного поля','J46_MAGNET_DC']];
  for(const [element,code]of cases){const kind=eventKind('Вскрытый элемент устройства "'+element+'"');assert.equal(kind.code,code);assert.ok(kind.recommendation);}
  assert.equal(eventKind('Закрытие клеммной крышки'),null);assert.equal(eventKind('Корпус не вскрыт'),null);assert.equal(eventKind('Восстановлена магнитная пломба'),null);assert.equal(eventKind('Неизвестное событие'),null);
  for(const description of ['Магнитное поле отсутствует','Магнитное воздействие не обнаружено','Магнитное поле','Магнитное воздействие'])assert.equal(eventKind(description),null);
  assert.equal(eventKind('Обнаружено магнитное поле').code,'J46_MAGNETIC');
});

test('compound additional information retains distinct active categories and evaluates explicit clauses separately',()=>{
  const opening='Вскрытый элемент устройства "Клеммная крышка"';
  const magnetic='Вскрытый элемент устройства "Магнитная пломба постоянного поля"';
  assert.deepEqual(eventKinds(opening+'\n'+magnetic).map(k=>k.code),['J46_TERMINAL_COVER','J46_MAGNET_DC']);
  assert.deepEqual(eventKinds('Закрытие корпуса; '+opening).map(k=>k.code),['J46_TERMINAL_COVER']);
  assert.deepEqual(eventKinds('Сброс магнитной пломбы<br>'+opening).map(k=>k.code),['J46_TERMINAL_COVER']);
  assert.deepEqual(eventKinds(opening+'; '+opening).map(k=>k.code),['J46_TERMINAL_COVER']);
  assert.deepEqual(eventKinds('Вскрытые элементы устройства "Клеммная крышка", "Клеммная колодка", "Магнитная пломба переменного поля"').map(k=>k.code),['J46_MAGNET_AC','J46_TERMINAL_COVER','J46_TERMINAL_BLOCK']);
  assert.deepEqual(eventKinds('Корпус\nМагнитная пломба постоянного поля'),[]);
  assert.deepEqual(eventKinds('Обнаружено магнитное поле возле корпуса').map(k=>k.code),['J46_MAGNETIC']);
  assert.equal(eventKind(opening+'\n'+magnetic).code,'J46_TERMINAL_COVER');
  const details=opening+'\n'+magnetic;
  const pack=readJournalWorkbook(excel({'Лист1':[eventHeaders,event('000123','01.08.2026',details)]}),XLSX,'events');
  assert.equal(pack.groups.length,1);assert.equal(pack.groups[0].examples[0].description,details);assert.deepEqual(pack.groups[0].codes,['J46_MAGNET_DC','J46_TERMINAL_COVER']);
});

for(const bookType of ['xlsx','biff8']) test(`${bookType}: journal31 finds explicit final meter token and maps all 46 metrics without GUID/path storage`,()=>{
  const values=Object.fromEntries(INSTANT_FIELDS.map((k,i)=>[k,i+0.125]));
  const pack=readJournalWorkbook(instant([row('000123','31.08.2026 15:15',values)],bookType),XLSX,'instant');
  assert.equal(INSTANT_FIELDS.length,46);assert.equal(INSTANT_METRICS.length,46);
  assert.deepEqual(pack.meters[0].latest.values,INSTANT_FIELDS.map((k,i)=>i+0.125));
  assert.equal(pack.meters[0].serial,'000123');assert.equal(pack.meters[0].latest.at,'2026-08-31T15:15:00');
  assert.deepEqual(pack.reportPeriod,{from:'2026-08-01',to:'2026-09-01'});assert.equal(pack.coefficientMode,'unscaled');
  assert.ok(!JSON.stringify(pack).includes('private-guid'));assert.ok(!JSON.stringify(pack).includes('Кадастр'));assert.ok(!JSON.stringify(pack).includes('Улица'));
});

test('journal31 compacts multiple samples into latest parameters and monthly signal counters',()=>{
  const reverse={active1:-1,apparent1:1.1,current1:5,voltage1:230};
  const pack=readJournalWorkbook(instant([row('000123','02.08.2026 10:00',reverse),row('000123','01.08.2026 10:00',reverse),row('000123','03.09.2026 10:00',reverse),row('000123','04.09.2026 10:00',{active1:1})]),XLSX,'instant');
  const m=pack.meters[0],flag=m.signals.find(s=>s.code==='J31_REVERSE');
  assert.equal(pack.meters.length,1);assert.equal(m.samples,4);assert.equal(m.datedSamples,4);assert.equal(m.first,'2026-08-01T10:00:00');assert.equal(m.last,'2026-09-04T10:00:00');
  assert.equal(m.latest.at,'2026-09-04T10:00:00');assert.equal(flag.count,3);assert.equal(flag.months.length,2);assert.equal(flag.months[0].count,2);assert.equal(flag.months[0].first,'2026-08-01T10:00:00');
  assert.equal(flag.months[1].month,'2026-09');assert.match(flag.recommendation,/генераци/);
});

test('reactive profile headers with added profile suffix retain all twelve summary parameters',()=>{
  const h=[...instantHeaders];for(let c=8;c<=13;c++)h[c]+=' из профиля энергии 30/60 минут';
  const values=Object.fromEntries(INSTANT_FIELDS.slice(0,12).map((key,i)=>[key,i+0.25]));
  const pack=readJournalWorkbook(excel({'Лист1':[h,row('000123','31.08.2026',values)]}),XLSX,'instant');
  assert.deepEqual(pack.meters[0].latest.values.slice(0,12),INSTANT_FIELDS.slice(0,12).map((key,i)=>i+0.25));
});

test('missing instant timestamp retains evidence without assigning report window date',()=>{
  const pack=readJournalWorkbook(instant([row('000123','bad time',{active1:-1,current1:5})]),XLSX,'instant'),m=pack.meters[0];
  assert.equal(m.latest.at,null);assert.equal(m.datedSamples,0);assert.equal(m.signals[0].first,null);assert.deepEqual(m.signals[0].months,[]);assert.equal(pack.stats.invalidDates,1);
  assert.ok(pack.warnings.some(w=>w.includes('не привязаны')));
});

test('serial-only future layout supported and missing serial never guessed from model/cadastral number',()=>{
  const headers=['Серийный','Время','Активная мощность по фазе 1 (КВт)','Ток в фазе 1 (А)'];
  const pack=readJournalWorkbook(excel({'Лист1':[headers,['000123','01.08.2026',-1,5]]}),XLSX,'instant');
  assert.equal(pack.meters[0].serial,'000123');
  assert.ok(pack.warnings.some(w=>w.includes('не представлены столбцы')&&w.includes('не означает нулевое')));
  const bad=row('000123','01.08.2026',{active1:1});bad[0]='Кадастр 23:01:1234567:8901\\ПУ Тест-300';
  const mixed=readJournalWorkbook(instant([bad,row('000123','01.08.2026',{active1:1})]),XLSX,'instant');
  assert.equal(mixed.stats.invalidSerials,1);assert.equal(mixed.meters.length,1);
});

test('normal phase imbalance and neutral larger than one phase are informational, not under-registration evidence',()=>{
  const normal={voltage1:220,voltage2:220,voltage3:220,current1:2,current2:1,current3:0.04,neutralCurrent:2.2,active1:0.4,active2:0.2,active3:0.005};
  const flags=readJournalWorkbook(instant([row('000123','31.08.2026',normal)]),XLSX,'instant').meters[0].signals;
  assert.deepEqual(flags.map(s=>s.code),['J31_UNBALANCE']);assert.equal(flags[0].informational,true);
  const single={voltage1:230,voltage2:0,voltage3:0,current1:5,current2:0,current3:0,active1:1.1};
  assert.deepEqual(readJournalWorkbook(instant([row('000123','31.08.2026',single)]),XLSX,'instant').meters[0].signals,[]);
});

test('conservative wiring consistency flags require loaded phases and retain concrete values',()=>{
  const data={voltage1:0,voltage2:230,voltage3:230,current1:2,current2:2,current3:2,neutralCurrent:10,active2:0,apparent2:0.46,powerFactor2:0.8,powerFactor3:0.1};
  const flags=readJournalWorkbook(instant([row('000123','31.08.2026',data)]),XLSX,'instant').meters[0].signals;
  for(const code of ['J31_PHASE','J31_NEUTRAL','J31_POWER','J31_PF']){const flag=flags.find(s=>s.code===code);assert.ok(flag,code);assert.ok(flag.detail);assert.equal(flag.months[0].month,'2026-08');}
  assert.equal(flags.find(s=>s.code==='J31_PF').informational,true);
  const small={voltage1:220,current1:0.001,active1:0,powerFactor1:0.1};
  assert.deepEqual(readJournalWorkbook(instant([row('000123','31.08.2026',small)]),XLSX,'instant').meters[0].signals,[]);
});

test('one signal is counted once when multiple phases fail in a row',()=>{
  const metrics={active1:-1,active2:-1,current1:5,current2:5};
  const flag=readJournalWorkbook(instant([row('000123','31.08.2026',metrics)]),XLSX,'instant').meters[0].signals.find(s=>s.code==='J31_REVERSE');
  assert.equal(flag.count,1);assert.match(flag.detail,/Фаза 1/);assert.match(flag.detail,/Фаза 2/);
});

test('journal headers and size limits fail explicitly, rather than silently truncating',()=>{
  assert.throws(()=>readJournalWorkbook(excel({'Лист1':[['other header'],['data']]}),XLSX,'instant'),/шапка/);
  const moved=[...eventHeaders];[moved[2],moved[3]]=[moved[3],moved[2]];
  assert.throws(()=>readJournalWorkbook(excel({'Лист1':[moved,event('001','01.01.2026','Корпус')]}),XLSX,'events'),/шапка/);
  const fake={...XLSX,read:()=>({SheetNames:['Large'],Sheets:{Large:{'!ref':'A1:J1000083','!fullref':'A1:J1100000'}}})};
  assert.throws(()=>readJournalWorkbook(new Uint8Array([0x50,0x4b]),fake,'events'),/1 000 000/);
  assert.throws(()=>readJournalWorkbook(new Uint8Array([1,2,3]),XLSX,'events'),/Excel/);
});

test('new weak missing-current observation requires three live phase voltages and real numeric current',()=>{
  const base={voltage1:230,voltage2:230,voltage3:230,current1:0.02,current2:1,current3:1};
  const find=metrics=>readJournalWorkbook(instant([row('000123','31.08.2026',metrics)]),XLSX,'instant').meters[0].signals.find(s=>s.code==='J31_MISSING_CURRENT');
  const hit=find(base);assert.ok(hit);assert.equal(hit.informational,true);assert.equal(hit.conditional,true);
  for(const override of [{current1:0.021},{current1:null},{voltage1:null},{voltage2:0},{current2:0,current3:0},{current2:0.999,current3:null}])assert.equal(find({...base,...override}),undefined);
  assert.equal(find({voltage1:230,voltage2:0,voltage3:0,current1:2,current2:0,current3:0}),undefined);
});

test('low PF and phase unbalance remain strictly informational without conditional amplification',()=>{
  const data={voltage1:230,voltage2:230,voltage3:230,current1:2,current2:1,current3:0.03,powerFactor1:0.1};
  const flags=readJournalWorkbook(instant([row('000123','31.08.2026',data)]),XLSX,'instant').meters[0].signals;
  for(const code of ['J31_PF','J31_UNBALANCE']){const f=flags.find(s=>s.code===code);assert.ok(f);assert.equal(f.informational,true);assert.equal(f.conditional,undefined);}
});

test('P/Q/S check only flags substantial impossible excess, not harmonic apparent-power surplus',()=>{
  const codes=metrics=>readJournalWorkbook(instant([row('000123','31.08.2026',metrics)]),XLSX,'instant').meters[0].signals.map(s=>s.code);
  assert.ok(codes({active1:1,apparent1:0.4}).includes('J31_VECTOR'));
  assert.ok(codes({active1:0.5,reactive1:1,apparent1:0.5}).includes('J31_VECTOR'));
  for(const metrics of [{active1:0.6,reactive1:0.8,apparent1:1},{active1:0.3,reactive1:0.4,apparent1:1},{active1:0.8,apparent1:0.7},{active1:0.1,apparent1:0.01},{active1:null,reactive1:1,apparent1:0.4},{active1:1,apparent1:null}])assert.ok(!codes(metrics).includes('J31_VECTOR'));
});

test('conditional angular diagnostics respect PF sign, harmonics and actual angle units',()=>{
  const codes=metrics=>readJournalWorkbook(instant([row('000123','31.08.2026',metrics)]),XLSX,'instant').meters[0].signals;
  const bad=codes({active1:0.8,reactive1:0.6,apparent1:1,powerFactor1:0.8,angle1:85}).find(s=>s.code==='J31_VECTOR_ANGLE');
  assert.ok(bad);assert.equal(bad.conditional,true);assert.equal(bad.informational,true);
  const angle=Math.acos(0.8)*180/Math.PI;
  for(const metrics of [{active1:0.8,reactive1:-0.6,apparent1:1,powerFactor1:-0.8,angle1:-angle},{active1:0.3,reactive1:0.4,apparent1:1,powerFactor1:1,angle1:0},{active1:0.5,apparent1:1,powerFactor1:null,angle1:80},{active1:0.1,apparent1:0.1,powerFactor1:1,angle1:80},{active1:0.8,apparent1:1,powerFactor1:1,angle1:null},{active1:0.8,apparent1:1,powerFactor1:1,angle1:1e9}])assert.ok(!codes(metrics).some(s=>s.code==='J31_VECTOR_ANGLE'));
  const genericHeaders=[...instantHeaders];genericHeaders[34]='Коэффициент мощности по фазе 1';
  const pack=readJournalWorkbook(excel({'Лист1':[genericHeaders,row('000123','31.08.2026',{active1:0.8,apparent1:1,powerFactor1:1,angle1:80})]}),XLSX,'instant');
  assert.ok(!pack.meters[0].signals.some(s=>s.code==='J31_VECTOR_ANGLE'));
});

test('S versus U*I is conditional and only evaluated with known units in explicitly unscaled report',()=>{
  const metrics={voltage1:230,current1:10,apparent1:0.5};
  const pack=readJournalWorkbook(instant([row('000123','31.08.2026',metrics)]),XLSX,'instant');
  const flag=pack.meters[0].signals.find(s=>s.code==='J31_VECTOR_UI');assert.ok(flag);assert.equal(flag.conditional,true);assert.equal(flag.informational,true);
  const generic=readJournalWorkbook(excel({'Лист1':[instantHeaders,row('000123','31.08.2026',metrics)]}),XLSX,'instant');
  assert.ok(!generic.meters[0].signals.some(s=>s.code==='J31_VECTOR_UI'));
  const missingUnits=[...instantHeaders];missingUnits[26]='Напряжение на фазе 1';
  const incomplete=readJournalWorkbook(excel({'Лист1':[['без учета коэффициентов трансформации'],missingUnits,row('000123','31.08.2026',metrics)]}),XLSX,'instant');
  assert.ok(!incomplete.meters[0].signals.some(s=>s.code==='J31_VECTOR_UI'));assert.ok(incomplete.warnings.some(w=>w.includes('единицы не указаны')));
});

test('canonical unit conversion covers W/var/VA, kV, mA, percentages and radians before diagnostics',()=>{
  const headers=[...instantHeaders];headers[15]='Активная мощность по фазе 1 (Вт)';headers[19]='Реактивная мощность по фазе 1 (вар)';headers[23]='Полная мощность по фазе 1 (ВА)';headers[26]='Напряжение на фазе 1 (кВ)';headers[29]='Ток в фазе 1 (мА)';headers[34]='Коэффициент мощности по фазе 1 cos(f), %';headers[44]='Угол между векторами U I, фазы A, рад';
  const data={active1:800,reactive1:600,apparent1:1000,voltage1:0.23,current1:1000/0.23,powerFactor1:80,angle1:Math.acos(0.8)};
  const pack=readJournalWorkbook(excel({'Лист1':[['без учета коэффициентов трансформации'],headers,row('000123','31.08.2026',data)]}),XLSX,'instant');
  const v=Object.fromEntries(pack.fields.map((key,i)=>[key,pack.meters[0].latest.values[i]]));
  assert.equal(v.active1,0.8);assert.equal(v.reactive1,0.6);assert.equal(v.apparent1,1);assert.equal(v.voltage1,230);assert.ok(Math.abs(v.current1-1000/230)<1e-9);assert.equal(v.powerFactor1,0.8);assert.ok(Math.abs(v.angle1-Math.acos(0.8)*180/Math.PI)<1e-9);
  assert.ok(!pack.meters[0].signals.some(s=>s.code.startsWith('J31_VECTOR')));assert.ok(pack.warnings.some(w=>w.includes('пересчитаны')));
});

test('contradictory physical unit and overflowing conversions never become anomaly evidence',()=>{
  const headers=[...instantHeaders];headers[15]='Активная мощность по фазе 1 (кВА)';headers[19]='Реактивная мощность по фазе 1 (Мвар)';
  const pack=readJournalWorkbook(excel({'Лист1':[headers,row('000123','31.08.2026',{active1:900,reactive1:1e308,apparent1:1})]}),XLSX,'instant');
  const latest=pack.meters[0].latest.values;
  assert.equal(latest[INSTANT_FIELDS.indexOf('active1')],null);assert.equal(latest[INSTANT_FIELDS.indexOf('reactive1')],null);assert.ok(!pack.meters[0].signals.some(s=>s.code==='J31_VECTOR'));
  assert.ok(pack.warnings.some(w=>w.includes('несоответствующая единица')));
});

test('high neutral under triplen harmonics or one-phase load does not imply a jumper',()=>{
  const codes=metrics=>readJournalWorkbook(instant([row('000123','31.08.2026',metrics)]),XLSX,'instant').meters[0].signals;
  assert.ok(!codes({current1:40,current2:40,current3:40,neutralCurrent:100}).some(s=>s.code==='J31_NEUTRAL'));
  assert.ok(!codes({current1:10,current2:0,current3:0,neutralCurrent:10}).some(s=>s.code==='J31_NEUTRAL'));
  assert.ok(!codes({current1:10,current2:null,current3:0,neutralCurrent:20}).some(s=>s.code==='J31_NEUTRAL'));
  const excess=codes({current1:2,current2:2,current3:2,neutralCurrent:10}).find(s=>s.code==='J31_NEUTRAL');
  assert.ok(excess);assert.match(excess.recommendation,/не доказывает перемычку/);
});

test('compact monthly observations retain actual first/last details across out-of-order data',()=>{
  const make=(day,p)=>row('000123',`${String(day).padStart(2,'0')}.08.2026 10:00`,{active1:p,current1:5});
  const rows=[make(20,-1),make(10,-2),make(25,-3),make(1,-4),make(15,-100)];
  const pack=readJournalWorkbook(instant(rows),XLSX,'instant'),flag=pack.meters[0].signals.find(s=>s.code==='J31_REVERSE'),m=flag.months[0];
  assert.equal(m.count,5);assert.equal(m.observations.length,2);assert.equal(m.observations[0].at,'2026-08-01T10:00:00');assert.equal(m.observations[1].at,'2026-08-25T10:00:00');
  assert.match(m.observations[0].detail,/−?[-]4/);assert.match(m.observations[1].detail,/−?[-]3/);assert.equal(m.detail,m.observations[0].detail);assert.equal(flag.detail,m.observations[0].detail);
  const one=readJournalWorkbook(instant([make(10,-2)]),XLSX,'instant').meters[0].signals[0].months[0];assert.equal(one.observations.length,1);
});

test('many observations keep bounded evidence and first detail instead of every abnormal sample',()=>{
  const rows=Array.from({length:150},(_,i)=>row('000123',`01.08.2026 10:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}`,{active1:-1-i/100,current1:5}));
  const pack=readJournalWorkbook(instant(rows),XLSX,'instant'),m=pack.meters[0].signals[0].months[0];
  assert.equal(m.count,150);assert.equal(m.observations.length,2);assert.equal(m.observations[0].at,'2026-08-01T10:00:00');assert.equal(m.observations[1].at,'2026-08-01T10:02:29');
  assert.ok(JSON.stringify(pack).length<5000);
});

test('reverse profile uses report period, never instant timestamp/month, and same direction family',()=>{
  const metrics={reverseMin:0,reverseAvg:0.1,reverseMax:0.2,active1:-1,current1:5};
  const pack=readJournalWorkbook(instant([row('000123','31.08.2026 15:15',metrics),row('000123','31.08.2026 15:16',metrics)]),XLSX,'instant');
  assert.equal(pack.analysisVersion,2);
  const profile=pack.meters[0].signals.find(s=>s.code==='J31_REVERSE_PROFILE'),phase=pack.meters[0].signals.find(s=>s.code==='J31_REVERSE');
  assert.equal(profile.timestampBasis,'report_period');assert.deepEqual(profile.reportPeriod,{from:'2026-08-01',to:'2026-09-01'});assert.equal(profile.first,null);assert.equal(profile.last,null);assert.deepEqual(profile.months,[]);assert.equal(profile.count,1);assert.equal(profile.family,phase.family);assert.equal(profile.family,'direction');assert.match(profile.detail,/интервальные параметры/);assert.match(profile.recommendation,/генераци/);
});

test('all twelve profile parameters check ordering/signs as data quality, with incomplete and rounded values allowed',()=>{
  const bad={forwardMin:1,forwardAvg:0.2,forwardMax:2,reverseMin:-1,reverseAvg:0,reverseMax:0,reactiveImportMin:0,reactiveImportAvg:3,reactiveImportMax:1,reactiveExportMin:2,reactiveExportMax:1};
  const pack=readJournalWorkbook(instant([row('000123','31.08.2026',bad)]),XLSX,'instant'),flag=pack.meters[0].signals.find(s=>s.code==='J31_PROFILE_QUALITY');
  assert.ok(flag);assert.equal(flag.informational,true);assert.equal(flag.timestampBasis,'report_period');assert.equal(flag.first,null);assert.deepEqual(flag.months,[]);for(const name of ['A+','A−','R+','R−'])assert.ok(flag.detail.includes(name));
  const safe={forwardMin:0.205,forwardAvg:0.2,forwardMax:null,reverseAvg:null,reverseMax:0.199,reactiveImportMin:0,reactiveImportMax:1};
  const normal=readJournalWorkbook(instant([row('000123','31.08.2026',safe)]),XLSX,'instant');assert.ok(!normal.meters[0].signals.some(s=>s.code==='J31_PROFILE_QUALITY'||s.code==='J31_REVERSE_PROFILE'));
});

test('compact events preserve month/day counts and actual edge descriptions regardless of row ordering',()=>{
  const agg=createEventAggregator(),desc=extra=>'Вскрытый элемент устройства "Клеммная крышка"; '+extra;
  for(const [at,info]of [['2026-08-20T10:00:00','middle'],['2026-08-01T09:00:00','first'],['2026-08-25T13:00:00','last'],['2026-08-20T10:01:00','variant']])agg.add('000123',at,desc(info));
  const pack=agg.finish(),g=pack.groups[0];
  assert.equal(g.count,4);assert.equal(g.first,'2026-08-01T09:00:00');assert.equal(g.last,'2026-08-25T13:00:00');assert.equal(g.days.length,3);assert.deepEqual(g.days[1],[20,'2026-08-20T10:00:00','2026-08-20T10:01:00',2]);
  assert.equal(g.examples.length,3);assert.equal(g.examples[0].description,desc('first'));assert.equal(g.examples.at(-1).description,desc('last'));assert.ok(g.examplesTruncated);
  assert.equal(pack.stats.repeatedRows,3);assert.equal(pack.rows,undefined);
});

test('active category signatures distinguish compounds while inactive variant messages remain one OTHER group',()=>{
  const agg=createEventAggregator(),cover='Вскрытый элемент устройства "Клеммная крышка"',magnet='Вскрытый элемент устройства "Магнитная пломба постоянного поля"';
  agg.add('000123','2026-08-01T10:00:00',cover);agg.add('000123','2026-08-01T10:01:00',cover+'\n'+magnet);agg.add('000123','2026-08-01T10:02:00',magnet+'\n'+cover);
  for(let i=0;i<1000;i++)agg.add('000123','2026-08-02T10:00:00','Закрытие корпуса, сообщение '+i);
  const pack=agg.finish();assert.equal(pack.groups.length,3);assert.equal(pack.stats.accepted,1003);
  const compound=pack.groups.find(g=>g.codes.length===2),other=pack.groups.find(g=>!g.codes.length);
  assert.deepEqual(compound.codes,['J46_MAGNET_DC','J46_TERMINAL_COVER']);assert.equal(compound.count,2);assert.equal(other.count,1000);assert.ok(other.examples.length<=3);
  assert.equal(eventClassification('J46_TERMINAL_COVER').kind,'opening');assert.equal(eventClassification('not-a-kind'),null);
});

test('identical timestamp repeats are counted as registrations and do not allocate raw event rows',()=>{
  const agg=createEventAggregator(),text='Вскрытый элемент устройства "Клеммная крышка"';
  for(let i=0;i<600001;i++)agg.add('000123','2026-08-01T10:00:00',text);
  const pack=agg.finish();assert.equal(pack.stats.rows,600001);assert.equal(pack.stats.accepted,600001);assert.equal(pack.groups.length,1);assert.equal(pack.groups[0].count,600001);assert.equal(pack.groups[0].days[0][3],600001);assert.equal(pack.stats.repeatedRows,600000);
  assert.equal(pack.groups[0].examples.length,1);assert.equal(pack.rows,undefined);assert.ok(JSON.stringify(pack).length<2000);assert.ok(pack.warnings.some(w=>w.includes('не число независимых вскрытий')));
});

test('event groups do not merge different meters, months or activated/restored states',()=>{
  const agg=createEventAggregator(),opened='Вскрытый элемент устройства "Корпус"';
  agg.add('000123','2026-08-01T10:00:00',opened);agg.add('000123','2026-09-01T10:00:00',opened);agg.add('123','2026-08-01T10:00:00',opened);agg.add('000123','2026-08-01T10:00:00','Корпус закрыт');
  const pack=agg.finish();assert.equal(pack.groups.length,4);assert.equal(pack.stats.meters,2);assert.equal(pack.groups.filter(g=>!g.codes.length).length,1);
});

test('legacy offline rows compact in place without fabricating excluded duplicate observations',()=>{
  const description='Вскрытый элемент устройства "Клеммная крышка"',legacy={format:1,role:'events',rows:[['000123','2026-08-01T10:00:00',description],['000123','2026-08-01T10:01:00',description]],stats:{rows:9,accepted:2,duplicates:7},warnings:['old source warning']};
  const pack=normalizeEventPack(legacy);assert.equal(pack,legacy);assert.equal(legacy.rows,undefined);assert.equal(pack.groups.length,1);assert.equal(pack.groups[0].count,2);assert.equal(pack.stats.accepted,2);assert.equal(pack.stats.legacyExcludedDuplicates,7);assert.ok(pack.warnings.includes('old source warning'));assert.ok(pack.warnings.some(w=>w.includes('исключённые дубли не восстанавливаются')));
  assert.equal(normalizeEventPack(pack),pack);
  assert.throws(()=>normalizeEventPack({format:1,role:'registry',rows:[]}),/формат/);
});

for(const bookType of ['xlsx','biff8'])test(`${bookType}: strict three-column events support header and headerless extracted values`,()=>{
  const rows=[['000123','09.10.2025 08:49:37','Вскрытый элемент устройства "Клеммная крышка"'],['000123','09.10.2025 08:49:38','Вскрытый элемент устройства "Клеммная крышка"']];
  for(const withHeader of [false,true]) {
    const data=withHeader?[['Серийный','Дата и время','Дополнительная информация'],...rows]:rows;
    const pack=readJournalWorkbook(excel({'Лист1':data},bookType),XLSX,'events');assert.equal(pack.stats.accepted,2);assert.equal(pack.groups.length,1);assert.equal(pack.groups[0].serial,'000123');assert.equal(pack.groups[0].first,'2025-10-09T08:49:37');
  }
  const shifted=[['Serial','bad date','text'],...rows.map(r=>[...r,'unrelated column'])];
  assert.throws(()=>readJournalWorkbook(excel({'Лист1':shifted},bookType),XLSX,'events'),/шапка/);
});

test('aggregator validates raw source rows and source-count limit, keeping snapshots independent',()=>{
  const agg=createEventAggregator(),text='Вскрытый элемент устройства "Корпус"';
  assert.equal(agg.add(null,null,null),false);assert.equal(agg.stats.rows,0);
  assert.equal(agg.add({v:123,z:'000000'},'2026-08-01T10:00:00',text),true);
  const first=agg.finish();assert.equal(first.groups[0].serial,'000123');
  agg.add('000123','2026-08-01T10:01:00',text);assert.equal(first.groups[0].days[0][3],1);
  agg.add('','2026-08-01T10:00:00',text);agg.add('000123','31.02.2026',text);agg.add('000123','2026-08-01T10:00:00','');
  const pack=agg.finish();assert.equal(pack.stats.invalidSerials,1);assert.equal(pack.stats.invalidDates,1);assert.equal(pack.stats.emptyDescriptions,1);assert.equal(pack.stats.accepted,2);
  agg.stats.rows=1000000;assert.throws(()=>agg.add('000123','2026-08-01T10:00:00',text),/1 000 000/);
  assert.deepEqual(detectEventHeader(eventHeaders,10),{serial:2,time:5,info:9});assert.equal(detectEventHeader(['Серийный','Дата и время','Дополнительная информация'],4),null);
});
