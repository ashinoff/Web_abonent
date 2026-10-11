import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMonthly } from '../public/monthly.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { correlateJournalMonths } from '../public/journal-analysis.js';
import { TUNE_DEFS } from '../public/analysis-engine.js';
import { flagObservation } from '../public/analysis-observations.js';

const months = Array.from({ length: 9 }, (_, m) => ({ y: 2026, m }));
const row = (account = '001', point = 'P1', values = [100, 100, 100, 40, 100, 100, 100, 100, 100], tp = 'ТП-1') => ({ account, accountKey: account, point, pointNumber: '', pointName: '', tp, values, name: 'Учебный потребитель', source: 'ПО:5' });
const record = (meter = '000123', account = '001', point = 'P1') => ({ fields: { meter, account, point, power: '15', tp: 'ТП-1', name: 'Учебный потребитель' }, address: 'Учебная улица, 1', file: 'Реестр.xlsx', sheet: 'Реестр', row: 5 });
const opening = 'Вскрытый элемент устройства "Клеммная крышка"';
const eventBook = (rows = [['000123', '2026-04-05T10:30:00', opening]]) => ({ format: 1, role: 'events', rows, warnings: [] });
const instantBook = signals => ({ format: 1, role: 'instant', fields: ['active1', 'voltage1', 'current1'], coefficientMode: 'secondary', meters: [{ serial: '000123', samples: 2, datedSamples: 2, first: '2026-04-03T09:00:00', last: '2026-04-04T09:00:00', latest: { at: '2026-04-04T09:00:00', values: { active1: -0.5, voltage1: 230, current1: 2 } }, signals }], warnings: [] });
const electrical = { code: 'J31_REVERSE', title: 'Обратное направление активной мощности', count: 2, first: '2026-04-03T09:00:00', last: '2026-04-04T09:00:00', detail: 'P=-0,5 кВт; I=2 А', recommendation: 'Проверить полярность.', months: [{ month: '2026-04', count: 2, first: '2026-04-03T09:00:00', last: '2026-04-04T09:00:00', detail: 'P=-0,5 кВт' }] };
const make = (rows = [row()], records = [record()], journals = {}) => createAnalysisService(indexMonthly({ rows, months, warnings: [] }), records, journals);
const allOff = { algOff: Object.fromEntries(Object.keys(TUNE_DEFS).map(key => [key, true])) };

test('absent journals retain the exact monthly result and missing source reporting', () => {
  const a = make().consumer('001', {}).result, b = make([row()], [record()], { instant: null, events: null }).consumer('001', {}).result;
  assert.deepEqual(a, b); assert.equal(a.journal, undefined);
  const report = make().report({}); assert.equal(report.coverage.instant.loaded, false); assert.equal(report.coverage.events.loaded, false);
});

test('event correlation preserves monthly class, score and loss and never creates instantaneous energy loss', () => {
  const before = make().consumer('001', {}).result;
  const after = make([row()], [record()], { events: eventBook(), instant: instantBook([electrical]) }).consumer('001', {}).result;
  assert.equal(after.score, before.score); assert.equal(after.cls, before.cls); assert.equal(after.lossKwh, before.lossKwh);
  assert.equal(after.monthlyScore, before.score); assert.equal(after.journalPriority, 'high');
  assert.ok(after.flags.some(f => f.code === 'J46_TERMINAL_COVER'));
  assert.ok(after.flags.some(f => f.code === 'J31_REVERSE' && /P=-0,5/.test(f.detail)));
  const correlation = after.flags.find(f => f.code === 'J_CORRELATION'); assert.match(correlation.detail, /снижение 60%/); assert.match(correlation.detail, /совпадение в пределах месяца/);
  assert.equal(after.journal.latestMetrics[0].values.current1, 2); assert.equal(after.journal.events.length, 3);
});

test('serial matching keeps leading zeroes; repeated registry entries of the same LS and TU are safe', () => {
  const safe = make([row()], [record(), record()], { events: eventBook() }).consumer('001', {}).result;
  assert.ok(safe.flags.some(f => f.source === 'events')); assert.equal(safe.journal.events.length, 1);
  const different = make([row()], [record('123')], { events: eventBook() });
  assert.equal(different.consumer('001', {}).result.journal.events.length, 0); assert.equal(different.report({}).unmatched.events.meters, 1);
  assert.equal(different.report({}).events.length, 1); assert.equal(different.report({}).events[0].account, ''); assert.match(different.report({}).events[0].mappingReason, /отсутствует в реестре/);
});

test('a serial attached to several accounts or points is never attributed to any consumer', () => {
  for (const records of [[record(), record('000123', '002', 'P2')], [record(), record('000123', '001', 'P2')]]) {
    const service = make([row(), row('002', 'P2'), row('001', 'P2')], records, { events: eventBook() });
    assert.equal(service.consumer('001', {}).result.journal.events.length, 0);
    assert.equal(service.consumer('002', {}).result.journal.events.length, 0);
    assert.equal(service.report({}).unmatched.events.meters, 1);
    assert.match(service.report({}).unmatched.events.reasons[0].reason, /несколькими ЛС или ТУ/);
  }
});

test('missing point identifiers and compatible but nonunique monthly points do not bind a journal', () => {
  const noPoint = make([row()], [record('000123', '001', '')], { events: eventBook() });
  assert.equal(noPoint.consumer('001', {}).result.journal.events.length, 0);
  const records = [record('000123', '001', 'P1')], rows = [{ ...row(), pointNumber: '1' }, { ...row(), pointNumber: '2' }];
  const ambiguous = make(rows, records, { events: eventBook() });
  assert.equal(ambiguous.consumer('001', {}).result.journal.events.length, 0);
  assert.match(ambiguous.report({}).unmatched.events.reasons[0].reason, /нескольким точкам/);
});

test('TU and TP selections include only their serials while an account report sums all TU volumes once', () => {
  const rows = [row(), row('001', 'P2', Array(9).fill(20), 'ТП-2')];
  const records = [record(), { ...record('000456', '001', 'P2'), fields: { ...record('000456', '001', 'P2').fields, tp: 'ТП-2' } }];
  const journals = { events: eventBook([['000123', '2026-04-05T10:30:00', opening], ['000456', '2026-04-06T10:30:00', opening]]) };
  const service = make(rows, records, journals);
  assert.equal(service.consumer('001', {}, null, { point: 'P1' }).result.journal.eventCount, 1);
  assert.equal(service.consumer('001', {}, 'ТП-1').result.journal.eventCount, 1);
  const report = service.report({}); assert.equal(report.rows.length, 1); assert.equal(report.rows[0].result.total, 1020);
  assert.deepEqual(report.rows[0].serials, ['000123', '000456']); assert.equal(report.events.length, 2); assert.equal(report.rows[0].scope, 'ЛС, все ТУ');
});

test('closings and unclassified descriptions remain available without creating intrusion flags', () => {
  const journals = { events: eventBook([['000123', '2026-04-05T10:30:00', 'Клеммная крышка закрыта'], ['000123', '2026-04-06T10:30:00', 'Синхронизация времени']]) };
  const result = make([row()], [record()], journals).consumer('001', {}).result;
  assert.equal(result.journal.events.length, 2); assert.equal(result.journal.recognizedEvents, 0); assert.equal(result.journalPriority, 'none');
  assert.ok(!result.flags.some(f => f.source));
});

test('a compound C/F/J event creates all active category flags and one original report row', () => {
  const description = `${opening}\nВскрытый элемент устройства "Магнитная пломба постоянного поля"`;
  const service = make([row()], [record()], { events: eventBook([['000123', '2026-04-05T10:30:00', description]]) });
  const result = service.consumer('001', {}).result;
  assert.ok(result.flags.some(f => f.code === 'J46_TERMINAL_COVER'));
  assert.ok(result.flags.some(f => f.code === 'J46_MAGNET_DC'));
  assert.equal(result.journal.events.length, 1); assert.equal(service.report({}).events.length, 1);
  assert.equal(service.report({}).events[0].description, description);
});

test('informational asymmetry and low power factor alone do not select consumers or correlate a drop', () => {
  const signals = [{ ...electrical, code: 'J31_UNBALANCE', title: 'Несимметрия токов', informational: true }, { ...electrical, code: 'J31_PF', title: 'Низкий коэффициент мощности', informational: true }];
  const service = make([row()], [record()], { instant: instantBook(signals) });
  const result = service.consumer('001', allOff).result;
  assert.equal(result.journalPriority, 'none'); assert.equal(result.journalScore, 0); assert.ok(!result.flags.some(f => f.source === 'correlation'));
  assert.equal(service.report(allOff).rows.length, 0);
});

test('out of period dates and missing measurement timestamps cannot create temporal correlations', () => {
  const undated = { ...electrical, first: null, last: null, months: [] };
  const result = make([row()], [record()], { instant: instantBook([undated]), events: eventBook([['000123', '2025-04-05T10:30:00', opening]]) }).consumer('001', {}).result;
  assert.equal(result.journal.outsidePeriod, 1); assert.ok(!result.flags.some(f => f.source === 'correlation')); assert.equal(result.journalPriority, 'check');
});

test('correlation requires an elapsed month, three consecutive complete positive months and a baseline of at least 30 kWh', () => {
  const markers = [{ at: '2026-04-10T12:00:00' }], now = new Date('2026-05-01T00:00:00Z');
  assert.equal(correlateJournalMonths(months, row().values, markers, now).length, 1);
  assert.equal(correlateJournalMonths(months, row().values, markers, new Date('2026-04-30T12:00:00Z')).length, 0);
  assert.equal(correlateJournalMonths(months, row().values, markers, new Date('2026-04-30T21:00:00Z')).length, 1);
  for (const values of [[100, null, 100, 40], [100, 0, 100, 40], [20, 20, 20, 5], [100, 100, 100, null], [100, 100, 100, -10], [100, 100, 100, 51]]) {
    assert.equal(correlateJournalMonths(months, values, markers, now).length, 0);
  }
});

test('compact parser arrays are normalized for UI metrics and incomplete totals are explicit', () => {
  const book = instantBook([electrical]); book.meters[0].latest.values = [-0.5, 230, 2];
  const rows = [{ ...row(), values: [100, null, 100, 40, 100, 100, 100, 100, 100] }];
  const service = make(rows, [record()], { instant: book });
  assert.equal(service.consumer('001', {}).result.journal.latestMetrics[0].values.current1, 2);
  assert.equal(service.report({}).totals.consumption, null); assert.equal(service.report({}).totals.observedConsumption, 740);
});

test('latest metrics are capped in the card but the report retains every PU of a selected account', () => {
  const records = Array.from({ length: 55 }, (_, i) => record(String(i).padStart(6, '0')));
  const book = instantBook([]); book.reportPeriod = { from: '2026-04-01', to: '2026-04-30' };
  book.meters = records.map(record => ({ ...book.meters[0], serial: record.fields.meter, latest: { at: '2026-04-04T09:00:00', values: [0.5, 230, 2] } }));
  const service = make([row()], records, { instant: book, events: eventBook([['000000', '2026-04-05T10:30:00', opening]]) });
  const result = service.consumer('001', {}).result;
  assert.equal(result.journal.latestMetrics.length, 50); assert.equal(result.journal.latestMetricCount, 55); assert.equal(result.journal.latestMetricsTruncated, true);
  const report = service.report({}); assert.equal(report.metrics.length, 55); assert.equal(report.metrics[54].values.current1, 2); assert.equal(report.metrics[54].account, '001'); assert.deepEqual(report.metrics[54].reportPeriod, book.reportPeriod);
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].result.total, 840);
});

test('chart event display is bounded while report retains every original event', () => {
  const events = Array.from({ length: 601 }, (_, n) => ['000123', `2026-04-05T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`, opening]);
  const service = make([row()], [record()], { events: eventBook(events) });
  const result = service.consumer('001', {}).result;
  assert.equal(result.journal.events.length, 500); assert.equal(result.journal.eventCount, 601); assert.equal(result.journal.displayTruncated, true);
  assert.equal(service.report({}).events.length, 601); assert.equal(service.report({}).rows.length, 1);
});

test('unknown and stopped monthly histories keep their classes and report concrete data reasons', () => {
  for (const [values, cls, reason] of [[Array(9).fill(null), 'unknown', /недостаточно данных/], [Array(9).fill(0), 'dead', /не превышают 3/]]) {
    const service = make([row('001', 'P1', values)], [record()], { events: eventBook() });
    const result = service.consumer('001', {}).result;
    assert.equal(result.cls, cls); assert.equal(result.monthlyCls, cls); assert.equal(result.journalPriority, 'check');
    assert.ok(service.report({}).rows[0].reasons.some(text => reason.test(text)));
  }
});

test('report lists high priority first independently of input order without changing volumes or reasons', () => {
  const rows = [row('001', 'P1'), row('002', 'P2')], records = [record(), record('000456', '002', 'P2')];
  const journals = { events: eventBook([['000456', '2026-04-05T10:30:00', opening]]) };
  const forward = make(rows, records, journals).report({}), reverse = make([...rows].reverse(), [...records].reverse(), journals).report({});
  assert.deepEqual(forward.rows.map(row => row.account), ['002', '001']);
  assert.deepEqual(reverse.rows.map(row => row.account), ['002', '001']);
  assert.equal(forward.rows[0].result.journalPriority, 'high');
  assert.deepEqual(forward.rows.map(row => ({ account: row.account, total: row.result.total, reasons: row.reasons })), reverse.rows.map(row => ({ account: row.account, total: row.result.total, reasons: row.reasons })));
  assert.equal(forward.rows[0].result.total, 840); assert.equal(forward.rows[1].result.total, 840);
});

test('report reasons retain measured monthly changes and omit detector speculation without changing its flags', () => {
  const longMonths = Array.from({ length: 27 }, (_, i) => ({ y: 2024 + Math.floor((i + 5) / 12), m: (i + 5) % 12 }));
  const values = [...Array(12).fill(1000), ...Array(15).fill(200)];
  const service = createAnalysisService(indexMonthly({ months: longMonths, rows: [{ ...row(), values }], warnings: [] }), [record()]);
  const original = service.consumer('001', {}).result, report = service.report({});
  const step = original.flags.find(flag => flag.code === 'S3'); assert.ok(step); assert.match(step.detail, /Классика вмешательства/);
  const reason = report.rows[0].reasons.find(reason => reason.startsWith(step.title));
  assert.match(reason, /расход ступенью упал/); assert.match(reason, /1\s000/); assert.match(reason, /200/);
  assert.doesNotMatch(report.rows[0].reasons.join(' '), /Классика|обвод|на глаз/);
  assert.equal(report.rows[0].result.score, original.score); assert.equal(report.rows[0].result.lossKwh, original.lossKwh); assert.deepEqual(report.rows[0].result.flags, original.flags);
});

test('shared factual descriptions preserve full journal evidence and factual monthly tuning wording', () => {
  const journalDetail = 'ПУ 000123: I=2 А. Первое: 2026-04-03T09:00:00. Последнее: 2026-04-04T09:00:00.';
  for (const source of ['instant', 'events', 'correlation']) assert.equal(flagObservation({ source, detail: journalDetail }), journalDetail);
  assert.equal(flagObservation({ code: 'S7', detail: '80% значений кратны 50 — показания передаются «на глаз», без реального съёма. Повод для контрольного обхода.' }), '80% значений кратны 50 — преобладают округлённые объёмы');
  assert.equal(flagObservation({ code: 'S8', detail: 'Средний расход 100 кВт·ч/мес — ниже 30% медианы группы (500). Само по себе — слабый признак.' }), 'Средний расход 100 кВт·ч/мес — ниже настроенного порога группы (500)');
});
