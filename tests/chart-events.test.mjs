import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { indexChartEvents, indexChartCases, journalCaseDetailHTML, journalCaseTitle, mountChart } from '../public/analysis-chart.js';
import { initAnalysisUI } from '../public/analysis-ui.js';

const months = [{ y:2025,m:11 }, { y:2026,m:0 }, { y:2026,m:1 }];
const event = (at, kind = 'opening', description = 'Вскрытый элемент устройства "Корпус"') => ({ serial:'TEST-001',at,kind,description,title:'Событие ПУ',code:'J46_CASE' });
const monthlyEvent = (first,last,count=120000,overrides={}) => ({...event(first),first,last,month:first.slice(0,7),count,groupId:'private-month-group',days:[[first.slice(0,10),first,first,count-1],[last.slice(0,10),last,last,1]],examples:[{at:first,description:'Вскрытый элемент устройства "Корпус"'},{at:last,description:'Повторная регистрация'}],examplesTruncated:true,...overrides});
const chart = (events, cases = []) => {
  const window = new Window(), host = window.document.createElement('section');
  window.document.body.append(host);
  mountChart(host, { months,values:[100,50,null],events,cases });
  return { window,host,$: selector => host.querySelector(selector) };
};
const combination = overrides => ({ id:'private-case-id',serial:'TEST-001',scenario:'combined',priority:'high',month:'2026-01',value:50,
  point:{key:'private-point-key',label:'Тестовая точка'},consumptionScope:'Объёмы ЛС + ТУ, события и измерения одного ПУ',
  comparisons:{previous:{available:true,value:100,dropPercent:50,month:'2025-12'},yearAgo:{available:false,reason:'Нет полного объёма за январь прошлого года.'},median3:{available:false,reason:'Недостаточно трёх предыдущих месяцев.'}},
  seasonalAlternative:false,temporalRelation:'same_month',detail:'Снижение совпало с независимыми признаками журналов 31 и 46 по одному ПУ.',recommendation:'Сверьте схему учёта и документы работ.',
  evidence:{electrical:[{code:'J31_POWER',title:'Несогласованные параметры',at:'2026-01-05T11:22:33',detail:'Фаза 1: I=2 А, P=0 кВт, U=230 В.',count:2,timestampDetailExact:false}],events:[{at:'2026-01-03T10:20:30',description:'Вскрытый элемент устройства "Клеммная крышка"',classifications:[{title:'Вскрытие клеммной крышки'}]}]},...overrides });
test('chart events use their own year/month; invalid and unclassified events do not become alarms', () => {
  const data = indexChartEvents(months, [event('2025-12-31T23:59:59'),event('2026-01-01T00:00:00','magnetic'),
    event('2025-01-05T00:00:00'),event('2027-01-05T00:00:00'),event('2026-02-31T12:00:00'),event('2026-01-05T00:00:00',null)]);
  assert.equal(data.outsidePeriod,2);
  assert.deepEqual([...data.byMonth.keys()],[0,1]);
  assert.equal(data.byMonth.get(0)[0].kind,'intrusion');
  assert.equal(data.byMonth.get(1)[0].kind,'magnetic');
});
test('timeline and year comparison keep event dates attached to the actual year and expose details by keyboard', () => {
  const p=chart([event('2025-12-31T23:59:59'),event('2026-01-01T00:00:00','magnetic'),event('2025-01-05T00:00:00')]);
  assert.equal(p.host.querySelectorAll('.plot-event').length,2);
  assert.match(p.$('.chart-event-outside').textContent,/1/);
  p.$('.plot-event[data-month="0"]').dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  assert.match(p.$('.chart-event-details').textContent,/31\.12\.2025 23:59:59/);
  assert.doesNotMatch(p.$('.chart-event-details').textContent,/01\.01\.2026/);
  p.$('[data-chart-mode="yearly"]').click();
  assert.equal(p.host.querySelectorAll('.plot-event[data-event-year="2025"]').length,1);
  assert.equal(p.host.querySelectorAll('.plot-event[data-event-year="2026"]').length,1);
  p.$('.plot-event[data-event-year="2026"]').dispatchEvent(new p.window.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  assert.match(p.$('.chart-event-details').textContent,/01\.01\.2026/);
  assert.doesNotMatch(p.$('.chart-event-details').textContent,/31\.12\.2025/);
});
test('monthly 46 groups keep one marker each despite repeated registrations and show actual bounded examples',()=>{
  const first='2026-01-03T10:20:30',last='2026-01-28T23:59:59';
  const grouped=monthlyEvent(first,last,120000,{examples:[{at:first,description:'<img src=x onerror=alert(1)> Корпус'},{at:'2026-01-14T12:00:00',description:'Пример середины'},{at:last,description:'Последняя регистрация'},{at:last,description:'Лишний четвёртый пример'}]});
  const other=monthlyEvent('2026-01-04T00:00:00','2026-01-27T00:00:00',300,{serial:'TEST-002',groupId:'private-other-group',code:'J46_TERMINAL_COVER'});
  const p=chart([grouped,other,event('2026-01-05T11:22:33','electrical','Измерение I=2 А')]);
  assert.equal(p.host.querySelectorAll('.plot-event[data-monthly-group]').length,2);
  assert.equal(p.host.querySelectorAll('.plot-event[data-event-kind="electrical"]').length,1);
  const marker=p.$('.plot-event[data-monthly-group]');
  assert.match(marker.getAttribute('aria-label'),/регистраций 120000/);
  assert.match(marker.querySelector('title').textContent,/03\.01\.2026 10:20:30/);
  assert.match(marker.querySelector('title').textContent,/28\.01\.2026 23:59:59/);
  assert.doesNotMatch(marker.querySelector('title').textContent,/Лишний четвёртый/);
  marker.dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  assert.match(p.$('.chart-event-counts').textContent,/2 месячных групп · 120300 регистраций/);
  assert.match(p.$('.chart-event-details').textContent,/не равно числу независимых вскрытий/);
  assert.match(p.$('.chart-event-details').textContent,/не означает непрерывную тревогу/);
  assert.equal(p.host.querySelectorAll('.event-examples>div').length,5);
  assert.equal(p.host.querySelectorAll('.chart-event-details img').length,0);
  assert.doesNotMatch(p.$('.chart-event-details').textContent,/Лишний четвёртый|private-month-group|private-other-group/);
  p.$('[data-chart-mode="yearly"]').click();
  assert.equal(p.host.querySelectorAll('.plot-event[data-monthly-group][data-event-year="2026"]').length,2);
  p.$('.plot-event[data-monthly-group]').dispatchEvent(new p.window.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  assert.match(p.$('.chart-event-details').textContent,/28\.01\.2026 23:59:59/);
});
test('out-of-period monthly group counts registrations without projecting days or mismatched months',()=>{
  const data=indexChartEvents(months,[monthlyEvent('2025-01-03T10:20:30','2025-01-28T23:59:59',900000),monthlyEvent('2026-01-03T10:20:30','2026-01-28T23:59:59',500),monthlyEvent('2026-01-03T10:20:30','2026-01-28T23:59:59',500,{month:'2026-02'})]);
  assert.equal(data.outsidePeriod,900000);assert.equal(data.outsideGroups,1);
  assert.equal(data.byMonth.get(1).length,1);assert.equal(data.byMonth.has(2),false);
  const p=chart([monthlyEvent('2025-01-03T10:20:30','2025-01-28T23:59:59',900000)]);
  assert.equal(p.host.querySelectorAll('.plot-event').length,0);
  assert.match(p.$('.chart-event-outside').textContent,/900000 · месячных групп 46: 1/);
});
test('month event lists are bounded and escape source descriptions and serials', () => {
  const events=Array.from({length:61},(_,i)=>({ ...event(`2026-01-01T00:00:${String(i%60).padStart(2,'0')}`), serial:'<svg onload="alert(1)">',description:'<img src=x onerror="alert(1)"> & комментарий' }));
  const p=chart(events);p.$('.plot-event').dispatchEvent(new p.window.MouseEvent('click',{bubbles:true}));
  assert.equal(p.host.querySelectorAll('.chart-event-details li').length,50);
  assert.equal(p.host.querySelectorAll('.chart-event-details img,.chart-event-details svg').length,0);
  assert.match(p.$('.chart-event-details').textContent,/<img src=x/);
  assert.match(p.$('.chart-event-limit').textContent,/50 из 61/);
  assert.match(p.$('.chart-event-limit').textContent,/Excel/);
});
test('existing chart controls and missing-data readings work without journals', () => {
  const p=chart([]);
  assert.equal(p.host.querySelectorAll('.plot-event').length,0);
  assert.equal(p.$('.chart-event-legend').hidden,true);
  assert.equal(p.$('.chart-event-details').hidden,true);
  assert.equal(p.$('.chart-case-details').hidden,true);
  assert.equal(p.$('.chart-case-legend').hidden,true);
  assert.match(p.$('.chart-reading').textContent,/Нет полных данных/);
  p.$('[data-chart-mode="yearly"]').click();
  assert.match(p.$('.chart-reading').textContent,/по годам/);
  p.$('[data-chart-mode="timeline"]').click();
  p.$('[data-zoom="left"]').click();
  assert.ok(p.$('.plot svg'));
});
test('grouped cases highlight each actual year/month without moving out-of-period or undated evidence onto the chart',()=>{
  const item=combination({months:[{month:'2025-12',value:100},{month:'2026-01',value:50},{month:'2026-01',value:50},{month:'2025-01',value:20}]});
  const index=indexChartCases(months,[item,combination({month:null,scenario:'journals_only'})]);
  assert.deepEqual([...index.byMonth.keys()],[0,1]);assert.equal(index.outsidePeriod,1);
  assert.equal(index.byMonth.get(1).length,1);
  const values=[100,50,null], original=[...values], window=new Window(),host=window.document.createElement('section');
  mountChart(host,{months,values,events:[event('2026-01-03T10:20:30')],cases:[item]});
  assert.deepEqual(values,original);
  assert.equal(host.querySelectorAll('.plot-case-band').length,2);
  assert.equal(host.querySelectorAll('.plot-case').length,2);
  assert.equal(host.querySelectorAll('.plot-event').length,1);
  host.querySelector('.plot-case[data-month="1"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  assert.match(host.querySelector('.chart-case-details').textContent,/янв\s26/);
  assert.match(host.querySelector('.chart-case-details').textContent,/50 кВт·ч/);
  host.querySelector('[data-chart-mode="yearly"]').click();
  assert.equal(host.querySelectorAll('.plot-case[data-case-year="2025"]').length,1);
  assert.equal(host.querySelectorAll('.plot-case[data-case-year="2026"]').length,1);
  host.querySelector('.plot-case[data-case-year="2026"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  assert.match(host.querySelector('.chart-case-details').textContent,/TEST-001/);
  assert.deepEqual(values,original);
});
test('pre-existing low consumption is explicit and a subsequent real fall remains separate context',()=>{
  const earlier={month:'2025-12',value:50,additionalDropPercent:0,newDecline:false,reason:'До события расход уже был низким. <img src=x>'};
  const item=combination({temporalRelation:'pre_existing',priority:'check',preExistingDecline:earlier});
  assert.equal(journalCaseTitle(item),'Журнальные признаки на фоне прежнего снижения');
  const window=new Window(),host=window.document.createElement('div');host.innerHTML=journalCaseDetailHTML(item);
  assert.match(host.textContent,/Низкий уровень потребления наблюдался до журнальных признаков/);
  assert.match(host.textContent,/Новое снижение после них не подтверждено/);
  assert.match(host.querySelector('.case-preexisting').textContent,/дек\s25 · 50 кВт·ч/);
  assert.doesNotMatch(host.textContent,/Признаки и снижение попали/);
  assert.equal(host.querySelectorAll('img').length,0);
  const further=combination({preExistingDecline:{...earlier,newDecline:true,additionalDropPercent:40}});
  assert.equal(journalCaseTitle(further),'Параметры 31 + события 46 + снижение');
  host.innerHTML=journalCaseDetailHTML(further);
  assert.match(host.querySelector('.case-preexisting').textContent,/дополнительно снизился на 40%/);
  assert.match(host.querySelector('.case-temporal').textContent,/Порядок изменения нагрузки внутри месяца не установлен/);
});
test('case details retain independent evidence, missing comparison reasons, seasonal and common-TP alternatives, and escape input',()=>{
  const item=combination({serial:'<img src=x>',seasonalAlternative:true,peerContext:{available:true,commonDecline:true,detail:'В той же ТП снижение у 6 из 8 других ЛС.',tp:'ТП <101>'}});
  const window=new Window(),host=window.document.createElement('div');host.innerHTML=journalCaseDetailHTML(item);
  assert.match(host.textContent,/05\.01\.2026 11:22:33/);assert.match(host.textContent,/03\.01\.2026 10:20:30/);
  assert.match(host.textContent,/I=2 А/);assert.match(host.textContent,/Нет полного объёма за январь прошлого года/);
  assert.match(host.textContent,/Снижение на 50%/);assert.match(host.textContent,/Сезонная альтернатива/);
  assert.match(host.textContent,/6 из 8 других ЛС/);assert.match(host.textContent,/Описание агрегировано/);
  assert.equal(host.querySelectorAll('img,svg').length,0);
  assert.doesNotMatch(host.textContent,/private-case-id|private-point-key|undefined|вероятность/);
});
test('case details expose representative-source limits and only monthly support relevant to that period',()=>{
  const item=combination({supportingMonthlyFlags:[{code:'S3',title:'Падение другого периода',scope:'ЛС, все ТУ (контекст)'}]});
  const entry={...item,supportingMonthlyFlags:[{code:'S14',title:'Длительное снижение',scope:'ЛС, все ТУ (контекст)'}],thresholdMatches:['previous'],
    evidence:{...item.evidence,electricalCount:100,electricalTimestampCount:25,electricalDetailsTruncated:true,eventCount:120000,eventGroupCount:2,eventRegistrationCountScope:'participating_month_groups',eventTimestampCount:12,eventDetailsTruncated:true,events:item.evidence.events.map(record=>({...record,timestampDetailExact:false}))}};
  const window=new Window(),host=window.document.createElement('div');host.innerHTML=journalCaseDetailHTML(item,entry);
  assert.match(host.textContent,/Показано 1 из 25 сохранённых записей/);
  assert.match(host.textContent,/полные измерения — в исходном журнале 31/);
  assert.match(host.textContent,/Показано 1 из 12 сохранённых фактических дат регистраций/);
  assert.match(host.textContent,/Участвующих месячных групп: 2 · регистраций в них: 120000/);
  assert.match(host.textContent,/не ограничено точным временным окном измерений журнала 31/);
  assert.match(host.textContent,/этот текст не привязан к конкретной регистрации/);
  assert.match(host.textContent,/S14 · Длительное снижение · ЛС, все ТУ \(контекст\)/);
  assert.doesNotMatch(host.textContent,/Падение другого периода/);
  assert.equal(host.querySelectorAll('[data-triggered="true"]').length,1);
  assert.match(host.textContent,/Порог отбора выполнен/);
});
test('load at zero consumption has a separate factual description without inventing a drop',()=>{
  const item=combination({scenario:'load_zero',value:0,comparisons:{previous:{available:false,value:0,reason:'Для процентного сравнения необходим положительный базовый объём.'},yearAgo:{available:false,reason:'Нет прошлого года.'},median3:{available:false,reason:'Нет трёх месяцев.'}}});
  const window=new Window(),host=window.document.createElement('div');host.innerHTML=journalCaseDetailHTML(item);
  assert.match(host.textContent,/Нагрузка зафиксирована при измерении/);
  assert.match(host.textContent,/Мгновенная мощность не интегрировалась/);
  assert.match(host.querySelector('.case-comparisons [data-available="false"]').textContent,/0 кВт·ч/);
  assert.doesNotMatch(host.textContent,/Признаки и снижение попали/);
});
test('chart case lists are explicitly bounded while preserving event details',()=>{
  const cases=Array.from({length:12},(_,i)=>combination({serial:'TEST-'+i})),p=chart([event('2026-01-03T10:20:30')],cases);
  p.$('.plot-case').dispatchEvent(new p.window.MouseEvent('click',{bubbles:true}));
  assert.equal(p.host.querySelectorAll('.chart-case-details .journal-case').length,8);
  assert.match(p.$('.chart-case-details').textContent,/8 из 12 сопоставлений/);
  assert.match(p.$('.chart-event-details').textContent,/03\.01\.2026/);
});
test('consumer UI keeps complete factual journal reasons and separate journal priority',async t=>{
  const window=new Window({url:'https://app.example.test/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  window.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  for(const [key,value] of Object.entries({window,document:window.document,localStorage:window.localStorage})) {
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});
    t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);
  }
  const r={ meter:{name:'Тестовый абонент',account:'TEST-001',pointCount:1,rowCount:1,values:[100,50,null],sources:[],power:null},cls:'green',score:0,total:150,lossKwh:0,baseline:100,
    flags:[{code:'J31_TEST',title:'Журнальный признак',detail:'Первое измерение: 1 А. Второе измерение: 2 А. Полная причина выбора.',pts:10,weak:true,source:'instant',recommendation:'Сверьте обе фазы и журнал работ.'}],
    journalPriority:'check',journalScore:10,journal:{events:[event('2026-01-01T00:00:00')],coverage:{instant:{loaded:true,matchedMeters:1,totalMeters:2,warnings:['Неоднозначная привязка исключена.']},events:{loaded:false}},latestMetrics:[{serial:'TEST-001',at:'2026-01-02T00:00:00',values:[1.2],fields:['current1'],coefficientMode:'unscaled'}]} };
  r.flags.push({code:'J31_SUPPORT',title:'Дополнительное измерение',detail:'Фаза 2: I=2 А.',pts:0,weak:true,source:'instant',supportingEvidence:true},
    {code:'J31_CONDITION',title:'Условное измерение',detail:'Требуется сверка схемы.',pts:0,weak:true,source:'instant',conditional:true},
    {code:'J31_INFO',title:'Справочное измерение',detail:'Информация о нагрузке.',pts:0,weak:true,source:'instant',informational:true},
    {code:'S6',title:'Повторяемые месячные значения',detail:'Тестовые наблюдения.',pts:5,weak:true});
  const ui=initAnalysisUI({request:async()=>({result:r,months,warnings:[],individual:true,scope:'Одна точка'}),isReady:()=>true,getIncoming:()=>({ready:false}),showConnection(){}});
  await ui.openConsumer('TEST-001','Тестовая точка');
  const body=window.document.querySelector('#analysis-body');
  assert.match(body.querySelector('.flag-card p').textContent,/Полная причина выбора/);
  assert.match(body.querySelector('.recommendations').textContent,/Сверьте обе фазы/);
  assert.equal(body.querySelector('.journal-priority').dataset.zone,'amber');
  assert.match(body.querySelector('.analysis-intro').textContent,/Без выраженных признаков · 0 баллов/);
  assert.match(body.querySelector('.journal-coverage').textContent,/Не загружен/);
  assert.match(body.querySelector('.journal-metrics').textContent,/Ток, фаза 1/);
  assert.doesNotMatch(body.textContent,/undefined|unscaled|unknown/);
  assert.match(body.querySelector('.journal-metrics').textContent,/без коэффициентов трансформации/);
  assert.match(body.querySelector('.journal-coverage').textContent,/отдельные баллы/);
  assert.match(body.textContent,/Подтверждающее наблюдение · баллы учтены в совокупности/);
  assert.match(body.textContent,/Условное наблюдение/);assert.match(body.textContent,/Справочное наблюдение/);
  assert.doesNotMatch(body.textContent,/\+0 доп\./);
  assert.equal([...body.querySelectorAll('.flag-card')].at(-1).querySelector('.flag-points').textContent,'+5');
  assert.match([...body.querySelectorAll('.flag-card')].at(-1).textContent,/Слабый признак/);
  assert.match(body.querySelector('.scope-note').textContent,/В основной модели ПО групповые признаки не используются/);
  const settings=ui.getSettings();settings.algOff.dzero=true;assert.equal(ui.getSettings().algOff.dzero,false);
});
test('consumer UI exposes combined cases, bounded totals and independent evidence while keeping monthly score',async t=>{
  const window=new Window({url:'https://app.example.test/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  window.document.write(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));
  for(const [key,value] of Object.entries({window,document:window.document,localStorage:window.localStorage})) {
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});
    t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);
  }
  const cases=Array.from({length:10},(_,i)=>combination({serial:`TEST-${i}`,peerContext:{available:false,reason:'В этой ТП меньше шести сопоставимых других ЛС.'}}));
  cases[0].months=Array.from({length:5},(_,i)=>({...cases[0],months:undefined,month:`2026-0${i+1}`,value:20+i}));
  const result={meter:{name:'Тестовый потребитель',account:'TEST-001',pointCount:1,rowCount:1,values:[100,50,null],sources:[],power:null},cls:'green',score:0,total:150,lossKwh:0,baseline:100,flags:[],journal:{events:[],cases,caseCount:25,casesTruncated:true,eventRegistrationCount:120000,eventGroupCount:2,coverage:{instant:{loaded:false},events:{loaded:true,matchedMeters:1,totalMeters:5,matchedGroups:2,matchedRegistrations:120000,totalGroups:10,totalRegistrations:600000}}}};
  const ui=initAnalysisUI({request:async()=>({result,months,warnings:[],individual:true,scope:'Одна точка'}),isReady:()=>true,getIncoming:()=>({ready:false}),showConnection(){}});
  await ui.openConsumer('TEST-001','Тестовая точка');
  const body=window.document.querySelector('#analysis-body');
  assert.equal(body.querySelectorAll('.journal-cases>.journal-case').length,8);
  assert.match(body.querySelector('.journal-cases').textContent,/8 из 25 совокупностей/);
  assert.match(body.querySelector('.journal-cases').textContent,/4 из 5 месяцев/);
  assert.match(body.querySelector('.journal-cases').textContent,/Высокий приоритет проверки/);
  assert.match(body.querySelector('.journal-cases').textContent,/меньше шести сопоставимых/);
  assert.match(body.querySelector('.journal-cases').textContent,/05\.01\.2026 11:22:33/);
  assert.match(body.querySelector('.journal-cases').textContent,/03\.01\.2026 10:20:30/);
  assert.match(body.querySelector('.journal-coverage summary').textContent,/46: 2 групп \/ 120000 регистраций/);
  assert.match(body.querySelector('.journal-source[data-state="ready"]').textContent,/По выбранным ПУ: 2 месячных групп · 120000 регистраций/);
  assert.match(body.querySelector('.journal-source[data-state="ready"]').textContent,/В целом по РЭС: 10 групп · 600000 регистраций/);
  assert.doesNotMatch(body.querySelector('.journal-cases').textContent,/private-case-id|private-point-key|undefined|доказанное хищение|вероятность/);
  assert.match(body.querySelector('.analysis-intro').textContent,/Без выраженных признаков · 0 баллов/);
});
