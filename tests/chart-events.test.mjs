import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { indexChartEvents, mountChart } from '../public/analysis-chart.js';
import { initAnalysisUI } from '../public/analysis-ui.js';

const months = [{ y:2025,m:11 }, { y:2026,m:0 }, { y:2026,m:1 }];
const event = (at, kind = 'opening', description = 'Вскрытый элемент устройства "Корпус"') => ({ serial:'TEST-001',at,kind,description,title:'Событие ПУ',code:'J46_CASE' });
const chart = events => {
  const window = new Window(), host = window.document.createElement('section');
  window.document.body.append(host);
  mountChart(host, { months,values:[100,50,null],events });
  return { window,host,$: selector => host.querySelector(selector) };
};
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
  assert.match(p.$('.chart-reading').textContent,/Нет полных данных/);
  p.$('[data-chart-mode="yearly"]').click();
  assert.match(p.$('.chart-reading').textContent,/по годам/);
  p.$('[data-chart-mode="timeline"]').click();
  p.$('[data-zoom="left"]').click();
  assert.ok(p.$('.plot svg'));
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
  const settings=ui.getSettings();settings.algOff.dzero=true;assert.equal(ui.getSettings().algOff.dzero,false);
});
