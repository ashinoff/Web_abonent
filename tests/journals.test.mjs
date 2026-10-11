import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { readJournalWorkbook, eventKind, eventKinds, serialKey, parseJournalTimestamp, INSTANT_FIELDS, INSTANT_METRICS } from '../public/journals.js';

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

for(const bookType of ['xlsx','biff8']) test(`${bookType}: journal46 retains only C/F/J, exact information and civil time, deduplicates`,()=>{
  const text='Вскрытый элемент устройства "Клеммная крышка"\nПолное исходное пояснение';
  const pack=readJournalWorkbook(excel({'Лист1':[['События за период'],eventHeaders,event('000123','06.03.2026 12:55:33',text),event('000123','06.03.2026 12:55:33',text),event('000123','06.03.2026 12:55:34','Неизвестный исходный текст')]},bookType),XLSX,'events');
  assert.deepEqual(pack.rows,[['000123','2026-03-06T12:55:33',text],['000123','2026-03-06T12:55:34','Неизвестный исходный текст']]);
  assert.equal(pack.stats.rows,3);assert.equal(pack.stats.accepted,2);assert.equal(pack.stats.duplicates,1);
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
  assert.equal(pack.rows[0][0],'000123');assert.equal(pack.stats.invalidDates,1);assert.equal(pack.stats.invalidSerials,1);assert.equal(pack.stats.skipped,2);
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
  assert.equal(pack.rows.length,1);assert.equal(pack.rows[0][2],details);
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
  const fake={...XLSX,read:()=>({SheetNames:['Large'],Sheets:{Large:{'!ref':'A1:J500083','!fullref':'A1:J600000'}}})};
  assert.throws(()=>readJournalWorkbook(new Uint8Array([0x50,0x4b]),fake,'events'),/500 000/);
  assert.throws(()=>readJournalWorkbook(new Uint8Array([1,2,3]),XLSX,'events'),/Excel/);
});
