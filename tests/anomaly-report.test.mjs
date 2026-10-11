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
  const { bytes, book } = read(); assert.ok(bytes instanceof Uint8Array); assert.deepEqual(book.SheetNames, ['Сводка', 'Аномалии', 'Причины', 'События', 'Потребление', 'Параметры ПУ', 'Сопоставления']);
  const a = book.Sheets.Аномалии, p = book.Sheets.Потребление, e = book.Sheets.События;
  assert.equal(a.F6.v, '000001'); assert.equal(a.F6.t, 's'); assert.equal(a.I6.v, '00001001'); assert.equal(a.D6.v, 24); assert.equal(a.E6.v, 30); assert.equal(a.Q6.v, 60.5); assert.equal(a.B6.v, 'Высокий'); assert.equal(a.C6.v, 'Наблюдение');
  assert.equal(p.E6.v, 120.25); assert.equal(p.F6, undefined); assert.equal(p.G6.v, 0); assert.equal(p.H6.v, 120.25); assert.equal(e.B6.v, '00001001'); assert.equal(e.H6.v, fixture().events[0].at + ' · ' + fixture().events[0].description);
  assert.equal(e.D6.t, 'n'); assert.equal(e.D6.z, 'dd.mm.yyyy hh:mm'); const d = XLSX.SSF.parse_date_code(e.D6.v); assert.deepEqual([d.y, d.m, d.d, d.H, d.M], [2026, 2, 1, 10, 15]);
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
  const height = Number(anomalies.match(/<row r="6" ht="(\d+)" customHeight="1"/)?.[1]); assert.ok(height >= 60 && height <= 409); assert.match(events, /<row r="6" ht="409" customHeight="1"/); assert.equal(book.Sheets.События.H6.v, report.events[0].at + ' · ' + report.events[0].description);
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
  assert.equal(a.G6.t, 's'); assert.equal(a.G6.v, report.rows[0].name); assert.equal(a.G6.f, undefined); assert.equal(a.H6.v, '+SUM(1,2) & <адрес>'); assert.equal(a.I6.v, '@0001\n-001'); assert.equal(book.Sheets.События.H6.v, report.events[0].at + ' · =1+1\n</t><f>malicious</f>');
  const xml = part(bytes, 'xl/worksheets/sheet4.xml'); assert.doesNotMatch(xml, /<f>/); assert.match(xml, /&lt;f&gt;/); assert.doesNotMatch(xml, /\u0000/);
});

test('empty report remains usable and missing journals are stated explicitly', () => {
  const { book } = read({ months, rows: [], counts: { accounts: 3 }, events: [] }); assert.equal(book.Sheets.Аномалии['!ref'], 'A1:U5'); assert.equal(book.Sheets.События['!ref'], 'A1:M5');
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
  assert.equal(book.Sheets.События.A7, undefined); assert.equal(book.Sheets.События.B7.v, '00099999'); assert.equal(book.Sheets.События.K7.v, 'Серийный номер отсутствует в реестре.');
  const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 }); assert.ok(summary.some(r => r[0] === 'ПУ с последними параметрами в отчёте' && r[1] === 55)); assert.ok(summary.some(r => r[0] === 'Журнал 46: состояние загрузки' && r[1] === 'Ошибка: Не удалось обновить источник'));
});

test('large multi-chunk grouped event export preserves Cyrillic examples and exact dates', () => {
  const report = fixture(); report.events = Array.from({ length: 1100 }, (_, index) => ({ account: '000001', serial: String(index).padStart(8, '0'), month: '2026-02', at: '2026-02-01T10:15:00', first: '2026-02-01T10:15:00', last: '2026-02-10T11:15:00', count: 200, examplesTruncated: true, examples: [{ at: '2026-02-01T10:15:00', description: `Пример № ${index}: Вскрытый элемент устройства "Клеммная крышка" & детали` }] }));
  const { book } = read(report), events = XLSX.utils.sheet_to_json(book.Sheets.События, { header: 1, range: 5 }); assert.equal(events.length, 1100); assert.equal(events[0][7], report.events[0].examples[0].at + ' · ' + report.events[0].examples[0].description); assert.equal(events[1099][7], report.events[1099].examples[0].at + ' · ' + report.events[1099].examples[0].description); assert.equal(events[1099][1], '00001099'); assert.equal(events[1099][5], 200);
});

test('compact 46 groups retain registration counts, separate active categories and bounded dated examples without expanding source rows', () => {
  const report = fixture();
  const group = { account: '000001', serial: '00001001', groupId: 'G1', month: '2026-02', first: '2026-02-01T10:15:00', at: '2026-02-01T10:15:00', last: '2026-02-28T20:15:00', count: 7000, codes: ['J46_CASE', 'J46_MAGNET_AC'], classifications: [{ title: 'Корпус' }, { title: 'Магнитная пломба переменного поля' }], examples: [{ at: '2026-02-01T10:15:00', description: 'Вскрытый элемент устройства "Корпус"; магнитная пломба переменного поля' }, { at: '2026-02-14T11:15:00', description: 'Вскрытый элемент устройства "Корпус" & пример' }], examplesTruncated: true, days: [['2026-02-01', '2026-02-01T10:15:00', '2026-02-01T20:15:00', 3000], ['2026-02-28', '2026-02-28T10:15:00', '2026-02-28T20:15:00', 4000]] };
  report.events = [group, { ...group, groupId: 'G2', codes: ['J46_TERMINAL_COVER'], classifications: [{ title: 'Клеммная крышка' }], count: 5, examples: [{ at: '2026-02-05T10:15:00', description: 'Вскрытый элемент устройства "Клеммная крышка"' }], days: [], examplesTruncated: false }];
  report.coverage.events = { ...report.coverage.events, totalRegistrations: 7005, matchedRegistrations: 7005, totalGroups: 2, matchedGroups: 2 };
  report.caseDetails = [{ id: 'CASE', account: '000001', serial: '00001001', point: { label: 'ТУ 1' }, scope: 'ЛС + ТУ', scenario: 'combined', priority: 'check', score: 10, month: '2026-02', value: 150, comparisons: {}, temporalRelation: 'pre_existing', preExistingDecline: { month: '2026-01', value: 150, additionalDropPercent: 0, newDecline: false, reason: 'Низкий ПО наблюдался до журнальных свидетельств' }, evidence: { events: [{ ...group, at: '2026-02-01T20:15:00', timestampDetailExact: false }, { ...group, at: '2026-02-28T20:15:00', timestampDetailExact: false }], electrical: [], eventGroupCount: 1, eventRegistrationCountScope: 'participating_month_groups', eventDetailsTruncated: true }, detail: 'Падение существовало до событий; нового снижения не подтверждено.' }];
  const { book } = read(report), events = XLSX.utils.sheet_to_json(book.Sheets.События, { header: 1, range: 4 }), [headers, first, second] = events, get = (row, title) => row[headers.indexOf(title)];
  assert.equal(events.length, 3); assert.equal(get(first, 'Количество регистраций источника'), 7000); assert.equal(get(second, 'Количество регистраций источника'), 5); assert.match(get(first, 'Активные категории группы'), /Корпус.*\n.*Магнитная/); assert.equal(get(second, 'Активные категории группы'), 'Клеммная крышка'); assert.equal(get(first, 'Число сохранённых примеров'), 2); assert.match(get(first, 'J · Сохранённые примеры с собственными датами'), /2026-02-14T11:15:00.*Корпус/); assert.match(get(first, 'Полнота описаний J'), /только примеры/); assert.match(get(first, 'Регистрации по дням: даты и количества'), /регистраций 4000/); assert.equal(get(first, 'Идентификатор месячной группы'), 'G1');
  const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 }); assert.ok(summary.some(r => r[0] === 'Месячных групп журнала 46 в отчёте' && r[1] === 2)); assert.ok(summary.some(r => r[0] === 'Регистраций 46 в подготовленных группах' && r[1] === 7005)); assert.ok(summary.some(r => r[0] === 'Что означает число регистраций 46' && /не число независимых вскрытий/.test(r[1])));
  const [caseHeaders, evidence] = XLSX.utils.sheet_to_json(book.Sheets.Сопоставления, { header: 1, range: 4 }), caseGet = title => evidence[caseHeaders.indexOf(title)];
  assert.equal(caseGet('Регистраций 46 в целых месячных группах'), 7000); assert.match(caseGet('Полнота свидетельств сочетания'), /не число регистраций внутри окна 31 дня/); assert.match(caseGet('Полнота свидетельств сочетания'), /Ранее низкий месяц: 2026-01/); assert.match(caseGet('Полнота свидетельств сочетания'), /Дополнительное снижение 0%/); assert.match(caseGet('Отношение дат журналов к месяцу ПО'), /до признаков/); assert.match(caseGet('Даты и описания свидетельств 46'), /исходное описание для этой даты не сохранено/); assert.match(caseGet('Даты и описания свидетельств 46'), /2026-02-14T11:15:00/);
});

test('cross-journal sheet preserves grouped months, exact PU/TU scope, numeric comparisons and explicit unavailable values', () => {
  const report = fixture();
  const event = { at: '2026-02-02T11:15:00', description: 'Вскрытый элемент устройства "Клеммная крышка" & детали', classifications: [{ code: 'J46_TERMINAL_COVER', title: 'Клеммная крышка' }] };
  const electric = { code: 'J31_REVERSE', title: 'Обратная активная мощность', at: '2026-02-03T12:10:00', count: 3, detail: 'Фаза 1: P=-0,2 кВт, I=2 А.', conditional: false, timestampDetailExact: true };
  report.caseDetails = [{ id: 'CASE-0001', account: '000001', serial: '00001001', point: { key: 'p1', label: 'ТУ 1' }, scope: 'ЛС + ТУ', scenario: 'combined', priority: 'high', score: 85, month: '2026-02', value: 0, detail: 'Конкретное сочетание наблюдений одного ПУ.', recommendation: 'Сверить акт работ и выполнить инструментальную проверку.', supportingMonthlyFlags: [{ code: 'S3', title: 'Ступенчатое падение', scope: 'ЛС + ТУ', detail: 'Расход упал со 100 до 0 кВт·ч. Классика вмешательства: магнит, шунт, обвод.' }], months: [
    { month: '2026-02', value: 0, comparisons: { previous: { available: true, month: '2026-01', value: 100, dropPercent: 100, reason: '' }, yearAgo: { available: false, month: '2025-02', value: null, dropPercent: null, reason: 'Нет прошлогоднего месяца' }, median3: { available: true, months: ['2025-11', '2025-12', '2026-01'], value: 110, dropPercent: 100, reason: '' } }, thresholdMatches: ['previous', 'median3'], seasonalAlternative: false, temporalRelation: 'same_month', evidence: { events: [event], electrical: [electric], eventCount: 1, electricalCount: 3 }, peerContext: { available: true, tp: 'ТП-1', comparison: 'previous', eligiblePeers: 8, declinedPeers: 6, sharePercent: 75, commonDecline: true, detail: '6 из 8 других ЛС снизили ПО минимум на 30%; проверяемый ЛС исключён.' } },
    { month: '2026-03', value: null, comparisons: { previous: { available: false, month: '2026-02', value: 0, dropPercent: null, reason: 'Нулевая база; процент не рассчитывается' }, yearAgo: { available: true, month: '2025-03', value: 120, dropPercent: null, reason: 'Отсутствует текущий ПО' }, median3: { available: false, value: null, dropPercent: null, reason: 'Есть пропуски в трёх месяцах' } }, temporalRelation: 'after', evidence: { events: [event], electrical: [{ ...electric, conditional: true, timestampDetailExact: false }] }, evidenceTruncated: true, peerContext: { available: false, reason: 'Менее шести других сопоставимых ЛС' } },
  ] }];
  const { bytes, book } = read(report), rows = XLSX.utils.sheet_to_json(book.Sheets.Сопоставления, { header: 1, range: 4 }), [headers, first, second] = rows;
  const get = (row, title) => row[headers.indexOf(title)];
  assert.equal(rows.length, 3); assert.equal(get(first, 'Лицевой счёт'), '000001'); assert.equal(get(first, 'Серийный номер ПУ'), '00001001'); assert.equal(get(first, 'Точка учёта'), 'ТУ 1'); assert.equal(get(first, 'ПО этой ТУ, кВт·ч'), 0); assert.equal(get(first, 'ПО предыдущего месяца, кВт·ч'), 100); assert.equal(get(first, 'Снижение к предыдущему, %'), 100);
  assert.equal(get(first, 'Прошлогодний ПО, кВт·ч'), undefined); assert.equal(get(first, 'Снижение к прошлому году, %'), undefined); assert.equal(get(first, 'Прошлогоднее сравнение: доступность'), 'Недоступно'); assert.equal(get(first, 'Прошлогоднее сравнение: причина недоступности'), 'Нет прошлогоднего месяца'); assert.equal(get(first, 'Медиана трёх месяцев, кВт·ч'), 110);
  assert.match(get(first, 'Даты и описания свидетельств 46'), /2026-02-02T11:15:00/); assert.match(get(first, 'Даты, параметры и точность электрических свидетельств 31'), /P=-0,2 кВт, I=2 А/); assert.match(get(first, 'Отношение дат журналов к месяцу ПО'), /порядок.*не установлен/); assert.doesNotMatch(get(first, 'Дополнительный месячный контекст'), /Классика|шунт|обвод/);
  assert.equal(get(first, 'Пригодных других ЛС'), 8); assert.equal(get(first, 'Других ЛС со снижением'), 6); assert.equal(get(first, 'Доля других ЛС со снижением, %'), 75); assert.equal(get(first, 'Общий спад ТП'), 'Выявлен общий спад');
  assert.equal(get(second, 'ПО этой ТУ, кВт·ч'), undefined); assert.equal(get(second, 'ПО предыдущего месяца, кВт·ч'), 0); assert.equal(get(second, 'Снижение к предыдущему, %'), undefined); assert.match(get(second, 'Предыдущее сравнение: причина недоступности'), /Нулевая база/); assert.match(get(second, 'Даты, параметры и точность электрических свидетельств 31'), /агрегата.*не подтверждена/); assert.match(get(second, 'Полнота свидетельств сочетания'), /представительные/); assert.match(get(second, 'Условность электрических признаков'), /условные/); assert.equal(get(second, 'Контекст ТП: доступность'), 'Недоступно');
  const summary = XLSX.utils.sheet_to_json(book.Sheets.Сводка, { header: 1, range: 4 }); assert.ok(summary.some(r => r[0] === 'Совокупности признаков: сочетаний / строк по месяцам' && r[1] === '1 / 2')); assert.ok(summary.some(r => r[0] === 'Период совместных свидетельств' && /одному ПУ и одной ТУ/.test(r[1])));
  const xml = part(bytes, 'xl/worksheets/sheet7.xml'); assert.match(xml, /<c r="G6" s="10"/); assert.match(xml, /xSplit="4" ySplit="5"/); assert.equal(book.Sheets.Аномалии.M6.v, 120.25); assert.equal(book.Sheets.Потребление.H6.v, 120.25);
});

test('journals-only and load/zero cases remain literal, with no invented consumption comparison or energy estimate', () => {
  const report = fixture(); report.caseDetails = [{ id: 'ONE', account: '000001', serial: '00001001', point: { label: 'ТУ 1' }, scenario: 'journals_only', priority: 'check', score: 20, month: null, value: null, comparisons: {}, temporalRelation: 'journals_only', evidence: { events: [{ at: '2026-02-02T10:15:00', description: '=HYPERLINK("https://example.invalid","данные")' }], electrical: [] }, detail: 'Журнальные свидетельства; данных ПО для сравнения нет.' }, { id: 'TWO', account: '000001', serial: '00001002', point: { label: 'ТУ 2' }, scenario: 'load_zero', priority: 'check', score: 10, month: '2026-02', value: 0, comparisons: {}, evidence: { electrical: [{ code: 'J31_LOAD', at: '2026-02-10T12:00:00', detail: 'P=0,4 кВт.', timestampDetailExact: true }], events: [] }, detail: 'Есть нагрузка и известный нулевой ПО; энергия не оценивалась.' }];
  const { book } = read(report), rows = XLSX.utils.sheet_to_json(book.Sheets.Сопоставления, { header: 1, range: 4 }), [headers, first, second] = rows, get = (row, title) => row[headers.indexOf(title)];
  assert.equal(get(first, 'Месяц ПО'), undefined); assert.equal(get(first, 'ПО этой ТУ, кВт·ч'), undefined); assert.equal(get(first, 'Предыдущее сравнение: доступность'), 'Недоступно'); assert.match(get(first, 'Даты и описания свидетельств 46'), /=HYPERLINK/); assert.equal(book.Sheets.Сопоставления.AF6.f, undefined); assert.equal(get(second, 'Сценарий'), 'Нагрузка 31 + нулевой ПО'); assert.equal(get(second, 'ПО этой ТУ, кВт·ч'), 0); assert.match(get(second, 'Конкретное основание сопоставления'), /энергия не оценивалась/); assert.equal(book.Sheets.Аномалии.Q6.v, 60.5);
});

test('oversized text and column counts fail clearly instead of silently losing report content', () => {
  const report = fixture(); report.events[0].description = 'a'.repeat(32768); assert.throws(() => buildAnomalyWorkbook(report, XLSX, context), /длиннее лимита Excel/);
  assert.throws(() => buildAnomalyWorkbook({ months: Array.from({ length: 16380 }, () => months[0]), rows: [], events: [] }, XLSX, context), /лимит столбцов/);
  assert.throws(() => buildAnomalyWorkbook(null, XLSX), /Нет результатов/); assert.throws(() => buildAnomalyWorkbook(fixture(), {}), /Модуль Excel/);
});
