import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import { buildAnomalyWorkbook } from '../public/anomaly-report.js';

const months = [{ y: 2026, m: 0 }, { y: 2026, m: 1 }, { y: 2026, m: 2 }];
const row = (account = '000001') => ({
  account, name: 'Учебный потребитель', address: 'Учебная улица, 1', serials: ['00001001'], points: ['ТУ 1'], tpNames: ['ТП-1'],
  reasons: ['31: обратная активная мощность; 46: вскрытие клеммной крышки; падение месячного ПО.'],
  recommendations: ['Сверить дату события со схемой учёта и контрольными показаниями.'],
  result: {
    meter: { account, name: 'Учебный потребитель', pointCount: 1, power: 15, values: [120.25, null, 0] },
    cls: 'amber', monthlyCls: 'amber', score: 24, monthlyScore: 24, journalPriority: 'high', journalScore: 30, total: 120.25, baseline: 120.25, lossKwh: 60.5,
    flags: [{ code: 'J46', title: 'Вскрытие крышки', source: 'events', pts: 10, count: 2, first: '2026-02-01T10:15:00', last: '2026-02-02T11:00:00', detail: '2 события; ПО до события 120,25 кВт·ч, после — нет полного значения.', recommendation: 'Проверить клеммную крышку и журнал проверок.' }],
  },
});
const fixture = () => ({ months, rows: [row()], counts: { accounts: 4, selected: 1 }, settings: { red: 50, amber: 25 }, coverage: { instant: { loaded: true, totalMeters: 3, matchedMeters: 2, first: '2026-01-01T10:00:00', last: '2026-03-01T11:00:00', warnings: ['Есть пропуски параметров'] }, events: { loaded: true, totalMeters: 2, matchedMeters: 1 } }, unmatched: { instant: { meters: 1, rows: 4, reasons: ['Серийный номер не найден в реестре'] }, events: { meters: 1, rows: 2, reasons: ['Неоднозначная связь ПУ / ЛС'] } }, events: [{ account: '000001', serial: '00001001', at: '2026-02-01T10:15:00', title: 'Клеммная крышка', description: 'Вскрытый элемент устройства "Клеммная крышка"\nДополнительный текст & детали.' }] });
const context = { res: 'Учебный РЭС', sourceName: 'Учебный источник', generatedAt: '2026-10-11T07:19:00Z', files: { registry: 'Расширенный список.xlsx', consumption: { name: 'ПО.xlsx' }, instant: '31.xlsx', events: '46.xlsx' } };
function read(report = fixture()) { const bytes = buildAnomalyWorkbook(report, XLSX, context); return { bytes, book: XLSX.read(bytes, { type: 'array', cellStyles: true }) }; }
function part(bytes, path) { const cfb = XLSX.CFB.read(bytes, { type: 'array' }), index = cfb.FullPaths.findIndex(p => p.endsWith('/' + path)); assert.ok(index >= 0, path); return new TextDecoder().decode(cfb.FileIndex[index].content); }

test('anomaly export preserves exact identifiers, separate monthly/journal scores, observations and monthly blanks', () => {
  const { bytes, book } = read(); assert.ok(bytes instanceof Uint8Array); assert.deepEqual(book.SheetNames, ['Сводка', 'Аномалии', 'Причины', 'События', 'Потребление', 'Параметры ПУ']);
  const a = book.Sheets.Аномалии, p = book.Sheets.Потребление, e = book.Sheets.События;
  assert.equal(a.F6.v, '000001'); assert.equal(a.F6.t, 's'); assert.equal(a.I6.v, '00001001'); assert.equal(a.D6.v, 24); assert.equal(a.E6.v, 30); assert.equal(a.Q6.v, 60.5); assert.equal(a.B6.v, 'Высокий'); assert.equal(a.C6.v, 'Наблюдение');
  assert.equal(p.E6.v, 120.25); assert.equal(p.F6, undefined); assert.equal(p.G6.v, 0); assert.equal(p.H6.v, 120.25); assert.equal(e.B6.v, '00001001'); assert.equal(e.E6.v, fixture().events[0].description);
  assert.equal(e.C6.t, 'n'); assert.equal(e.C6.z, 'dd.mm.yyyy hh:mm'); const d = XLSX.SSF.parse_date_code(e.C6.v); assert.deepEqual([d.y, d.m, d.d, d.H, d.M], [2026, 2, 1, 10, 15]);
  const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 }); assert.ok(summary.some(r => r[0] === 'ЛС в анализе' && r[1] === 4)); assert.ok(summary.some(r => r[0] === 'Журнал 31: причины несопоставления' && r[1].includes('не найден'))); assert.ok(summary.some(r => String(r[1]).includes('не объём к доначислению')));
});

test('XLSX package contains frozen headers, filters, widths, wrapping and semantic priority colors', () => {
  const { bytes, book } = read(), sheet = part(bytes, 'xl/worksheets/sheet2.xml'), styles = part(bytes, 'xl/styles.xml');
  assert.match(sheet, /state="frozen"/); assert.match(sheet, /ySplit="5" topLeftCell="A6"/); assert.match(sheet, /<autoFilter ref="A5:U6"/); assert.match(sheet, /customWidth="1"/); assert.match(sheet, /<c r="B6" s="10"/);
  assert.match(styles, /wrapText="1"/); assert.match(styles, /FFFCE5E5/); assert.match(styles, /FFFFF0D8/); assert.match(styles, /FFE4F2E9/); assert.match(styles, /FF19324F/); assert.equal(book.Sheets.Аномалии['!autofilter'].ref, 'A5:U6');
});

test('long reasons and multiline journal descriptions receive readable bounded row heights', () => {
  const report = fixture(); report.rows[0].reasons = ['Конкретные измерения и причины отбора. '.repeat(12)]; report.events[0].description = Array.from({ length: 50 }, (_, i) => `Подробность события ${i}`).join('\n');
  const { bytes, book } = read(report), anomalies = part(bytes, 'xl/worksheets/sheet2.xml'), events = part(bytes, 'xl/worksheets/sheet4.xml');
  const height = Number(anomalies.match(/<row r="6" ht="(\d+)" customHeight="1"/)?.[1]); assert.ok(height >= 60 && height <= 409); assert.match(events, /<row r="6" ht="409" customHeight="1"/); assert.equal(book.Sheets.События.E6.v, report.events[0].description);
});

test('monthly explanations contain measured observations while complete journal evidence remains unchanged', () => {
  const report = fixture(); report.rows[0].reasons = [];
  const monthly = { code: 'S3', title: 'Ступенчатое падение', pts: 12, detail: 'Расход упал с 900 до 120 кВт·ч/мес., снижение 87%. Классика вмешательства: магнит, шунт, обвод.' };
  const journal = [
    { code: 'J31_REVERSE', source: 'instant', title: 'Обратная мощность', pts: 10, detail: 'ПУ 00001001: P=-0,2 кВт. Наблюдений: 3. Первое: 2026-02-01T10:15:00.' },
    { code: 'J46_TERMINAL_COVER', source: 'events', title: 'Клеммная крышка', pts: 10, detail: 'ПУ 00001001: 2 события. Первое: 2026-02-01T10:15:00. Вскрытый элемент устройства "Клеммная крышка".' },
    { code: 'J_CORRELATION', source: 'correlation', title: 'Совпадение со снижением ПО', pts: 15, detail: '2026-02: 120 кВт·ч; медиана 900 кВт·ч. Снижение 87%. Порядок изменения внутри месяца не установлен.' },
  ];
  report.rows[0].result.flags = [monthly, ...journal];
  const { book } = read(report), reasons = XLSX.utils.sheet_to_json(book.Sheets.Причины, { header: 1, range: 5 });
  assert.match(reasons[0][11], /с 900 до 120/); assert.doesNotMatch(reasons[0][11], /Классика|магнит|шунт|обвод/); assert.doesNotMatch(book.Sheets.Аномалии.R6.v, /Классика вмешательства/);
  journal.forEach((flag, i) => assert.equal(reasons[i + 1][11], flag.detail));
  assert.equal(book.Sheets.Аномалии.D6.v, 24); assert.equal(book.Sheets.Аномалии.Q6.v, 60.5);
});

test('user strings stay literal and XML remains valid with formulas, markup and invalid controls', () => {
  const report = fixture(); report.rows[0].name = '=HYPERLINK("https://example.invalid","x")'; report.rows[0].address = '+SUM(1,2) & <адрес>\u0001'; report.rows[0].serials = ['@0001', '-001']; report.events[0].description = '=1+1\n</t><f>malicious</f>\u0000';
  const { bytes, book } = read(report); const a = book.Sheets.Аномалии;
  assert.equal(a.G6.t, 's'); assert.equal(a.G6.v, report.rows[0].name); assert.equal(a.G6.f, undefined); assert.equal(a.H6.v, '+SUM(1,2) & <адрес>'); assert.equal(a.I6.v, '@0001\n-001'); assert.equal(book.Sheets.События.E6.v, '=1+1\n</t><f>malicious</f>');
  const xml = part(bytes, 'xl/worksheets/sheet4.xml'); assert.doesNotMatch(xml, /<f>/); assert.match(xml, /&lt;f&gt;/); assert.doesNotMatch(xml, /\u0000/);
});

test('empty report remains usable and missing journals are stated explicitly', () => {
  const { book } = read({ months, rows: [], counts: { accounts: 3 }, events: [] }); assert.equal(book.Sheets.Аномалии['!ref'], 'A1:U5'); assert.equal(book.Sheets.События['!ref'], 'A1:F5');
  const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 }); assert.ok(summary.some(r => r[0] === 'ЛС в отчёте' && r[1] === 0)); assert.ok(summary.some(r => r[0] === 'Журнал 46: доступность' && r[1].includes('Не загружен')));
});

test('service selection is retained including green rows with data issues; zero and unknown have concrete reasons', () => {
  const quality = row('000002'); quality.reasons = ['Неполные месяцы: 1; отсутствующие объёмы не принимались за ноль.']; quality.result = { ...quality.result, cls: 'green', flags: [], journalPriority: 'none' };
  const zero = row('000003'); zero.reasons = []; zero.result = { ...zero.result, cls: 'dead', flags: [], journalPriority: 'none' };
  const unknown = row('000004'); unknown.reasons = []; unknown.result = { ...unknown.result, cls: 'unknown', flags: [], journalPriority: 'none' };
  const { book } = read({ months, rows: [quality, zero, unknown], events: [] }); const reasons = XLSX.utils.sheet_to_json(book.Sheets.Причины, { header: 1, range: 5 });
  assert.equal(reasons.length, 3); assert.equal(reasons[0][0], '000002'); assert.equal(reasons[0][5], 'Качество исходных данных'); assert.match(reasons[0][11], /Неполные месяцы/); assert.equal(reasons[1][0], '000003'); assert.match(reasons[1][11], /нулевой/); assert.equal(reasons[2][0], '000004'); assert.match(reasons[2][11], /Недостаточно/);
});

test('unmatched source identities include reasons and counts rather than object placeholders', () => {
  const report = fixture(); report.unmatched.events.reasons = [{ reason: 'Серийный номер связан с несколькими ЛС или ТУ', meters: 2 }];
  const { book } = read(report); const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 });
  assert.ok(summary.some(r => r[0] === 'Журнал 46: причины несопоставления' && r[1] === 'Серийный номер связан с несколькими ЛС или ТУ — 2 ПУ'));
});

test('all latest parameters and unmatched events are exported with coverage and load failures', () => {
  const report = fixture(); report.coverage.instant.reportPeriod = { from: '2026-01-01', to: '2026-03-31' }; report.coverage.instant.coefficientMode = 'unscaled';
  report.metrics = Array.from({ length: 55 }, (_, i) => ({ account: '000001', serial: String(i).padStart(8, '0'), at: '2026-03-01T10:15:00', values: { active1: -0.2, voltage1: 230.5, current1: 2, neutralCurrent: 1.2 }, coefficientMode: 'unscaled' }));
  report.events.push({ account: '', serial: '00099999', at: '2026-03-01T11:30:00', description: 'Вскрытый элемент устройства "Корпус"', mappingReason: 'Серийный номер отсутствует в реестре.' });
  const bytes = buildAnomalyWorkbook(report, XLSX, { ...context, journalStates: { events: { state: 'error', error: 'Не удалось обновить источник' } } }), book = XLSX.read(bytes, { type: 'array' });
  const parameters = XLSX.utils.sheet_to_json(book.Sheets['Параметры ПУ'], { header: 1, range: 4 }); assert.equal(parameters.length, 56); assert.equal(parameters[1][0], '000001'); assert.equal(parameters[1][1], '00000000'); assert.equal(parameters[1][3], 'Без коэффициентов трансформации');
  const active = parameters[0].indexOf('Активная мощность, фаза 1, кВт'), voltage = parameters[0].indexOf('Напряжение, фаза 1, В'); assert.equal(parameters[1][active], -0.2); assert.equal(parameters[1][voltage], 230.5);
  assert.equal(book.Sheets.События.A7, undefined); assert.equal(book.Sheets.События.B7.v, '00099999'); assert.equal(book.Sheets.События.F7.v, 'Серийный номер отсутствует в реестре.');
  const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 }); assert.ok(summary.some(r => r[0] === 'ПУ с последними параметрами в отчёте' && r[1] === 55)); assert.ok(summary.some(r => r[0] === 'Журнал 46: состояние загрузки' && r[1] === 'Ошибка: Не удалось обновить источник'));
});

test('large multi-chunk event export preserves every Cyrillic description and exact date', () => {
  const report = fixture(); report.events = Array.from({ length: 1100 }, (_, index) => ({ account: '000001', serial: '00001001', at: '2026-02-01T10:15:00', description: `Событие № ${index}: Вскрытый элемент устройства "Клеммная крышка" & детали` }));
  const { book } = read(report), events = XLSX.utils.sheet_to_json(book.Sheets.События, { header: 1, range: 5 }); assert.equal(events.length, 1100); assert.equal(events[0][4], report.events[0].description); assert.equal(events[1099][4], report.events[1099].description); assert.equal(events[1099][1], '00001001');
});

test('oversized text and column counts fail clearly instead of silently losing report content', () => {
  const report = fixture(); report.events[0].description = 'a'.repeat(32768); assert.throws(() => buildAnomalyWorkbook(report, XLSX, context), /длиннее лимита Excel/);
  assert.throws(() => buildAnomalyWorkbook({ months: Array.from({ length: 16380 }, () => months[0]), rows: [], events: [] }, XLSX, context), /лимит столбцов/);
  assert.throws(() => buildAnomalyWorkbook(null, XLSX), /Нет результатов/); assert.throws(() => buildAnomalyWorkbook(fixture(), {}), /Модуль Excel/);
});
