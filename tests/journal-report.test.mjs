import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { indexMonthly } from '../public/monthly.js';
import { createAnalysisService } from '../public/analysis-service.js';
import { createJournalAnalysis } from '../public/journal-analysis.js';
import { TUNE_DEFS } from '../public/analysis-engine.js';
import { buildJournalWorkbook, planJournalWorkbooks } from '../public/journal-report.js';
import { buildAnomalyWorkbookPart } from '../public/anomaly-report.js';
import { instantFindingLines, journalReportSheet } from '../public/journal-report-data.js';
import { readJournalWorkbook } from '../public/journals.js';
import { idKey } from '../public/core.js';

const months = Array.from({ length: 21 }, (_, i) => ({ y: 2025 + Math.floor(i / 12), m: i % 12 }));
const allOff = { algOff: Object.fromEntries(Object.keys(TUNE_DEFS).map(key => [key, true])) };
const row = (account, point, values = months.map((_, i) => 123 + i % 3)) => ({ account, accountKey: idKey(account), point, pointNumber: '', pointName: '', values, source: 'Учебный ПО:5', name: 'Учебный потребитель', tp: 'ТП-1' });
const record = (meter, account, point) => ({ fields: { meter, account, point, power: '15', tp: 'ТП-1' } });
const signal = (extra = {}) => ({ code: 'J31_REVERSE', title: 'Обратная активная мощность', detail: 'Фаза 1: P=-0,5 кВт, I=2 А', recommendation: 'Проверить полярность.',
  count: 2, first: '2026-04-03T09:00:00', last: '2026-04-04T09:00:00', months: [{ month: '2026-04', count: 2, first: '2026-04-03T09:00:00', last: '2026-04-04T09:00:00',
    observations: [{ at: '2026-04-03T09:00:00', detail: 'Фаза 1: P=-0,5 кВт, I=2 А' }, { at: '2026-04-04T09:00:00', detail: 'Фаза 1: P=-0,9 кВт, I=3 А' }] }], ...extra });
const instant = (entries) => ({ format: 1, role: 'instant', analysisVersion: 2, fields: ['active1'], meters: entries.map(([serial, signals]) => ({ serial, samples: 2, first: '2026-04-03T09:00:00', last: '2026-04-04T09:00:00', signals })), warnings: [] });
const events = rows => ({ format: 1, role: 'events', rows, warnings: [] });
const opening = 'Вскрытый элемент устройства "Клеммная крышка"';
const make = (rows, records, journals) => createAnalysisService(indexMonthly({ rows, months, warnings: [] }), records, journals);
const context = { res: { name: 'Учебный РЭС' }, generatedAt: '2026-10-11T21:30:00Z' };
const sheetRows = book => XLSX.utils.sheet_to_json(book.Sheets['Флаги журналов'], { header: 1, range: 5 });
const xml = (bytes, path) => {
  const archive = XLSX.CFB.read(bytes, { type: 'array' }), index = archive.FullPaths.findIndex(value => value.endsWith('/' + path));
  assert.ok(index >= 0); return new TextDecoder().decode(archive.FileIndex[index].content);
};

test('journal selection includes green, zero and unmatched PUs but excludes normal journals and monthly-only flags', async () => {
  const rows = [row('001', 'P1'), row('002', 'P2', months.map(() => 0)), row('003', 'P3', months.map((_, i) => i < 12 ? 1000 : 100)), row('004', 'P4')];
  const records = rows.map((r, i) => record('000' + (i + 1), r.account, r.point));
  const service = make(rows, records, { instant: instant([['0001', [signal()]], ['0004', []], ['0999', [signal()]]]), events: events([
    ['0002', '2026-04-03T10:00:00', opening], ['0004', '2026-04-03T10:00:00', 'Успешный сеанс связи'],
  ]) });
  const report = await service.journalReportAsync(allOff);
  assert.deepEqual(report.rows.map(r => r.serial).sort(), ['0001', '0002', '0999']);
  assert.equal(report.rows.find(r => r.serial === '0001').consumption.cls, 'green');
  assert.equal(report.rows.find(r => r.serial === '0002').consumption.cls, 'dead');
  assert.equal(report.rows.find(r => r.serial === '0999').consumption, null);
  const sheet = journalReportSheet(report, context), unresolved = report.rows.findIndex(r => r.serial === '0999');
  assert.match(sheet.rows.at(unresolved).cells[3], /отсутствует в реестре/);
  assert.equal(report.counts.selected, 3);
});

test('consumption findings belong to the PU own TU, and never a different point on the same account', async () => {
  const declining = months.map((_, i) => i < 12 ? 1000 : 100), rows = [row('001', 'P1'), row('001', 'P2', declining)];
  const service = make(rows, [record('0001', '001', 'P1'), record('0002', '001', 'P2')], { instant: instant([['0001', [signal()]], ['0002', [signal()]]]) });
  const report = await service.journalReportAsync({});
  for (const serial of ['0001', '0002']) {
    const expected = service.consumer('001', {}, null, { point: serial === '0001' ? 'P1' : 'P2' }).result;
    assert.deepEqual(report.rows.find(r => r.serial === serial).consumption.flags.filter(f => !f.source).map(f => [f.code, f.title]), expected.flags.filter(f => !f.source).map(f => [f.code, f.title]));
  }
  assert.ok(report.rows.find(r => r.serial === '0002').consumption.flags.some(f => ['S3', 'S14'].includes(f.code)));
  assert.ok(!report.rows.find(r => r.serial === '0001').consumption.flags.some(f => ['S3', 'S14'].includes(f.code)));
});

test('a journal-led drop retains previous-month and year-ago comparisons with monthly algorithms off', async () => {
  const values = months.map(() => 150); values[15] = 40; values[16] = 40;
  const service = make([row('001', 'P1', values)], [record('0001', '001', 'P1')], { instant: instant([['0001', [signal()]]]), events: events([['0001', '2026-04-03T10:00:00', opening]]) });
  const report = await service.journalReportAsync(allOff), flag = report.rows[0].consumption.flags.find(f => f.source === 'correlation');
  assert.ok(flag); assert.equal(report.rows[0].consumption.cls, 'green');
  assert.equal(flag.detail, ''); assert.equal(flag.comparison.comparisons.yearAgo.value, 150);
  const text = journalReportSheet(report, context).rows.at(0).cells[3];
  assert.match(text, /Предыдущий месяц: 150 кВт·ч; снижение 73,3%/);
  assert.match(text, /Тот же месяц прошлого года: 150/); assert.match(text, /порядок изменений внутри месяца неизвестен/);
  assert.doesNotMatch(text, /участвующих месячных группах|все объёмы и сравнения представлены/);
});

test('recognized 46 categories combine repeated monthly groups without raw descriptions or independent-opening claims', async () => {
  const journals = { events: { format: 1, role: 'events', aggregationVersion: 1, groups: [
    { serial: '0001', month: '2026-04', codes: ['J46_TERMINAL_COVER', 'J46_CASE'], count: 600000, first: '2026-04-01T00:00:00', last: '2026-04-30T23:55:00', days: [], examples: [{ at: '2026-04-01T00:00:00', description: opening + ' RAW_NOT_FOR_REPORT' }] },
    { serial: '0001', month: '2026-05', codes: ['J46_TERMINAL_COVER'], count: 5, first: '2026-05-01T00:00:00', last: '2026-05-01T00:20:00', days: [], examples: [] },
  ], warnings: [] } };
  const service = make([row('001', 'P1')], [record('0001', '001', 'P1')], journals), report = await service.journalReportAsync(allOff);
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].eventFlags.find(f => f.code === 'J46_TERMINAL_COVER').count, 600005);
  const sheet = journalReportSheet(report, context);
  assert.match(sheet.rows.at(0).cells[1], /04\.2026: 600000; 05\.2026: 5/);
  assert.match(sheet.rows.at(0).cells[1], /Вскрытие корпуса/);
  assert.doesNotMatch(JSON.stringify(report), /RAW_NOT_FOR_REPORT|days|examples/);
});

test('31 comments use actual first and last anomalous measurements and mark conditional/profile observations', () => {
  const text = instantFindingLines(signal({ conditional: true, informational: true })).join('\n');
  assert.match(text, /Условное наблюдение/); assert.match(text, /03\.04\.2026 09:00:00.*P=-0,5/); assert.match(text, /04\.04\.2026 09:00:00.*P=-0,9/);
  assert.match(text, /04\.2026: 2/);
  const profile = instantFindingLines(signal({ timestampBasis: 'report_period', detail: 'Период профиля: 01.01.2026 — 31.03.2026; A− максимум=2 кВт', months: [], first: null, last: null }));
  assert.match(profile.join(' '), /Период профиля.*максимум=2/); assert.doesNotMatch(profile.join(' '), /Регистраций|измерение|04\.2026/);
});

test('actual parser checks phase currents, neutral, P/Q/S and U-I angles before adding report comments', async () => {
  const header = ['Серийный', 'Время', 'Напряжение на фазе 1, В', 'Напряжение на фазе 2, В', 'Напряжение на фазе 3, В', 'Ток в фазе 1, А', 'Ток в фазе 2, А', 'Ток в фазе 3, А', 'Ток в нулевом проводе, А', 'Активная мощность, фаза 1, кВт', 'Реактивная мощность, фаза 1, кВАр', 'Полная мощность, фаза 1, кВА', 'Коэффициент мощности по фазе 1 cos(f)', 'Угол между векторами U I, фазы A, град'];
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, ['0001', '03.04.2026 09:00:00', 230, 230, 230, 2, 2, 0, 10, .8, .6, 1, .8, 85]]), '31');
  const pack = readJournalWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' }), XLSX, 'instant');
  const codes = pack.meters[0].signals.map(s => s.code);
  for (const code of ['J31_NEUTRAL', 'J31_MISSING_CURRENT', 'J31_VECTOR_ANGLE']) assert.ok(codes.includes(code), code);
  const service = make([row('001', 'P1')], [record('0001', '001', 'P1')], { instant: pack }), report = await service.journalReportAsync(allOff), text = journalReportSheet(report, context).rows.at(0).cells[2];
  assert.match(text, /Iн=10/); assert.match(text, /85/); assert.match(text, /Условное наблюдение/);
});

test('four-column XLSX preserves PU text, evidence, missing-source distinctions and formula safety', async () => {
  const service = make([row('001', 'P1')], [record('0001', '001', 'P1')], { instant: instant([['0001', [signal()]], ['=1+1', [signal()]]]) });
  const report = await service.journalReportAsync(allOff), bytes = buildJournalWorkbook(report, XLSX, context), book = XLSX.read(bytes, { type: 'array', cellStyles: true });
  assert.deepEqual(book.SheetNames, ['Флаги журналов']);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Флаги журналов'], { header: 1, range: 4 })[0], ['Номер ПУ', 'Журнал 46 · события и комментарии', 'Журнал 31 · параметры и комментарии', 'Замечания к потреблению']);
  const table = sheetRows(book), matched = table.find(r => r[0] === '0001');
  assert.equal(matched[1], 'Журнал не загружен'); assert.match(matched[2], /P=-0,9/); assert.match(matched[3], /Претензий.*не выявлено/);
  assert.ok(table.some(r => r[0] === '=1+1'));
  assert.doesNotMatch(xml(bytes, 'xl/worksheets/sheet1.xml'), /<f[ >]/);
  assert.match(xml(bytes, 'xl/worksheets/sheet1.xml'), /xSplit="1".*ySplit="5"/);
  assert.match(xml(bytes, 'xl/worksheets/sheet1.xml'), /autoFilter ref="A5:D7"/);
  assert.equal(book.Sheets['Флаги журналов'].A6.z, '@');
  assert.match(book.Sheets['Флаги журналов'].A3.v, /12\.10\.2026.*МСК/);
});

test('unrecognized 46 rows and normal 31 readings are clearly different from missing sources', () => {
  const report = { coverage: { events: { loaded: true }, instant: { loaded: true } }, rows: [
    { serial: '0001', eventFlags: [{ title: 'Вскрытие корпуса', count: 1 }], instantFlags: [], eventsPresent: true, instantPresent: true },
    { serial: '0002', eventFlags: [], instantFlags: [signal()], eventsPresent: false, instantPresent: true },
  ] };
  const sheet = journalReportSheet(report, context);
  assert.equal(sheet.rows.at(0).cells[2], 'Признаки не выявлены'); assert.equal(sheet.rows.at(1).cells[1], 'Записей по этому ПУ нет');
});

test('journal export yields and cancels without changing monthly analysis, including ambiguous serials', async () => {
  const rows = Array.from({ length: 110 }, (_, i) => row('A' + i, 'P' + i)), records = rows.map((r, i) => record('M' + i, r.account, r.point));
  const service = make(rows, records, { instant: instant(records.map(r => [r.fields.meter, [signal()]])) }), before = service.consumer('A0', {}).result, progress = [];
  const report = await service.journalReportAsync({}, { onProgress: p => progress.push(p.done) });
  assert.equal(report.rows.length, 110); assert.deepEqual(progress, [0, 50, 100]); assert.deepEqual(service.consumer('A0', {}).result, before);
  let checks = 0; await assert.rejects(service.journalReportAsync({}, { assertCurrent() { if (++checks === 2) throw new Error('Отменено'); } }), /Отменено/);
  const ambiguous = make([row('001', 'P1'), row('002', 'P2')], [record('0001', '001', 'P1'), record('0001', '002', 'P2')], { instant: instant([['0001', [signal()]]]) });
  const unresolved = await ambiguous.journalReportAsync({}); assert.equal(unresolved.rows[0].consumption, null); assert.match(unresolved.rows[0].mappingReason, /несколькими ЛС/);
});

test('bounded multipart journal reports preserve every flagged PU exactly once', async () => {
  const report = { coverage: { instant: { loaded: true }, events: { loaded: false } }, rows: Array.from({ length: 40 }, (_, i) => ({ serial: String(i).padStart(8, '0'), instantFlags: [signal()], eventFlags: [], instantPresent: true, eventsPresent: false })) };
  const plan = await planJournalWorkbooks(report, context, { maxBytes: 17000 }), serials = [];
  assert.ok(plan.parts.length > 1); assert.equal(plan.count, 40);
  for (let index = 0; index < plan.parts.length; index++) {
    assert.ok(plan.parts[index].xmlBytes <= 17000);
    const book = XLSX.read(buildAnomalyWorkbookPart(plan, index, XLSX), { type: 'array' });
    serials.push(...sheetRows(book).map(r => r[0]));
  }
  assert.deepEqual(serials, report.rows.map(r => r.serial)); assert.equal(new Set(serials).size, 40);
  await assert.rejects(planJournalWorkbooks(report, context, { assertCurrent() { throw new Error('Данные изменились'); } }), /Данные изменились/);
});

test('a source-free journal export is unavailable and a recognized-empty source yields an empty report', async () => {
  await assert.rejects(make([row('001', 'P1')], [], {}).journalReportAsync({}), /загрузите журнал/);
  assert.equal((await make([row('001', 'P1')], [], { instant: instant([['0001', []]]) }).journalReportAsync({})).rows.length, 0);
  const model = indexMonthly({ rows: [], months: [], warnings: [] });
  const findings = [...createJournalAnalysis(model, [], { instant: instant([['0001', [signal()]]]) }).flaggedMeters()];
  assert.equal(findings.length, 1); assert.equal(findings[0].binding, undefined);
});

test('journal planning retains lazy row views and formats no unrelated parts when downloading', async () => {
  const report = { coverage: { instant: { loaded: true } }, rows: Array.from({ length: 25 }, (_, i) => ({ serial: String(i).padStart(6, '0'), instantFlags: [signal()], eventFlags: [] })) };
  const sheet = journalReportSheet(report, context);
  assert.equal(Array.isArray(sheet.rows), false); assert.equal(sheet.rows.length, 25); assert.equal(sheet.rows[0], undefined);
  const plan = await planJournalWorkbooks(report, context, { maxBytes: 17000 });
  assert.ok(plan.parts.length > 1);
  assert.ok(plan.parts.every(part => !Array.isArray(part.sheets[0].rows) && part.sheets[0].rows[0] === undefined));
  const book = XLSX.read(buildAnomalyWorkbookPart(plan, 1, XLSX), { type: 'array' });
  assert.equal(sheetRows(book).length, plan.parts[1].count);
  assert.equal(sheetRows(book)[0][0], plan.parts[1].sheets[0].rows.at(0).cells[0]);
});
