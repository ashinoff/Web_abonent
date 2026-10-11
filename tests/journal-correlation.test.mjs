import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMonthly, pointKey } from '../public/monthly.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { createJournalAnalysis } from '../public/journal-analysis.js';
import { createJournalCorrelation, indexPointComparisons, electricalObservations, eventEndpoints } from '../public/journal-correlation.js';

const now = new Date('2026-10-11T07:00:00Z');
const months = Array.from({ length: 21 }, (_, i) => ({ y: 2025 + Math.floor(i / 12), m: i % 12 }));
const values = (changes = {}) => months.map(({ y, m }) => changes[`${y}-${String(m + 1).padStart(2, '0')}`] ?? 100);
const row = (account = '001', point = 'P1', data = values()) => ({ account, accountKey: account, point, pointNumber: '', pointName: '', tp: 'ТП-1', values: data, source: 'ПО:5', name: 'Учебный потребитель' });
const record = (serial = '000123', account = '001', point = 'P1') => ({ fields: { meter: serial, account, point, pointNumber: '', pointName: '', tp: 'ТП-1', power: '15', name: 'Учебный потребитель' } });
const description = 'Вскрытый элемент устройства "Клеммная крышка"';
const event = (at = '2026-06-06T12:00:00', serial = '000123') => ({ serial, at, description, kind: 'opening', code: 'J46_TERMINAL_COVER', title: 'Вскрытие клеммной крышки', classifications: [{ code: 'J46_TERMINAL_COVER', title: 'Вскрытие клеммной крышки', kind: 'opening' }] });
const signal = (at = '2026-06-05T12:00:00', extra = {}) => ({ code: 'J31_REVERSE', title: 'Обратное направление активной мощности', detail: 'P=-0,5 кВт; I=2 А', count: 1, first: at, last: at,
  months: [{ month: at.slice(0, 7), count: 1, first: at, last: at, detail: 'P=-0,5 кВт; I=2 А', observations: [{ at, detail: 'P=-0,5 кВт; I=2 А' }] }], ...extra });
const sample = (signals = [signal()], serial = '000123', latest = null) => ({ serial, samples: 1, signals, latest });
const instant = (meters = [sample()]) => ({ format: 1, role: 'instant', analysisVersion: 2, fields: ['active1', 'voltage1', 'current1'], coefficientMode: 'unscaled', meters, warnings: [] });
const eventPack = (entries = [event()]) => ({ format: 1, role: 'events', rows: entries.map(item => [item.serial, item.at, item.description]), warnings: [] });
function direct({ rows = [row('001', 'P1', values({ '2026-06': 40 }))], meters = [sample()], events = [event()], period = months, instantLoaded = true, eventsLoaded = true } = {}) {
  const model = indexMonthly({ rows, months: period, warnings: [] }), bindings = new Map();
  for (const meter of meters) bindings.set(meter.serial, { serial: meter.serial, account: rows[0].accountKey, point: pointKey(rows[0]), fields: { point: rows[0].point } });
  for (const item of events) if (!bindings.has(item.serial)) bindings.set(item.serial, { serial: item.serial, account: rows[0].accountKey, point: pointKey(rows[0]), fields: { point: rows[0].point } });
  const service = createJournalCorrelation({ model, bindings, instantBySerial: new Map(meters.map(item => [item.serial, item])), eventsBySerial: new Map([...bindings.keys()].map(key => [key, events.filter(item => item.serial === key)])), instantFields: ['active1', 'voltage1', 'current1'], instantLoaded, eventsLoaded, now });
  return { service, model, cases: service.reportCases(new Set(['001'])) };
}

test('same PU, own TU and three comparisons establish a combined case with preserved measurements', () => {
  const { cases } = direct(), item = cases.find(item => item.scenario === 'combined');
  assert.ok(item); assert.equal(item.priority, 'high'); assert.equal(item.value, 40); assert.equal(item.scope, 'ЛС + ТУ');
  assert.deepEqual(item.thresholdMatches, ['previous', 'yearAgo', 'median3']);
  for (const comparison of Object.values(item.comparisons)) { assert.equal(comparison.value, 100); assert.equal(comparison.dropPercent, 60); }
  assert.equal(item.evidence.electrical[0].timestampDetailExact, true); assert.equal(item.evidence.events[0].at, '2026-06-06T12:00:00');
  assert.equal(item.temporalRelation, 'same_month'); assert.match(item.detail, /порядок изменения потребления внутри месяца не установлен/);
  assert.equal(item.evidence.sameMeter, true); assert.equal(item.evidence.samePoint, true);
});

test('31 plus drop and 46 plus drop remain valid when the other journal is missing', () => {
  const electrical = direct({ events: [], eventsLoaded: false }).cases.find(item => item.scenario === 'electrical_drop');
  assert.ok(electrical); assert.equal(electrical.availability.events.loaded, false); assert.match(electrical.availability.events.reason, /не загружен/);
  const opening = direct({ meters: [], instantLoaded: false }).cases.find(item => item.scenario === 'event_drop');
  assert.ok(opening); assert.equal(opening.availability.instant.loaded, false); assert.match(opening.availability.instant.reason, /не загружен/);
});

test('a preceding month decrease of 30 percent is enough without a median or annual baseline', () => {
  const short = months.slice(12, 16), data = [20, 20, 100, 65];
  const { cases } = direct({ period: short, rows: [row('001', 'P1', data)], meters: [sample([signal('2026-04-05T12:00:00')])], events: [] });
  const item = cases.find(item => item.scenario === 'electrical_drop'); assert.ok(item);
  assert.deepEqual(item.thresholdMatches, ['previous']); assert.equal(item.comparisons.previous.dropPercent, 35);
  assert.equal(item.comparisons.yearAgo.available, false); assert.match(item.comparisons.yearAgo.reason, /нет необходимого календарного месяца/);
  assert.equal(item.comparisons.median3.value, 20); assert.equal(item.comparisons.median3.eligible, false);
});

test('the same month last year independently detects a drop that prior-month and median comparisons miss', () => {
  const { cases } = direct({ rows: [row('001', 'P1', values({ '2025-06': 200 }))], events: [] });
  const item = cases.find(item => item.scenario === 'electrical_drop'); assert.ok(item);
  assert.deepEqual(item.thresholdMatches, ['yearAgo']); assert.equal(item.comparisons.yearAgo.dropPercent, 50); assert.equal(item.comparisons.previous.dropPercent, 0);
});

test('median of exactly three previous complete positive months remains a separate compatible rule', () => {
  const short = months.slice(12, 16), data = [100, 100, 20, 40];
  const { cases } = direct({ period: short, rows: [row('001', 'P1', data)], meters: [sample([signal('2026-04-05T12:00:00')])], events: [] });
  assert.deepEqual(cases[0].thresholdMatches, ['median3']); assert.equal(cases[0].comparisons.median3.dropPercent, 60);
  assert.equal(cases[0].comparisons.previous.dropPercent, -100);
});

test('a seasonal annual alternative lowers additional priority despite a monthly decrease', () => {
  const { cases } = direct({ rows: [row('001', 'P1', values({ '2025-06': 40, '2026-06': 40 }))] });
  const item = cases.find(item => item.scenario === 'combined'); assert.ok(item);
  assert.equal(item.seasonalAlternative, true); assert.equal(item.priority, 'check'); assert.equal(item.comparisons.yearAgo.dropPercent, 0);
  assert.match(item.detail, /возможна сезонность/); assert.equal(item.score, 10);
});

test('registered evidence can precede a decrease by two calendar months and repeats are grouped', () => {
  const { cases } = direct({ rows: [row('001', 'P1', values({ '2026-07': 40, '2026-08': 40 }))] });
  const item = cases.find(item => item.scenario === 'combined'); assert.ok(item);
  assert.deepEqual(item.months.map(month => month.month), ['2026-07', '2026-08']); assert.equal(item.month, '2026-07');
  assert.equal(item.temporalRelation, 'after'); assert.equal(item.months[1].value, 40); assert.match(item.months[1].detail, /2026-08/);
  assert.match(item.detail, /Причинная связь не установлена/); assert.equal(item.evidence.eventCount, 1);
});

test('a decline before the evidence or more than two months after it cannot become a drop case', () => {
  for (const change of [{ '2026-05': 40 }, { '2026-09': 40 }]) {
    const { cases } = direct({ rows: [row('001', 'P1', values(change))] });
    assert.ok(!cases.some(item => ['combined', 'electrical_drop', 'event_drop'].includes(item.scenario)));
    assert.equal(cases[0].scenario, 'journals_only'); assert.equal(cases[0].priority, 'check');
  }
});

test('31-day actual timestamp matching accepts the boundary and rejects the next day', () => {
  const meters = [sample([signal('2026-05-01T12:00:00')])];
  assert.ok(direct({ meters, events: [event('2026-06-01T12:00:00')] }).cases.some(item => item.scenario === 'combined'));
  const far = direct({ meters, events: [event('2026-06-02T12:00:00')] }).cases;
  assert.ok(!far.some(item => item.scenario === 'combined')); assert.ok(far.some(item => item.scenario === 'electrical_drop')); assert.ok(far.some(item => item.scenario === 'event_drop'));
});

test('monthly recurring groups match only actual active-day endpoints at the exact 31-day boundary', () => {
  const compact = (last = '2026-05-01T12:00:00') => ({ ...event('2026-05-01T00:00:00'), aggregationVersion: 1, groupId: 'monthly-one', month: '2026-05', count: 20000,
    first: '2026-05-01T00:00:00', last, codes: ['J46_TERMINAL_COVER'], days: [[1, '2026-05-01T00:00:00', last, 20000]], examples: [{ at: '2026-05-01T00:00:00', description }], examplesTruncated: true });
  const meters = [sample([signal('2026-06-01T12:00:00')])];
  const exact = direct({ meters, events: [compact()] }).cases.find(item => item.scenario === 'combined'); assert.ok(exact);
  assert.equal(exact.evidence.eventCount, 20000); assert.equal(exact.evidence.eventGroupCount, 1); assert.equal(exact.evidence.eventTimestampCount, 1);
  assert.equal(exact.evidence.events[0].at, '2026-05-01T12:00:00'); assert.equal(exact.evidence.events[0].timestampDetailExact, false);
  assert.match(exact.evidence.events[0].description, /именно этой регистрации не сохранено/);
  assert.ok(!direct({ meters, events: [compact('2026-05-01T11:59:59')] }).cases.some(item => item.scenario === 'combined'));
  const endpoints = eventEndpoints([compact()]); assert.deepEqual(endpoints.map(item => item.at), ['2026-05-01T00:00:00', '2026-05-01T12:00:00']);
  assert.equal(endpoints[0].timestampDetailExact, true); assert.equal(endpoints[0].description, description);
});

test('active-day gaps are not filled, and full-month registration counts are deduplicated across windows', () => {
  const first = '2026-05-01T12:00:00', last = '2026-05-31T11:59:59';
  const group = { ...event(first), aggregationVersion: 1, groupId: 'gapped-month', month: '2026-05', first, last, count: 500000,
    days: [[1, first, first, 250000], [31, last, last, 250000]], codes: ['J46_TERMINAL_COVER'], examples: [{ at: first, description }] };
  assert.deepEqual(eventEndpoints([group]).map(item => item.at), [first, last]);
  const far = direct({ meters: [sample([signal('2026-07-01T12:00:00')])], rows: [row('001', 'P1', values({ '2026-07': 40 }))], events: [group] }).cases;
  assert.ok(!far.some(item => item.scenario === 'combined')); assert.ok(far.some(item => item.scenario === 'event_drop'));
  const repeated = direct({ meters: [sample([signal('2026-05-20T12:00:00'), signal('2026-06-01T12:00:00')])], rows: [row('001', 'P1', values({ '2026-06': 40, '2026-07': 40 }))], events: [group] }).cases;
  for (const item of repeated.filter(item => item.scenario === 'combined')) {
    assert.equal(item.evidence.eventCount, 500000); assert.equal(item.evidence.eventGroupCount, 1); assert.equal(item.score, 25);
    for (const month of item.months) assert.equal(month.evidence.eventCount, 500000);
  }
});

test('endpoint expansion stays lazy per requested PU and never scales with registration counts', () => {
  const model = indexMonthly({ rows: [row()], months, warnings: [] }), count = 1000, bindings = new Map(), eventsBySerial = new Map();
  for (let i = 0; i < count; i++) {
    const serial = 'M' + i, first = '2026-06-01T12:00:00', last = '2026-06-30T12:00:00';
    bindings.set(serial, { serial, account: '001', point: pointKey(row()), fields: { point: 'P1' } });
    eventsBySerial.set(serial, [{ ...event(first, serial), aggregationVersion: 1, groupId: serial, month: '2026-06', first, last, count: 600000, days: [[1, first, first, 300000], [30, last, last, 300000]], examples: [] }]);
  }
  const service = createJournalCorrelation({ model, bindings, instantBySerial: new Map(), eventsBySerial, instantLoaded: false, eventsLoaded: true, now });
  assert.equal(service.stats.expandedEventEndpoints, 0);
  service.casesForSerial('M0'); assert.equal(service.stats.expandedEventEndpoints, 2); assert.equal(service.stats.maxEventEndpointsPerSerial, 2);
  service.casesForSerial('M0'); assert.equal(service.stats.expandedEventEndpoints, 2);
});

test('the two journals without a qualifying decrease create a check, never an invented energy loss', () => {
  const { cases } = direct({ rows: [row()] }); assert.equal(cases.length, 1);
  assert.equal(cases[0].scenario, 'journals_only'); assert.equal(cases[0].month, null); assert.equal(cases[0].value, null); assert.equal(cases[0].priority, 'check');
  assert.equal(cases[0].comparisons.previous.available, false); assert.equal(cases[0].lossKwh, undefined);
});

test('an already low level before evidence is a check; a further real decrease remains high', () => {
  const at = '2026-05-16T12:00:00', meters = [sample([signal(at)])], events = [event(at)];
  const persistent = direct({ meters, events, rows: [row('001', 'P1', values({ '2026-03': 40, '2026-04': 40, '2026-05': 40, '2026-06': 40, '2026-07': 40 }))] }).cases;
  assert.ok(persistent.some(item => item.scenario === 'combined')); assert.ok(persistent.every(item => item.priority === 'check'));
  const old = persistent.find(item => item.month === '2026-05'); assert.equal(old.temporalRelation, 'pre_existing'); assert.equal(old.score, 10);
  assert.equal(old.preExistingDecline.month, '2026-04'); assert.equal(old.preExistingDecline.value, 40); assert.equal(old.preExistingDecline.additionalDropPercent, 0); assert.match(old.detail, /Низкий уровень наблюдался до признаков/);
  const fresh = direct({ meters, events, rows: [row('001', 'P1', values({ '2026-03': 40, '2026-04': 40, '2026-05': 20 }))] }).cases.find(item => item.month === '2026-05');
  assert.equal(fresh.priority, 'high'); assert.equal(fresh.temporalRelation, 'same_month'); assert.equal(fresh.preExistingDecline.additionalDropPercent, 50); assert.equal(fresh.preExistingDecline.newDecline, true);
});

test('conditional electrical observations require an independent 46 event and a decrease', () => {
  const conditional = sample([signal(undefined, { code: 'J31_MISSING_CURRENT', informational: true, conditional: true })]);
  assert.ok(direct({ meters: [conditional] }).cases.some(item => item.scenario === 'combined'));
  assert.equal(direct({ meters: [conditional], events: [] }).cases.length, 0);
  assert.equal(direct({ meters: [conditional], rows: [row()] }).cases.length, 0);
  for (const code of ['J31_PF', 'J31_UNBALANCE']) {
    const info = sample([signal(undefined, { code, informational: true, conditional: true })]);
    const cases = direct({ meters: [info] }).cases;
    assert.ok(!cases.some(item => item.scenario === 'combined')); assert.ok(cases.some(item => item.scenario === 'event_drop'));
  }
});

test('positive measured load with exact complete zero own-TU volume is a check with no integration into energy', () => {
  const meter = sample([], '000123', { at: '2026-06-05T12:00:00', values: [0.5, 230, 2] });
  const data = values({ '2026-06': 0 }), result = direct({ meters: [meter], events: [], rows: [row('001', 'P1', data)] });
  assert.equal(result.cases[0].scenario, 'load_zero'); assert.equal(result.cases[0].priority, 'check'); assert.equal(result.cases[0].value, 0);
  assert.match(result.cases[0].evidence.electrical[0].detail, /не интегрировалась в энергию/);
  assert.ok(direct({ meters: [meter], rows: [row('001', 'P1', data)] }).cases.some(item => item.scenario === 'combined'));
  for (const value of [1, null, -1]) {
    const data = values(); data[17] = value;
    assert.equal(direct({ meters: [meter], events: [], rows: [row('001', 'P1', data)] }).cases.length, 0);
  }
});

test('missing current months, future months, negative inputs and calendar holes remain unavailable', () => {
  const period = Array.from({ length: 6 }, (_, i) => ({ y: 2026, m: i + 6 })), data = [100, 100, 100, 0, 0, 0];
  const indexed = indexPointComparisons(period, [row('001', 'P1', data)], now);
  assert.equal(indexed.get(2026 * 12 + 9).available, false); assert.match(indexed.get(2026 * 12 + 9).reason, /не завершён/);
  for (const invalid of [null, -1, Infinity, NaN]) {
    const values = [100, 100, 100, invalid];
    const indexed = indexPointComparisons(months.slice(12, 16), [row('001', 'P1', values)], now);
    assert.equal(indexed.get(2026 * 12 + 3).available, false); assert.equal(indexed.get(2026 * 12 + 3).thresholdMatches.length, 0);
  }
  const holes = indexPointComparisons([{ y: 2026, m: 0 }, { y: 2026, m: 2 }, { y: 2026, m: 3 }], [row('001', 'P1', [100, 100, 40])], now);
  assert.equal(holes.get(2026 * 12 + 3).comparisons.previous.available, true); assert.equal(holes.get(2026 * 12 + 3).comparisons.median3.available, false);
  const negative = indexPointComparisons(months.slice(12, 16), [row('001', 'P1', [100, 100, 100, 40]), row('001', 'P1', [0, 0, 0, -1])], now);
  assert.equal(negative.get(2026 * 12 + 3).available, false);
});

test('legacy timestamps never attach first measurement parameters to the final timestamp', () => {
  const legacy = signal(); delete legacy.months[0].observations; legacy.months[0].last = '2026-06-20T12:00:00';
  const observations = electricalObservations(sample([legacy]));
  assert.equal(observations.length, 2); assert.equal(observations[0].timestampDetailExact, false);
  assert.match(observations[0].detail, /Сводка/); assert.doesNotMatch(observations[1].detail, /P=-0,5/); assert.match(observations[1].detail, /недоступны/);
  const undated = { ...signal(), first: null, last: null, months: [] };
  assert.ok(!direct({ meters: [sample([undated])] }).cases.some(item => item.scenario === 'combined'));
});

test('chart timestamps carry their own measured parameters and never reuse the first values for the last point', () => {
  const exact = signal(); exact.months[0].last = '2026-06-20T12:00:00';
  exact.months[0].observations.push({ at: '2026-06-20T12:00:00', detail: 'P=-0,8 кВт; I=3 А' });
  const service = createAnalysisService(indexMonthly({ months, rows: [row('001', 'P1', values({ '2026-06': 40 }))], warnings: [] }), [record()], { instant: instant([sample([exact])]) });
  const markers = service.consumer('001', {}).result.journal.events;
  assert.match(markers[0].description, /P=-0,5/); assert.match(markers[1].description, /P=-0,8/); assert.doesNotMatch(markers[1].description, /P=-0,5/);
  assert.equal(markers[1].timestampDetailExact, true);
});

test('different PUs of one LS or a different TU cannot supply each other’s evidence or consumption decrease', () => {
  const first = row('001', 'P1'), second = row('001', 'P2', values({ '2026-06': 40 })), records = [record(), record('000456', '001', 'P2')];
  const service = createAnalysisService(indexMonthly({ months, rows: [first, second], warnings: [] }), records, { instant: instant(), events: eventPack([event(undefined, '000456')]) });
  const result = service.consumer('001', {}).result;
  assert.ok(!result.journal.cases.some(item => item.scenario === 'combined'));
  const drop = result.journal.cases.find(item => item.scenario === 'event_drop'); assert.equal(drop.serial, '000456'); assert.equal(drop.value, 40); assert.equal(drop.point.label, 'СТЕК P2');
  const samePUhealthy = createAnalysisService(indexMonthly({ months, rows: [first, second], warnings: [] }), records, { instant: instant(), events: eventPack() }).consumer('001', {}).result;
  assert.ok(!samePUhealthy.journal.cases.some(item => item.scenario === 'combined')); assert.equal(samePUhealthy.journalPriority, 'check');
  assert.equal(samePUhealthy.journal.cases[0].scenario, 'journals_only');
});

test('same TU with two PUs retains independent single-journal cases and one LS volume in the report', () => {
  const rows = [row('001', 'P1', values({ '2026-06': 40 }))], records = [record(), record('000456')];
  const model = indexMonthly({ months, rows, warnings: [] }), service = createAnalysisService(model, records, { instant: instant(), events: eventPack([event(undefined, '000456')]) });
  const result = service.consumer('001', {}).result;
  assert.ok(!result.journal.cases.some(item => item.scenario === 'combined')); assert.deepEqual(new Set(result.journal.cases.map(item => item.scenario)), new Set(['electrical_drop', 'event_drop']));
  assert.equal(service.report({}).rows.length, 1); assert.equal(service.report({}).rows[0].result.total, 2040);
});

test('repeated supporting months score one episode once while raw evidence remains available', () => {
  const rows = [row('001', 'P1', values({ '2026-06': 40, '2026-07': 40, '2026-08': 40 }))];
  const service = createAnalysisService(indexMonthly({ months, rows, warnings: [] }), [record()], { instant: instant(), events: eventPack() });
  const result = service.consumer('001', {}).result;
  assert.equal(result.journalScore, 25); assert.equal(result.journal.cases.filter(item => item.scenario === 'combined').reduce((sum, item) => sum + item.months.length, 0), 3);
  for (const source of ['instant', 'events']) { const flag = result.flags.find(flag => flag.source === source); assert.equal(flag.pts, 0); assert.equal(flag.supportingEvidence, true); }
  assert.ok(service.report({}).rows[0].reasons.some(reason => /P=-0,5/.test(reason)));
});

test('cached selected-TU and full-LS monthly supports stay independent across subsequent requests', () => {
  const longMonths = Array.from({ length: 27 }, (_, i) => ({ y: 2024 + Math.floor((i + 5) / 12), m: (i + 5) % 12 }));
  const own = row('001', 'P1', [...Array(12).fill(1000), ...Array(15).fill(200)]), other = row('001', 'P2', Array(27).fill(100));
  const at = '2025-09-05T12:00:00', model = indexMonthly({ months: longMonths, rows: [own, other], warnings: [] });
  const service = createAnalysisService(model, [record(), record('000456', '001', 'P2')], { instant: instant([sample([signal(at)])]), events: eventPack([event('2025-09-06T12:00:00')]) });
  const selected = service.consumer('001', {}, null, { point: 'P1' }).result, before = JSON.stringify(selected.journal.cases);
  assert.ok(selected.journal.cases.some(item => item.supportingMonthlyFlags.some(flag => flag.code === 'S3' && flag.scope === 'ЛС + ТУ')));
  const all = service.consumer('001', {}).result;
  assert.ok(all.journal.cases.some(item => item.supportingMonthlyFlags.some(flag => flag.scope === 'ЛС, все ТУ (контекст)')));
  assert.equal(JSON.stringify(service.consumer('001', {}, null, { point: 'P1' }).result.journal.cases), before);
  assert.notEqual(all.journal.cases[0], selected.journal.cases[0]);
});

test('10,000 ordinary loaded PUs allocate no month comparisons or cases', () => {
  const count = 10000, rows = Array.from({ length: count }, (_, i) => row(String(i), 'P' + i)), records = rows.map((r, i) => record('M' + i, r.account, r.point));
  const meters = records.map(r => sample([], r.fields.meter, { at: '2026-06-05T12:00:00', values: [0.5, 230, 2] }));
  const analysis = createJournalAnalysis(indexMonthly({ rows, months, warnings: [] }), records, { instant: instant(meters) });
  assert.equal(analysis.reportCases(new Set(rows.map(r => r.account))).length, 0);
  assert.equal(analysis.stats.correlation.comparisonBuilds, 0); assert.equal(analysis.stats.correlation.comparisonMonths, 0); assert.equal(analysis.stats.correlation.skippedWithoutCandidates, count);
});

test('rich comparison data is limited to requested candidate months', () => {
  const n = 2026 * 12 + 5, indexed = indexPointComparisons(months, [row('001', 'P1', values({ '2026-06': 40 }))], now, [n]);
  assert.equal(indexed.size, 1); assert.equal(indexed.get(n).comparisons.yearAgo.value, 100);
  const { service } = direct(); assert.equal(service.stats.comparisonMonths, 4);
});
