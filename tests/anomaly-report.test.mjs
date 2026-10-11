import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { buildAnomalyWorkbook, planAnomalyWorkbooks, buildAnomalyWorkbookPart } from '../public/anomaly-report.js';

const monthlyFlag = { code: 'S3', title: 'Ступенчатое падение', pts: 12,
  detail: 'Расход упал с 900 до 120 кВт·ч/мес., снижение 87%. Классика вмешательства: магнит, шунт, обвод.' };
const openingFlag = { code: 'J46_TERMINAL_COVER', title: 'Вскрытие клеммной крышки', source: 'events', serial: '00001001',
  count: 7000, first: '2026-02-01T10:15:00', last: '2026-02-28T11:00:00', detail: 'RAW_DESCRIPTION '.repeat(100) };
const electricFlag = { code: 'J31_REVERSE', title: 'Обратная активная мощность', source: 'instant', serial: '00001001', count: 2,
  first: '2026-02-03T10:15:00', last: '2026-02-04T11:00:00', detail: 'ПУ 00001001: Фаза 1: P=-0,2 кВт, I=2 А. Наблюдений: 2. Первое: 2026-02-03T10:15:00.' };
const row = (account = '000001', cls = 'amber') => ({ account, serials: ['00001001'],
  result: { meter: { account, pointCount: 1, values: [900, 120] }, cls, score: 24, journalPriority: 'high',
    flags: [{ ...monthlyFlag }, { ...openingFlag }, { ...electricFlag }] } });
const fixture = () => ({ rows: [row()], coverage: { instant: { loaded: true }, events: { loaded: true } },
  months: [{ y: 2026, m: 0 }, { y: 2026, m: 1 }], events: [{ account: '000001', description: 'RAW_DESCRIPTION' }],
  metrics: [{ account: '000001', values: { active1: -.2 } }], caseDetails: [{ account: '000001', months: [] }] });
const context = { res: { name: 'Учебный РЭС', path: '/Учебная ЭС/Учебный РЭС' }, generatedAt: '2026-10-11T07:19:00Z' };
function read(report = fixture(), ctx = context) {
  const bytes = buildAnomalyWorkbook(report, XLSX, ctx);
  return { bytes, book: XLSX.read(bytes, { type: 'array', cellStyles: true }) };
}
function part(bytes, path) {
  const cfb = XLSX.CFB.read(bytes, { type: 'array' }), index = cfb.FullPaths.findIndex(p => p.endsWith('/' + path));
  assert.ok(index >= 0, path); return new TextDecoder().decode(cfb.FileIndex[index].content);
}
const table = book => XLSX.utils.sheet_to_json(book.Sheets.Аномалии, { header: 1, range: 5 });

test('field report has exactly one sheet and four columns with factual reasons and compact journal counts', () => {
  const { bytes, book } = read(), sheet = book.Sheets.Аномалии;
  assert.ok(bytes instanceof Uint8Array); assert.deepEqual(book.SheetNames, ['Аномалии']);
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1, range: 4 })[0], ['Номер ПУ', 'Статус', 'Причины флагов', 'События из журналов']);
  assert.equal(sheet.A6.v, '00001001'); assert.equal(sheet.A6.t, 's'); assert.equal(sheet.B6.v, 'Жёлтый');
  assert.match(sheet.C6.v, /с 900 до 120/); assert.doesNotMatch(sheet.C6.v, /Классика|магнит|шунт|обвод/);
  assert.equal(sheet.A6.z, '@');
  assert.match(sheet.D6.v, /46: Вскрытие клеммной крышки.*01\.02\.2026 — 28\.02\.2026.*регистраций: 7000/);
  assert.match(sheet.D6.v, /31: Обратная активная мощность.*регистраций: 2.*P=-0,2 кВт, I=2 А/);
  assert.doesNotMatch(JSON.stringify(book.Sheets), /RAW_DESCRIPTION|Параметры ПУ|Сопоставления|Баллы ПО|Медиана трёх/);
  assert.equal(sheet['!ref'], 'A1:D6'); assert.match(sheet.A2.v, /Учебный РЭС/);
});

test('only scored yellow and red monthly cards are exported, with red cards first despite journal priority', () => {
  const report = fixture(), red = row('000002', 'red'); red.serials = ['00001002']; red.result.journalPriority = 'none';
  report.rows.push(red);
  for (const cls of ['green', 'dead', 'unknown']) { const excluded = row('EXCLUDED', cls); excluded.serials = ['EXCLUDED']; report.rows.push(excluded); }
  const zeroScore = row('EXCLUDED'); zeroScore.serials = ['EXCLUDED']; zeroScore.result.score = 0; report.rows.push(zeroScore);
  const { book, bytes } = read(report), rows = table(book), xml = part(bytes, 'xl/worksheets/sheet1.xml');
  assert.deepEqual(rows.map(r => [r[0], r[1]]), [['00001002', 'Красный'], ['00001001', 'Жёлтый']]);
  assert.doesNotMatch(JSON.stringify(book.Sheets), /EXCLUDED/);
  assert.match(xml, /<c r="B6" s="10"/); assert.match(xml, /<c r="B7" s="11"/);
});

test('600,000 repeated journal registrations remain one summary line without exporting the source measurements', () => {
  const report = fixture(); report.rows[0].result.flags = [monthlyFlag, { ...openingFlag, count: 600000 }];
  report.events = Array.from({ length: 1100 }, (_, i) => ({ serial: '00001001', description: `RAW_DESCRIPTION ${i}` }));
  const { bytes, book } = read(report);
  assert.equal(table(book).length, 1); assert.equal(book.Sheets.Аномалии.D6.v.split('\n').length, 1);
  assert.match(book.Sheets.Аномалии.D6.v, /регистраций: 600000/); assert.ok(bytes.byteLength < 20000);
  assert.doesNotMatch(JSON.stringify(book.Sheets), /RAW_DESCRIPTION/);
});

test('several PUs preserve their identifiers and PU-specific journal attribution; monthly scope stays explicit', () => {
  const report = fixture(), r = report.rows[0]; r.serials.push('00001002'); r.result.meter.pointCount = 2;
  r.result.flags.push({ ...openingFlag, serial: '00001002', title: 'Вскрытие корпуса', count: 5 });
  const { book } = read(report), sheet = book.Sheets.Аномалии;
  assert.equal(sheet.A6.v, '00001001\n00001002'); assert.match(sheet.C6.v, /суммарно по 2 точкам ЛС 000001/);
  assert.match(sheet.D6.v, /ПУ 00001001\. 46: Вскрытие клеммной крышки/);
  assert.match(sheet.D6.v, /ПУ 00001002\. 46: Вскрытие корпуса.*регистраций: 5/);
});

test('correlation remains a short reason with date and meaningful temporal or seasonal qualifications', () => {
  const report = fixture(); report.rows[0].result.flags.push({ source: 'correlation', pts: 15, title: 'Событие ПУ и снижение потребления',
    months: ['2026-02'], detail: 'Это совпадение в пределах месяца; порядок изменения потребления внутри месяца не установлен. Альтернатива: возможна сезонность.' });
  let sheet = read(report).book.Sheets.Аномалии;
  assert.match(sheet.C6.v, /Событие ПУ и снижение потребления\. 02\.2026/); assert.match(sheet.C6.v, /порядок изменений неизвестен/); assert.match(sheet.C6.v, /Возможна сезонность/);
  report.rows[0].result.flags.at(-1).detail = 'Низкий уровень наблюдался до признаков; новое снижение после них не подтверждено.';
  sheet = read(report).book.Sheets.Аномалии; assert.match(sheet.C6.v, /до событий; нового снижения не подтверждено/);
});

test('conditional and informational electrical observations remain labelled as such', () => {
  const report = fixture(); report.rows[0].result.flags = [monthlyFlag, { ...electricFlag, conditional: true },
    { ...electricFlag, code: 'J31_UNBALANCE', title: 'Несимметрия токов', informational: true }];
  const text = read(report).book.Sheets.Аномалии.D6.v;
  assert.match(text, /Обратная активная мощность \(условный признак\)/); assert.match(text, /Несимметрия токов \(контекст\)/);
});

test('unscored repeated correlations do not turn the concise reason into a detailed case list', () => {
  const report = fixture(); report.rows[0].result.flags.push({ source: 'correlation', pts: 0, title: 'UNSCORED_CASE', months: ['2026-02'] });
  assert.doesNotMatch(read(report).book.Sheets.Аномалии.C6.v, /UNSCORED_CASE/);
});

test('missing PU IDs fall back to LS; unloaded journals differ from unmatched or healthy source rows', () => {
  const report = fixture(); report.rows[0].serials = []; report.rows[0].result.flags = [monthlyFlag]; report.coverage = {};
  let sheet = read(report).book.Sheets.Аномалии;
  assert.equal(sheet.A6.v, 'ПУ не указан (ЛС 000001)'); assert.equal(sheet.D6.v, 'Журналы не загружены');
  report.coverage.events = { loaded: true }; sheet = read(report).book.Sheets.Аномалии;
  assert.equal(sheet.D6.v, 'В загруженных журналах признаки не найдены');
  report.rows[0].journalCoverage = { events: { loaded: true, matchedMeters: 0 } };
  sheet = read(report).book.Sheets.Аномалии; assert.match(sheet.D6.v, /нет сопоставленных записей/);
  sheet = read(report, { ...context, journalStates: { events: { state: 'error' } } }).book.Sheets.Аномалии;
  assert.match(sheet.A2.v, /Журнал 46: ошибка загрузки/);
});

test('headers and first columns are frozen, filtering and wrapping remain usable', () => {
  const { bytes, book } = read(), xml = part(bytes, 'xl/worksheets/sheet1.xml'), styles = part(bytes, 'xl/styles.xml');
  assert.match(xml, /xSplit="2" ySplit="5" topLeftCell="C6"/); assert.match(xml, /state="frozen"/);
  assert.match(xml, /<autoFilter ref="A5:D6"/); assert.match(xml, /customWidth="1"/); assert.match(styles, /wrapText="1"/);
  assert.match(styles, /FFFCE5E5/); assert.match(styles, /FFFFF0D8/); assert.equal(book.Sheets.Аномалии['!autofilter'].ref, 'A5:D6');
});

test('user strings remain literal with no formulas, invalid controls or malformed XML', () => {
  const report = fixture(); report.rows[0].serials = ['=1+1', '@0001', '-001'];
  report.rows[0].result.flags = [{ title: '+SUM(1,2)', detail: 'Измерения & <данные>\u0001' },
    { ...electricFlag, title: '=HYPERLINK("https://example.invalid","x")', detail: '</t><f>malicious</f>\u0000' }];
  const { bytes, book } = read(report), sheet = book.Sheets.Аномалии;
  assert.equal(sheet.A6.v, '=1+1\n@0001\n-001'); assert.equal(sheet.A6.f, undefined); assert.equal(sheet.C6.f, undefined); assert.equal(sheet.D6.f, undefined);
  assert.match(sheet.C6.v, /Измерения & <данные>/); assert.match(sheet.D6.v, /<f>malicious<\/f>/);
  const xml = part(bytes, 'xl/worksheets/sheet1.xml'); assert.doesNotMatch(xml, /<f>/); assert.match(xml, /&lt;f&gt;/); assert.doesNotMatch(xml, /\u0000|\u0001/);
});

test('row height fits multiline reasons while oversized cell text is rejected rather than silently lost', () => {
  const report = fixture(); report.rows[0].result.flags = [{ title: 'Причина', detail: 'Конкретные измерения и причины отбора. '.repeat(12), source: 'monthly' }];
  // Monthly factual presentation uses the first observation, so use a long single factual sentence.
  report.rows[0].result.flags[0].detail = 'Конкретные измерения и причины отбора '.repeat(24);
  const { bytes } = read(report), xml = part(bytes, 'xl/worksheets/sheet1.xml');
  const height = Number(xml.match(/<row r="6" ht="(\d+)" customHeight="1"/)?.[1]); assert.ok(height >= 100 && height <= 409);
  report.rows[0].result.flags[0].detail = 'x'.repeat(32768); assert.throws(() => read(report), /длиннее лимита Excel/);
});

test('large compact reports split on UTF-8 XML budgets without losing or repeating cards', async () => {
  const report = fixture(); report.rows = Array.from({ length: 80 }, (_, i) => {
    const r = row(String(i)); r.serials = [String(i).padStart(12, '0')]; return r;
  });
  const budget = 18000, plan = await planAnomalyWorkbooks(report, context, { maxBytes: budget });
  assert.equal(plan.count, 80); assert.ok(plan.parts.length > 1);
  const serials = [];
  for (let index = 0; index < plan.parts.length; index++) {
    const bytes = buildAnomalyWorkbookPart(plan, index, XLSX), book = XLSX.read(bytes, { type: 'array' });
    assert.deepEqual(book.SheetNames, ['Аномалии']); assert.match(book.Sheets.Аномалии.A2.v, new RegExp(`Часть ${index + 1} из ${plan.parts.length}`));
    const xmlSize = XLSX.CFB.read(bytes, { type: 'array' }).FileIndex.reduce((sum, file) => sum + (file.content?.byteLength || 0), 0);
    assert.ok(xmlSize <= budget, `${xmlSize} <= ${budget}`); serials.push(...table(book).map(r => r[0]));
  }
  assert.deepEqual(serials, report.rows.map(r => r.serials[0]));
});

test('an empty report has a readable empty list and planning can cancel before building files', async () => {
  const report = { rows: [], coverage: {} }, plan = await planAnomalyWorkbooks(report, context), book = XLSX.read(buildAnomalyWorkbookPart(plan, 0, XLSX), { type: 'array' });
  assert.equal(plan.count, 0); assert.equal(plan.parts.length, 1); assert.equal(book.Sheets.Аномалии['!ref'], 'A1:D5'); assert.match(book.Sheets.Аномалии.A2.v, /Карточек: 0/);
  await assert.rejects(planAnomalyWorkbooks(fixture(), context, { assertCurrent() { throw new Error('Отменено'); } }), /Отменено/);
});
