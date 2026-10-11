import { ALG_META, BOOST_DEFS, buildTune } from './analysis-engine.js';
import { normalizeSettings } from './analysis-settings.js';
import { TUNE_HINT, LEVEL_NAMES } from './analysis-tuning.js';
import { INSTANT_METRICS } from './journals.js';
import { flagObservation } from './analysis-observations.js';
import { idKey } from './core.js';

const MAX_ROWS = 1048576, MAX_COLUMNS = 16384, MAX_TEXT = 32767;
const MAX_REPORT_XML_BYTES = 96 * 1024 * 1024;
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ZONES = { red: 'Высокий приоритет', amber: 'Наблюдение', green: 'Без выраженных признаков', dead: 'Нулевой ряд', unknown: 'Недостаточно данных' };
const JOURNAL_ZONES = { high: 'Высокий', check: 'Проверить', none: 'Без признаков' };
const SOURCE_NAMES = { instant: 'Журнал 31', events: 'Журнал 46', correlation: 'Журналы + месячный ПО', monthly: 'Полезный отпуск', consumption: 'Полезный отпуск', registry: 'Реестр ПУ', incoming: 'Приём' };
const SCENARIOS = { combined: '31 + 46 + снижение ПО', electrical_drop: '31 + снижение ПО', event_drop: '46 + снижение ПО', journals_only: '31 + 46 без критерия снижения ПО', load_zero: 'Нагрузка 31 + нулевой ПО' };
const COMPARISONS = { previous: 'Предыдущий месяц', yearAgo: 'Тот же месяц прошлого года', median3: 'Медиана трёх предыдущих месяцев' };
const TEMPORAL_RELATIONS = { same_month: 'В одном месяце; порядок изменений внутри месяца не установлен', after: 'ПО в более позднем месяце; точный момент изменения внутри месяца не установлен', pre_existing: 'Низкий уровень ПО наблюдался до признаков; нового снижения после них не подтверждено', journals_only: 'Совместные журнальные признаки; критерий снижения ПО не выполнен' };
const MONTH_RECOMMENDATIONS = {
  S1: 'Сверить начало роста с вводом объекта, заменой ПУ и контрольными снятиями.',
  S2: 'Сверить всплески с контрольными снятиями и корректировками начислений.',
  S3: 'Сверить дату падения с отключениями, нагрузкой, заменой ПУ и журналом событий.',
  'S3б': 'Проверить отключения, корректировки и режим объекта внутри провала и при восстановлении.',
  S4: 'Уточнить фактическое использование объекта и изменение нагрузки.',
  S5: 'Сопоставить нулевые месяцы с отключениями и фактической работой объекта.',
  S6: 'Проверить повторение передаваемых значений по контрольным показаниям.',
  S7: 'Сверить округлённые объёмы с контрольными показаниями и способом начисления.',
  S8: 'Уточнить сопоставимость потребителей и режимов их работы.',
  S9: 'Проверить сезонный режим объекта и электрическое отопление.',
  S10: 'Сверить разрешённую мощность, фактическую нагрузку и схему присоединения.',
  S11: 'Сопоставить расхождения с техническим учётом и журналами событий.',
  S12: 'Проверить документы по разовому объёму: снятие, перерасчёт, доначисление.',
  S13: 'Сверить рост с заменой ПУ, проверкой, вводом оборудования и расширением деятельности.',
  S14: 'Сопоставить снижение с историей работы объекта и изменением его нагрузки.',
};

function xml(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = value => Array.isArray(value) ? value.map(item => typeof item === 'object' && item ? item.label || item.name || item.number || item.point || item.id || '' : item).filter(v => v !== '' && v != null).join('\n') : value ?? '';
const uniqueLines = value => [...new Set((Array.isArray(value) ? value : [value]).filter(v => v != null && String(v).trim()).map(String))].join('\n');
const unmatchedReasons = values => uniqueLines((values || []).map(v => typeof v === 'object' && v ? `${v.reason || 'Причина не указана'}${v.meters != null ? ` — ${v.meters} ПУ` : ''}` : v));
const resultOf = row => row.result || row;
const monthLabel = month => month && Number.isInteger(month.y) && Number.isInteger(month.m) ? `${String(month.m + 1).padStart(2, '0')}.${month.y}` : String(month?.label || month || '');
function dateCell(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 20000 && value < 150000 ? { value, date: true } : null;
  // Journal timestamps describe the meter's calendar, without changing time zone.
  const match = String(value instanceof Date ? value.toISOString() : value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return String(value);
  const [year, month, day, hour, minute, second] = match.slice(1).map(v => Number(v || 0));
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return String(value);
  return { value: time / 86400000 + 25569, date: true };
}
function columnName(index) {
  let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
function cellXML(value, col, row, style, numericStyle = 4) {
  if (value == null || value === '') return '';
  const ref = columnName(col) + row;
  if (typeof value === 'object' && value.date) return `<c r="${ref}" s="6"><v>${value.value}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${numericStyle}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = String(value);
  if (text.length > MAX_TEXT) throw new Error(`Текст ${ref} длиннее лимита Excel (${MAX_TEXT} знаков). Уточните исходные данные.`);
  // Inline strings never become formulas, even when a name starts with =, +, - or @.
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function xmlChunks(budget) {
  const encoder = new TextEncoder(), blocks = []; let pending = [], characters = 0, bytes = 0;
  const flush = () => {
    if (!pending.length) return;
    const block = encoder.encode(pending.join('')); bytes += block.byteLength;
    if (bytes > budget) throw new Error('Отчёт слишком большой для безопасной выгрузки на устройстве (лимит XML 96 МБ). Уменьшите период исходного журнала и повторите подготовку.');
    blocks.push(block); pending = []; characters = 0;
  };
  return {
    push(...parts) { for (const part of parts) { pending.push(part); characters += part.length; if (characters >= 65536) flush(); } },
    flush,
    finish() { flush(); const output = new Uint8Array(bytes); let offset = 0; for (const block of blocks) { output.set(block, offset); offset += block.byteLength; } return output; },
  };
}
function rowHeight(cells, widths) {
  let lines = 1;
  for (let col = 0; col < cells.length; col++) {
    if (typeof cells[col] !== 'string') continue;
    const characters = Math.max(4, Math.floor((widths[col] || 20) * 0.85));
    const count = cells[col].split(/\r\n|\r|\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / characters)), 0);
    lines = Math.max(lines, count);
  }
  // Excel caps a row at 409 points. Full text remains in the cell at that cap.
  return Math.min(409, Math.max(20, lines * 14 + 4));
}
function dataRowXML(row, index, sheet) {
  const cells = Array.isArray(row) ? row : row.cells, rowNumber = index + 6;
  const height = rowHeight(cells, sheet.widths || []), numeric = new Set(sheet.numberColumns), integers = new Set(sheet.integerColumns);
  return `<row r="${rowNumber}"${height > 20 ? ` ht="${height}" customHeight="1"` : ''}>` + cells.map((value, col) => {
    let style = index % 2 ? 9 : 3;
    if (col === sheet.priorityColumn) style = row.priority === 'high' ? 10 : row.priority === 'check' ? 11 : 12;
    return cellXML(value, col, rowNumber, style, integers.has(col) ? 5 : numeric.has(col) ? 4 : 5);
  }).join('') + '</row>';
}
function sheetXML({ title, subtitle, headers, widths = [], rows, priorityColumn = -1, numberColumns = [], integerColumns = [], freezeColumns = 0 }, generated, budget) {
  if (headers.length > MAX_COLUMNS) throw new Error(`Лист «${title}» превышает лимит столбцов Excel.`);
  if (rows.length + 5 > MAX_ROWS) throw new Error(`Лист «${title}» превышает лимит строк Excel. Уменьшите период или объём выгрузки.`);
  const end = columnName(headers.length - 1), bottom = Math.max(5, rows.length + 5);
  const numeric = new Set(numberColumns), integers = new Set(integerColumns);
  const pane = freezeColumns ? 'bottomRight' : 'bottomLeft', start = columnName(freezeColumns) + '6';
  const chunks = xmlChunks(budget);
  chunks.push(XML, `<worksheet xmlns="${NS}"><dimension ref="A1:${end}${bottom}"/><sheetViews><sheetView workbookViewId="0"><pane ${freezeColumns ? `xSplit="${freezeColumns}" ` : ''}ySplit="5" topLeftCell="${start}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${start}" sqref="${start}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>`);
  for (let col = 0; col < headers.length; col++) chunks.push(`<col min="${col + 1}" max="${col + 1}" width="${widths[col] || 20}" customWidth="1"/>`);
  chunks.push('</cols><sheetData>', `<row r="1" ht="31" customHeight="1">${cellXML(title, 0, 1, 1)}</row>`, `<row r="2" ht="30" customHeight="1">${cellXML(subtitle, 0, 2, 8)}</row>`, `<row r="3" ht="24" customHeight="1">${cellXML('Сформировано: ' + generated, 0, 3, 8)}</row>`, `<row r="5" ht="42" customHeight="1">${headers.map((h, col) => cellXML(h, col, 5, 2)).join('')}</row>`);
  for (let index = 0; index < rows.length; index++) {
    const row = typeof rows.at === 'function' ? rows.at(index) : rows[index], rowNumber = index + 6;
    const content = Array.isArray(row) ? row : row.cells;
    const height = rowHeight(content, widths);
    chunks.push(`<row r="${rowNumber}"${height > 20 ? ` ht="${height}" customHeight="1"` : ''}>`);
    for (let col = 0; col < content.length; col++) {
      let style = index % 2 ? 9 : 3;
      if (col === priorityColumn) style = row.priority === 'high' ? 10 : row.priority === 'check' ? 11 : 12;
      chunks.push(cellXML(content[col], col, rowNumber, style, integers.has(col) ? 5 : numeric.has(col) ? 4 : 5));
    }
    chunks.push('</row>');
    if (index % 256 === 255) chunks.flush();
  }
  chunks.push(`</sheetData><autoFilter ref="A5:${end}${bottom}"/><mergeCells count="3"><mergeCell ref="A1:${end}1"/><mergeCell ref="A2:${end}2"/><mergeCell ref="A3:${end}3"/></mergeCells><printOptions horizontalCentered="0"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`);
  return chunks.finish();
}

const STYLES = XML + `<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00;0.00"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/><color rgb="FF19324F"/></font><font><b/><sz val="17"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font><font><sz val="10"/><name val="Calibri"/><color rgb="FF526B80"/></font></fonts><fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF19324F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF5F5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE5E5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0D8"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE4F2E9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="hair"><color rgb="FFD6E2E8"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="13"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sourceFile(value) { return typeof value === 'object' && value ? value.name || value.fileName || value.filename || value.path || '' : value ?? ''; }
function comparisonCells(comparison = {}) {
  return [list(comparison.months || comparison.month), number(comparison.value), number(comparison.dropPercent), comparison.available ? 'Доступно' : 'Недоступно', comparison.reason || ''];
}
function evidenceRange(entries) {
  let first = null, last = null;
  for (const entry of entries) if (entry.at) { if (!first || entry.at < first) first = entry.at; if (!last || entry.at > last) last = entry.at; }
  return [dateCell(first), dateCell(last)];
}
const eventExamples = item => Array.isArray(item.examples) ? item.examples : item.description ? [{ at: item.at || item.first || '', description: item.description }] : [];
function exampleText(item) { return eventExamples(item).map(e => [e.at || 'Время примера не определено', e.description || ''].join(' · ')).join('\n'); }
function preExistingText(value) {
  if (!value) return '';
  return [`Ранее низкий месяц: ${value.month || 'не указан'}`, number(value.value) != null ? `ПО ${value.value} кВт·ч` : 'ПО не указан', number(value.additionalDropPercent) != null ? `Дополнительное снижение ${value.additionalDropPercent}%` : '', value.newDecline ? 'Есть новое снижение по критерию' : 'Новое снижение по критерию отсутствует', value.reason || ''].filter(Boolean).join(' · ');
}
function casesTable(cases) {
  let length = 0;
  const groups = cases.map(item => { const months = item.months?.length ? item.months : [item], start = length; length += months.length; return { item, months, start }; });
  let cursor = 0;
  return { length, at(index) {
    if (index < groups[cursor].start || index >= groups[cursor].start + groups[cursor].months.length) {
      let low = 0, high = groups.length;
      while (low < high) { const middle = (low + high) >>> 1; if (groups[middle].start <= index) low = middle + 1; else high = middle; }
      cursor = low - 1;
    }
    const { item, start } = groups[cursor], month = groups[cursor].months[index - start], comparisons = month.comparisons || item.comparisons || {};
    const evidence = month.evidence || item.evidence || {}, electrical = evidence.electrical || [], events = evidence.events || [];
    const season = month.seasonalAlternative ?? item.seasonalAlternative;
    const seasonal = typeof season === 'string' ? season : season === true ? 'Есть сезонная альтернатива по прошлогоднему сравнению' : comparisons.yearAgo?.available ? 'Не отмечена по доступному прошлогоднему сравнению' : 'Нет пригодного прошлогоднего сравнения';
    const electricalDetails = electrical.map(e => [e.at || 'Время не определено', [e.code, e.title].filter(Boolean).join(' · '), e.detail || '', e.count != null ? `Наблюдений: ${e.count}` : '', e.conditional ? 'Условный признак: требуется уточнение измерений' : '', e.timestampDetailExact === false ? 'Деталь из агрегата; принадлежность точных значений каждой дате не подтверждена' : ''].filter(Boolean).join(' · ')).join('\n');
    const eventDetails = events.map(e => [e.at || 'Время не определено', e.month ? `Месячная группа ${e.month}` : '', e.groupId ? `Группа ${e.groupId}` : '', e.timestampDetailExact === false ? 'Дата регистрации точная; исходное описание для этой даты не сохранено. Ниже только примеры с собственными датами.' : '', e.timestampDetailExact !== false ? e.description || '' : '', e.examples?.length ? exampleText(e) : '', (e.classifications || []).map(c => typeof c === 'object' && c ? c.title || c.code || '' : c).filter(Boolean).join('; ')].filter(Boolean).join(' · ')).join('\n');
    const supporting = (month.supportingMonthlyFlags || item.supportingMonthlyFlags || []).map(f => [f.scope || 'Месячный контекст', f.code, f.title, flagObservation(f)].filter(Boolean).join(' · ')).join('\n');
    const electricalCount = number(evidence.electricalCount ?? month.electricalCount ?? item.electricalCount) ?? electrical.length;
    const groupCounts = new Map(events.map(e => [e.groupId || [e.serial || item.serial, e.month || e.at?.slice(0, 7) || '', list(e.codes || [])].join('|'), number(e.count) ?? 1]));
    const eventCount = number(evidence.eventCount ?? month.eventCount ?? item.eventCount) ?? [...groupCounts.values()].reduce((sum, count) => sum + count, 0);
    const truncated = month.evidenceTruncated ?? item.evidenceTruncated ?? evidence.truncated;
    const peer = month.peerContext || item.peerContext || {};
    const registrationNote = `Регистрации за целые участвующие месячные группы: ${eventCount}; групп: ${number(evidence.eventGroupCount) ?? groupCounts.size}. Это не число независимых вскрытий и не число регистраций внутри окна 31 дня.`;
    const completeness = [registrationNote, truncated || evidence.eventDetailsTruncated ? 'Показаны представительные свидетельства и сохранённые примеры; полный журнал доступен только в исходном XLSX.' : 'Приведены сохранённые свидетельства сочетания; исходный полный журнал в XLSX.', preExistingText(month.preExistingDecline || item.preExistingDecline)].filter(Boolean).join('\n');
    return { priority: item.priority, cells: [String(item.id ?? ''), String(item.account ?? ''), item.point?.label || item.point?.key || list(item.point) || '', String(item.serial ?? ''), item.scope || 'ЛС + ТУ', SCENARIOS[item.scenario] || item.scenario || '', JOURNAL_ZONES[item.priority] || item.priority || '', number(item.score), 'month' in month ? month.month || '' : item.month || '', number('value' in month ? month.value : item.value), ...comparisonCells(comparisons.previous), ...comparisonCells(comparisons.yearAgo), ...comparisonCells(comparisons.median3), list((month.thresholdMatches || item.thresholdMatches || []).map(key => COMPARISONS[key] || key)), TEMPORAL_RELATIONS[month.temporalRelation || item.temporalRelation] || month.temporalRelation || item.temporalRelation || '', seasonal, eventCount, ...evidenceRange(events), eventDetails, electricalCount, ...evidenceRange(electrical), electricalDetails, electrical.some(e => e.conditional) ? 'Есть условные электрические признаки; они требуют подтверждения' : '', completeness, supporting, month.detail || item.detail || '', month.recommendation || item.recommendation || '', peer.tp || '', COMPARISONS[peer.comparison] || peer.comparison || '', number(peer.eligiblePeers), number(peer.declinedPeers), number(peer.sharePercent), peer.available ? peer.commonDecline ? 'Выявлен общий спад' : 'Общий спад по критерию не выявлен' : 'Нет пригодных данных', peer.available ? 'Доступно' : 'Недоступно', peer.reason || '', peer.detail || ''] };
  } };
}
function reportSheets(report, context, generated) {
  // Export only scored yellow/red cards and evidence belonging to those LS.
  const rows = report.rows, months = report.months || [], settings = normalizeSettings(report.settings || context.settings);
  const coverage = report.coverage || {}, unmatched = report.unmatched || {}, cases = report.caseDetails || [];
  const caseRows = casesTable(cases);
  let registrations = 0, matchedRegistrations = 0, matchedGroups = 0;
  for (const event of report.events || []) { const count = number(event.count) ?? 1; registrations += count; if (event.account) { matchedRegistrations += count; matchedGroups++; } }
  const res = typeof context.res === 'object' && context.res ? context.res.name || context.res.path : context.res || context.resName || report.res || 'Выбранная РЭС';
  const subtitle = `${res} · ${months.length ? monthLabel(months[0]) + ' — ' + monthLabel(months.at(-1)) : 'Период ПО не указан'}`;
  const summary = [
    ['РЭС', res], ['Источник', context.sourceName || context.source || 'Выбранный источник'],
    ['Режим данных', context.sourceMode === 'offline' ? 'Сохранённая копия на устройстве' : 'Подготовленные данные выбранной РЭС'],
    ['ЛС в анализе', number(report.counts?.accounts) ?? rows.length], ['ЛС в отчёте', rows.length],
    ['Отбор для выгрузки', 'Только жёлтые и красные карточки месячного анализа с положительными баллами. Причины, параметры, события и сопоставления относятся только к этим ЛС.'],
    ['Месячных групп журнала 46 в отчёте', (report.events || []).length],
    ['Регистраций 46 в подготовленных группах', number(coverage.events?.totalRegistrations) ?? registrations],
    ['Что означает число регистраций 46', 'Количество пригодных строк регистрации исходного журнала, сведённых в месячные группы. Это не число независимых вскрытий и не число уникальных троек C/F/J. Полные исходные описания всех строк в базе не сохраняются.'],
    ['Месячный анализ: высокий приоритет / наблюдение', `${report.counts?.red ?? 0} / ${report.counts?.amber ?? 0}`],
    ['Месячный анализ: нулевые ряды / недостаточно данных', `${report.counts?.dead ?? 0} / ${report.counts?.unknown ?? 0}`],
    ['Журналы: высокий приоритет / проверить', `${report.counts?.journalHigh ?? 0} / ${report.counts?.journalCheck ?? 0}`],
    ['Объект анализа', 'Месячные алгоритмы: один итоговый ряд на ЛС, сумма всех его ТУ. Совместные сочетания журналов: отдельно ЛС + ТУ + ПУ. Повторные строки сопоставлений не являются дополнительным объёмом ПО.'],
    ['Что означает отбор', 'Наблюдаемые признаки для проверки; сами по себе они не устанавливают причину изменения потребления.'],
    ['Оценка отклонения ПО', 'Ориентир действующей месячной модели, не фактический небаланс и не объём к доначислению. Журнал 31 не используется для расчёта кВт·ч недоучёта.'],
    ['Коэффициенты', 'К ПО коэффициент ТТ повторно не применяется. Мгновенные величины журнала 31 приводятся в единицах исходной выгрузки; сравнение с разрешённой мощностью требует подтверждения коэффициентов.'],
    ['Сопоставление', 'По серийному номеру ПУ через реестр выбранной РЭС. Неоднозначные и отсутствующие связи не приписываются потребителю.'],
    ['Связь события и ПО', 'Совпадение по времени означает совместное наблюдение, а не доказанную причинную связь. ПО имеет месячный шаг, журнал — точное время события.'],
    ['Пустые значения ПО', 'Пустая ячейка — нет полного значения; 0 — известный нулевой объём. Итог в строке суммирует только известные месяцы и может быть неполным. Отрицательные корректировки сохранены, но исключены из поиска месячных признаков.'],
    ['Зоны месячного анализа', `Режим: ${settings.zone === 'loss' ? 'оценка отклонения' : 'баллы'}. Высокий приоритет ≥ ${settings.zone === 'loss' ? settings.lossRed + ' кВт·ч' : settings.red + ' баллов'}; наблюдение ≥ ${settings.zone === 'loss' ? settings.lossAmber + ' кВт·ч' : settings.amber + ' баллов'}.`],
    ['Журнальные признаки', 'Приоритет и баллы журналов показаны отдельно; исходные месячные зоны, баллы и оценка отклонения сохранены. На ПУ учитывается самое сильное сочетание один раз: оба журнала + снижение — 25, один журнал + снижение — 15, самостоятельный значимый признак либо проверочное сочетание — 10. Сезонная альтернатива или ранее существовавший спад без нового снижения ограничивает сочетание 10 баллами. Подтверждающие факты с весом 0 уже учтены в сочетании; справочные признаки отдельно баллов не добавляют. Суммарный предел — 100; это не вероятность нарушения.'],
  ];
  summary.push(['Совокупности признаков: сочетаний / строк по месяцам', `${cases.length} / ${caseRows.length}`], ['Совокупности признаков: высокий приоритет / проверить', `${cases.filter(c => c.priority === 'high').length} / ${cases.filter(c => c.priority === 'check').length}`], ['Критерии сравнения ПО', 'Снижение минимум на 30% к предыдущему месяцу или тому же месяцу прошлого года при базе минимум 30 кВт·ч; либо минимум на 50% к медиане трёх непосредственно предыдущих полных положительных месяцев. Пустые, отрицательные и непригодные базы имеют явную причину недоступности.'], ['Период совместных свидетельств', 'Журналы связываются по одному ПУ и одной ТУ: временная близость 31 дня. Для месяца ПО рассматриваются свидетельства этого и двух предшествующих календарных месяцев. Все даты приводятся явно.'], ['Сезонность и причинность', 'Прошлогоднее сравнение показано отдельно как возможная сезонная альтернатива. Если низкий уровень был уже до признаков, а нового снижения от него минимум на 30% нет, сочетание имеет проверочный приоритет и не означает начало спада после события. Совпадение в одном месяце не определяет порядок событий и изменения ПО. Назначение объекта и даты замены ПУ требуют отдельной проверки.'], ['Контекст общего спада ТП', 'Справочная альтернатива: снижение минимум на 30% к предыдущему месяцу/прошлому году или на 50% к трёхмесячной медиане наблюдается у 60% и более из минимум шести других ЛС того же ТП, при базе минимум 30 кВт·ч. Проверяемый ЛС исключён; отсутствующие и непригодные сравнения не принимаются за ноль. Месячные баллы и оценки не изменяются.'], ['Нагрузка при нулевом ПО', 'Отдельная проверка: последнее пригодное измерение активной мощности минимум 0,2 кВт и известный нулевой ПО той же ТУ в том же завершённом месяце. Мгновенная мощность не переводится в кВт·ч недоучёта.']);
  for (const [scenario, label] of Object.entries(SCENARIOS)) summary.push([`Совокупности: ${label}`, cases.filter(c => c.scenario === scenario).length]);
  summary.push(['Электрические критерии 31', 'Обратная P фазы ≤ −0,1 кВт при нагрузке; U фазы < 50 В при наличии нагрузки; практически нулевая P при подтверждённой нагрузке; I нейтрали больше суммы фазных токов на 20% и минимум на 0,5 А. Для P/Q/S: модуль P либо √(P²+Q²) выше S с расхождением больше 0,15 и 35% большего значения. Все фактические параметры и даты показаны в свидетельствах.'], ['Условные электрические критерии', 'Измеренный ток фазы от 0 до 0,02 А при всех U ≥ 180 В и токе другой фазы ≥ 1 А; расхождение S и U×I/1000 больше 0,2 кВА и 40% только в явно не масштабированной выгрузке с распознанными единицами; углы U–I и подтверждённый cos φ/P/Q не согласуются с большими допусками. Условные наблюдения требуют независимого журнального события и снижения ПО. Перекос фаз и низкий cos φ сами по себе остаются справочными.'], ['Физическая интерпретация 31', 'Критерии служат отбором для проверки, не классом точности ПУ. Гармоники могут увеличить I нейтрали относительно одной фазы и S относительно √(P²+Q²); cos φ основной гармоники и полный PF могут различаться. Отсутствующий ток не является измеренным нулём; неизвестные коэффициенты и несинхронные величины требуют уточнения.']);
  for (const role of ['registry', 'consumption', 'incoming', 'instant', 'events']) summary.push([`Файл: ${SOURCE_NAMES[role]}`, sourceFile(context.files?.[role]) || 'Не указан / не загружен']);
  for (const role of ['instant', 'events']) {
    const c = coverage[role] || {}, u = unmatched[role] || {};
    summary.push([`${SOURCE_NAMES[role]}: доступность`, c.loaded ? 'Загружен' : 'Не загружен; соответствующие признаки не рассчитываются'], [`${SOURCE_NAMES[role]}: ПУ всего / сопоставлено`, `${c.totalMeters ?? 0} / ${c.matchedMeters ?? 0}`], [`${SOURCE_NAMES[role]}: начало`, dateCell(c.first)], [`${SOURCE_NAMES[role]}: конец`, dateCell(c.last)], [`${SOURCE_NAMES[role]}: не сопоставлено ПУ / строк`, `${u.meters ?? 0} / ${u.rows ?? 0}`], [`${SOURCE_NAMES[role]}: причины несопоставления`, unmatchedReasons(u.reasons) || (u.meters ? 'Не сообщены' : 'Нет несопоставленных ПУ')], [`${SOURCE_NAMES[role]}: качество данных`, uniqueLines(c.warnings) || 'Дополнительных замечаний нет']);
    if (role === 'events') summary.push(['Журнал 46: регистраций сопоставлено / всего', `${c.matchedRegistrations ?? matchedRegistrations} / ${c.totalRegistrations ?? registrations}`], ['Журнал 46: месячных групп сопоставлено / всего', `${c.matchedGroups ?? matchedGroups} / ${c.totalGroups ?? (report.events || []).length}`], ['Журнал 46: состав группы', 'Один ПУ, один календарный месяц и один точный набор активных категорий. Сохраняются первая/последняя регистрация, дневные количества и до трёх реальных примеров описания J с собственными датами. Прочие описания хранятся отдельной группой без активных категорий.'], ['Журнал 46: полная расшифровка', 'Все C/F/J следует сверять с исходным XLSX источника. Лист «События» содержит компактные месячные группы и ограниченные примеры; он не заменяет полный исходный журнал.']);
    const state = context.journalStates?.[role];
    if (state) summary.push([`${SOURCE_NAMES[role]}: состояние загрузки`, state.state === 'error' ? `Ошибка: ${state.error || state.message || 'Причина не передана'}` : state.state === 'missing' ? 'Файл не найден в папке РЭС' : state.state === 'ready' ? 'Готов' : state.state === 'loading' ? 'Загрузка ещё выполняется' : state.state || 'Не загружен']);
  }
  const coefficientName = mode => mode === 'unscaled' ? 'Без коэффициентов трансформации' : mode === 'scaled' ? 'С коэффициентами трансформации' : 'Применение коэффициентов не подтверждено';
  summary.push(['Журнал 31: коэффициенты', coefficientName(coverage.instant?.coefficientMode)], ['Журнал 31: период выгрузки с', dateCell(coverage.instant?.reportPeriod?.from)], ['Журнал 31: период выгрузки по', dateCell(coverage.instant?.reportPeriod?.to)]);
  if (report.warnings?.length) summary.push(['Проверка исходных данных', uniqueLines(report.warnings)]);
  for (const [key, meta] of Object.entries(ALG_META)) {
    const tune = buildTune(settings.levels)[key];
    const state = settings.algOff[key] ? 'Отключён' : ['zeroAlive', 'peers', 'season', 'imb', 'dzero', 'dsync'].includes(key) ? 'Только контур ТП / другие форматы; в отчёте ЛС не применяется' : 'Включён';
    summary.push([`${meta.code} · ${meta.title}`, `${state}; ${LEVEL_NAMES[tune.level]}; ${TUNE_HINT[key]?.(tune) || ''}; вес ×${tune.ptsF}`]);
  }
  summary.push(['Дополнительные приоритеты ПО', BOOST_DEFS.filter(b => settings.boosts[b.id]).map(b => `${b.label} (+${b.pts})`).join('; ') || 'Не включены']);
  const anomalies = [], reasons = [], consumption = [], metricRows = [];
  rows.forEach((row, index) => {
    const r = resultOf(row), m = r.meter || {}, account = String(row.account ?? m.account ?? ''), name = row.name ?? m.name ?? '', serials = list(row.serials || m.serials), points = list(row.points), flags = r.flags || [];
    const why = uniqueLines(row.reasons?.length ? row.reasons : flags.map(f => [f.code, f.title, flagObservation(f)].filter(Boolean).join(' · '))) || (r.cls === 'dead' ? 'Месячный ряд практически нулевой.' : r.cls === 'unknown' ? 'Недостаточно полных данных для анализа.' : 'Приоритет по месячной модели.');
    const recs = uniqueLines(row.recommendations?.length ? row.recommendations : flags.map(f => f.recommendation || MONTH_RECOMMENDATIONS[f.code])) || (r.cls === 'unknown' ? 'Проверить заполнение ПО всех ТУ и исправить исходную выгрузку.' : 'Сверить статус подключения, контрольные показания, схему учёта, пломбы и фактическую нагрузку.');
    const dates = flags.flatMap(f => [f.first, f.last]).filter(Boolean).sort();
    const priority = r.journalPriority === 'high' || r.cls === 'red' ? 'high' : r.journalPriority === 'check' || r.cls === 'amber' ? 'check' : 'none';
    anomalies.push({ priority, cells: [index + 1, JOURNAL_ZONES[r.journalPriority] || 'Нет данных', ZONES[r.monthlyCls || r.cls] || r.cls || '', number(r.monthlyScore ?? r.score), number(r.journalScore), account, name, row.address ?? m.address ?? '', serials, points, list(row.tpNames || m.tpNames), number(m.power), number(r.total), (m.values || []).filter(v => number(v) != null).length, months.length, number(r.baseline), number(r.lossKwh), why, recs, dateCell(dates[0]), dateCell(dates.at(-1))] });
    for (const f of flags) reasons.push([account, name, serials, points, f.code || '', f.title || '', SOURCE_NAMES[f.source] || f.source || 'Полезный отпуск', number(f.pts), dateCell(f.first), dateCell(f.last), number(f.count), flagObservation(f), f.recommendation || MONTH_RECOMMENDATIONS[f.code] || recs]);
    if (!flags.length) reasons.push([account, name, serials, points, r.cls === 'dead' ? 'ZERO' : 'DATA', r.cls === 'dead' || r.cls === 'unknown' ? ZONES[r.cls] : 'Качество исходных данных', 'Полезный отпуск', null, null, null, null, why, recs]);
    else {
      if (m.incomplete) reasons.push([account, name, serials, points, 'DATA_MISSING', 'Неполные месячные объёмы', 'Полезный отпуск', null, null, null, m.incomplete, `Неполных месяцев: ${m.incomplete}; отсутствующие объёмы не принимались за ноль.`, 'Проверить заполнение ПО всех ТУ и исходную выгрузку.']);
      if (m.negative) reasons.push([account, name, serials, points, 'DATA_NEGATIVE', 'Отрицательные корректировки', 'Полезный отпуск', null, null, null, null, 'Отрицательные корректировки сохранены в сумме и графике, исключены из поиска остановки ПУ.', 'Сверить корректировки с документами и контрольными показаниями.']);
    }
    consumption.push([account, name, points, serials, ...months.map((_, i) => number(m.values?.[i])), number(r.total)]);
  });
  const metrics = Array.isArray(report.metrics) ? report.metrics : rows.flatMap(row => (resultOf(row).journal?.latestMetrics || []).map(m => ({ account: row.account ?? resultOf(row).meter?.account ?? '', ...m })));
  for (const item of metrics) {
    const values = Array.isArray(item.values) ? Object.fromEntries((item.fields || []).map((key, i) => [key, item.values[i]])) : item.values || {};
    const period = item.reportPeriod || coverage.instant?.reportPeriod || {};
    metricRows.push([String(item.account ?? ''), String(item.serial ?? ''), dateCell(item.at), coefficientName(item.coefficientMode || coverage.instant?.coefficientMode), dateCell(period.from), dateCell(period.to), ...INSTANT_METRICS.map(m => number(values[m.key]))]);
  }
  summary.splice(6, 0, ['ПУ с последними параметрами в отчёте', metricRows.length]);
  // Project compact groups lazily; do not expand every source registration.
  const events = { length: (report.events || []).length, at(index) { const e = report.events[index], classifications = (e.classifications || []).map(c => typeof c === 'object' && c ? c.title || c.code || '' : c).filter(Boolean); return [String(e.account ?? ''), String(e.serial ?? ''), e.month || e.at?.slice(0, 7) || '', dateCell(e.first || e.at), dateCell(e.last || e.at), number(e.count) ?? 1, classifications.length ? list(classifications) : list(e.codes) || e.title || 'Без активной распознанной категории', exampleText(e), eventExamples(e).length, e.examplesTruncated ? 'Сохранены только примеры; остальные описания в исходном XLSX' : 'Сохранённые примеры пакета; это не перечень каждой регистрации', e.account ? 'Однозначно сопоставлено с ЛС + ТУ' : e.mappingReason || 'Серийный номер не сопоставлен', (e.days || []).map(([day, first, last, count]) => `${day}: ${first} — ${last}; регистраций ${count}`).join('\n'), String(e.groupId || '')]; } };
  return [
    { title: 'Сводка', subtitle, headers: ['Параметр', 'Значение / пояснение'], widths: [43, 112], rows: summary },
    { title: 'Аномалии', subtitle, headers: ['№', 'Приоритет журналов', 'Зона месячного анализа', 'Баллы ПО', 'Баллы журналов', 'Лицевой счёт', 'Потребитель / ФИО', 'Адрес', 'Серийные номера ПУ', 'Точки учёта', 'ТП', 'Разрешённая мощность, кВт', 'ПО известных месяцев, кВт·ч', 'Месяцев со значением', 'Месяцев всего', 'Базовый уровень ПО, кВт·ч/мес.', 'Оценка отклонения модели ПО, кВт·ч', 'Конкретные причины отбора', 'Рекомендации к проверке', 'Первое журнальное наблюдение', 'Последнее журнальное наблюдение'], widths: [6, 22, 25, 12, 14, 18, 30, 34, 25, 30, 24, 18, 19, 14, 13, 20, 22, 78, 68, 23, 23], rows: anomalies, priorityColumn: 1, numberColumns: [11, 12, 15, 16], integerColumns: [0, 3, 4, 13, 14] },
    { title: 'Причины', subtitle, headers: ['Лицевой счёт', 'Потребитель / ФИО', 'Серийные номера ПУ', 'Точки учёта', 'Код признака', 'Признак', 'Источник', 'Вес признака, баллы', 'Начало наблюдения', 'Конец наблюдения', 'Число наблюдений', 'Фактические данные и основание отбора', 'Рекомендуемая проверка'], widths: [18, 30, 25, 30, 15, 35, 22, 16, 23, 23, 17, 100, 75], rows: reasons, integerColumns: [7, 10] },
    { title: 'События', subtitle: subtitle + ' · одна месячная группа ПУ / категорий; количество регистраций не означает независимые вскрытия', headers: ['Сопоставленный лицевой счёт', 'C · Серийный номер ПУ', 'Календарный месяц', 'F · Первая регистрация', 'F · Последняя регистрация', 'Количество регистраций источника', 'Активные категории группы', 'J · Сохранённые примеры с собственными датами', 'Число сохранённых примеров', 'Полнота описаний J', 'Сопоставление / причина отсутствия ЛС', 'Регистрации по дням: даты и количества', 'Идентификатор месячной группы'], widths: [24, 25, 22, 25, 25, 26, 55, 120, 25, 90, 70, 110, 40], rows: events, freezeColumns: 2, integerColumns: [5, 8] },
    { title: 'Потребление', subtitle: subtitle + ' · один ряд на ЛС, все ТУ; пусто = нет полного значения, 0 = известный ноль', headers: ['Лицевой счёт', 'Потребитель / ФИО', 'Точки учёта', 'Серийные номера ПУ', ...months.map(m => monthLabel(m) + ', кВт·ч'), 'ПО известных месяцев, кВт·ч'], widths: [18, 32, 30, 25, ...months.map(() => 19), 24], rows: consumption, numberColumns: Array.from({ length: months.length + 1 }, (_, i) => i + 4), freezeColumns: 4 },
    { title: 'Параметры ПУ', subtitle: subtitle + ' · последнее измерение каждого ПУ отобранных ЛС, в единицах исходной выгрузки; не расчёт энергии', headers: ['Лицевой счёт', 'Серийный номер ПУ', 'Время измерения', 'Коэффициенты трансформации', 'Период журнала 31 с', 'Период журнала 31 по', ...INSTANT_METRICS.map(m => m.title + (m.unit ? ', ' + m.unit : ''))], widths: [18, 25, 25, 42, 24, 24, ...INSTANT_METRICS.map(() => 22)], rows: metricRows, numberColumns: INSTANT_METRICS.map((_, i) => i + 6), freezeColumns: 2 },
    { title: 'Сопоставления', subtitle: subtitle + ' · одна строка на сочетание и месяц ПО; объёмы этих строк не суммируются между сочетаниями', headers: ['Идентификатор сочетания', 'Лицевой счёт', 'Точка учёта', 'Серийный номер ПУ', 'Уровень сопоставления', 'Сценарий', 'Приоритет проверки', 'Баллы сочетания', 'Месяц ПО', 'ПО этой ТУ, кВт·ч', 'Предыдущий месяц', 'ПО предыдущего месяца, кВт·ч', 'Снижение к предыдущему, %', 'Предыдущее сравнение: доступность', 'Предыдущее сравнение: причина недоступности', 'Тот же месяц прошлого года', 'Прошлогодний ПО, кВт·ч', 'Снижение к прошлому году, %', 'Прошлогоднее сравнение: доступность', 'Прошлогоднее сравнение: причина недоступности', 'Три предшествующих месяца', 'Медиана трёх месяцев, кВт·ч', 'Снижение к медиане, %', 'Сравнение с медианой: доступность', 'Сравнение с медианой: причина недоступности', 'Выполненные критерии снижения', 'Отношение дат журналов к месяцу ПО', 'Сезонная альтернатива', 'Регистраций 46 в целых месячных группах', 'Первое свидетельство 46', 'Последнее свидетельство 46', 'Даты и описания свидетельств 46', 'Число электрических свидетельств 31', 'Первое свидетельство 31', 'Последнее свидетельство 31', 'Даты, параметры и точность электрических свидетельств 31', 'Условность электрических признаков', 'Полнота свидетельств сочетания', 'Дополнительный месячный контекст', 'Конкретное основание сопоставления', 'Рекомендуемая проверка', 'ТП для общего контекста', 'Сравнение соседних ЛС', 'Пригодных других ЛС', 'Других ЛС со снижением', 'Доля других ЛС со снижением, %', 'Общий спад ТП', 'Контекст ТП: доступность', 'Контекст ТП: причина недоступности', 'Контекст ТП: фактические данные'], widths: [30, 18, 35, 25, 22, 35, 23, 14, 18, 22, 22, 24, 22, 24, 65, 24, 24, 22, 24, 65, 38, 25, 23, 24, 65, 38, 75, 65, 20, 24, 24, 110, 23, 24, 24, 120, 70, 95, 90, 120, 100, 25, 32, 23, 25, 25, 33, 26, 65, 100], rows: caseRows, numberColumns: [9, 11, 12, 16, 17, 21, 22, 45], integerColumns: [7, 28, 32, 43, 44], priorityColumn: 6, freezeColumns: 4 },
  ].map(sheet => ({ ...sheet, generated }));
}

function selectedReport(report) {
  if (!report || !Array.isArray(report.rows)) throw new Error('Нет результатов анализа выбранной РЭС для выгрузки.');
  const rows = report.rows.filter(row => { const r = resultOf(row); return ['red', 'amber'].includes(r.cls) && r.score > 0; });
  const accounts = new Set(rows.map(row => idKey(row.account ?? resultOf(row).meter?.account)));
  const selected = entries => (entries || []).filter(entry => accounts.has(idKey(entry.account)));
  return { ...report, rows, counts: { ...report.counts, selected: rows.length }, events: selected(report.events), metrics: selected(report.metrics), caseDetails: selected(report.caseDetails) };
}
function reportClock(context) {
  const now = context.generatedAt instanceof Date ? context.generatedAt : new Date(context.generatedAt || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('Некорректная дата формирования отчёта.');
  const generated = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now) + ' МСК';
  return { now, generated };
}

/** Plan bounded XLSX files without allocating their ZIP/XML buffers together. */
export async function planAnomalyWorkbooks(report, context = {}, { maxBytes = 12 * 1024 * 1024, onProgress = () => {}, assertCurrent = () => {} } = {}) {
  report = selectedReport(report);
  const clock = reportClock(context), sheets = reportSheets(report, context, clock.generated), encoder = new TextEncoder();
  const columns = [null, 5, 0, 0, 0, 0, 1], costs = sheets.map(sheet => new Uint32Array(sheet.rows.length));
  const groups = new Map(report.rows.map(row => [idKey(row.account ?? resultOf(row).meter?.account), sheets.map(() => [])]));
  let processed = 0, total = sheets.slice(1).reduce((sum, sheet) => sum + sheet.rows.length, 0);
  for (let s = 1; s < sheets.length; s++) for (let i = 0; i < sheets[s].rows.length; i++) {
    assertCurrent();
    const row = sheets[s].rows.at(i), cells = Array.isArray(row) ? row : row.cells, group = groups.get(idKey(cells[columns[s]]));
    if (!group) throw new Error('Свидетельство отчёта не связано с отобранным потребителем.');
    group[s].push(i); costs[s][i] = encoder.encode(dataRowXML(row, i, sheets[s])).byteLength;
    if (++processed % 500 === 0) { onProgress({ phase: 'parts', done: processed, total }); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  // Reserve space for part labels and Excel row numbers. All evidence is measured
  // as escaped UTF-8 worksheet XML, rather than estimating its compressed size.
  const overhead = 8192 + sheets.reduce((sum, sheet, i) => sum + sheetXML({ ...sheet, rows: i ? [] : sheet.rows }, clock.generated, MAX_REPORT_XML_BYTES).byteLength, 0);
  const budget = Math.min(MAX_REPORT_XML_BYTES, maxBytes);
  if (!Number.isFinite(budget) || budget <= overhead) throw new Error('Недостаточный размер части Excel-отчёта.');
  const parts = []; let current;
  const begin = () => { current = { indices: sheets.map(() => []), accounts: new Set(), xmlBytes: overhead }; parts.push(current); };
  const add = (s, i) => { current.indices[s].push(i); current.xmlBytes += costs[s][i]; };
  begin();
  for (const [account, group] of groups) {
    const cardCost = [...group[1].map(i => costs[1][i]), ...group[4].map(i => costs[4][i])].reduce((sum, bytes) => sum + bytes, 0);
    const groupCost = group.reduce((sum, indices, s) => sum + indices.reduce((n, i) => n + costs[s][i], 0), 0);
    if (current.accounts.size && current.xmlBytes + groupCost > budget) begin();
    const addCard = () => { current.accounts.add(account); for (const s of [1, 4]) for (const i of group[s]) add(s, i); };
    if (overhead + cardCost > budget) throw new Error('Карточка потребителя превышает размер части Excel. Проверьте длину исходных описаний.');
    addCard();
    for (const s of [2, 3, 5, 6]) for (const i of group[s]) {
      if (overhead + cardCost + costs[s][i] > budget) throw new Error('Одна строка свидетельства превышает размер части Excel. Проверьте исходное описание.');
      if (current.xmlBytes + costs[s][i] > budget) { begin(); addCard(); }
      add(s, i);
    }
  }
  return { count: report.rows.length, ...clock, parts: parts.map((part, index) => ({
    count: part.accounts.size, xmlBytes: part.xmlBytes,
    sheets: sheets.map((sheet, s) => ({ ...sheet, subtitle: `${sheet.subtitle} · часть ${index + 1} из ${parts.length}`, rows: s ? {
      length: part.indices[s].length, at: i => sheet.rows.at(part.indices[s][i]),
    } : [...sheet.rows, ['Часть отчёта', `${index + 1} из ${parts.length}`], ['ЛС в этой части', part.accounts.size], ['Чтение нескольких частей', 'При большом числе свидетельств одна карточка и её потребление повторяются в частях с продолжением. Не суммируйте повторённое потребление между файлами. Все строки свидетельств распределены без пропусков.']] })),
  })) };
}

/** Build a styled XLSX in the existing worker, without another workbook dependency. */
export function buildAnomalyWorkbook(report, XLSX, context = {}) {
  const clock = reportClock(context);
  return writeWorkbook(reportSheets(selectedReport(report), context, clock.generated), XLSX, clock);
}
export function buildAnomalyWorkbookPart(plan, index, XLSX, onProgress = () => {}) {
  if (!plan?.parts?.[index]) throw new Error('Часть отчёта недоступна. Сформируйте отчёт заново.');
  return writeWorkbook(plan.parts[index].sheets, XLSX, plan, onProgress);
}
function writeWorkbook(sheets, XLSX, { now, generated }, onProgress = () => {}) {
  if (!XLSX?.CFB?.utils?.cfb_new || !XLSX.CFB.write) throw new Error('Модуль Excel недоступен. Перезагрузите приложение.');
  const archive = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_del(archive, '\u0001Sh33tJ5');
  const encoder = new TextEncoder(); let archiveBytes = 0;
  const add = (path, content) => { const bytes = content instanceof Uint8Array ? content : encoder.encode(content); archiveBytes += bytes.byteLength; if (archiveBytes > MAX_REPORT_XML_BYTES) throw new Error('Отчёт слишком большой для безопасной выгрузки на устройстве (лимит XML 96 МБ). Уменьшите период исходного журнала и повторите подготовку.'); XLSX.CFB.utils.cfb_add(archive, path, bytes); };
  add('[Content_Types].xml', XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
  add('docProps/core.xml', XML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Анализ аномалий выбранной РЭС</dc:title><dc:creator>Web_abonent</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now.toISOString()}</dcterms:created></cp:coreProperties>`);
  add('docProps/app.xml', XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Web_abonent</Application></Properties>');
  add('xl/workbook.xml', XML + `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.title)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="0"/></workbook>`);
  add('xl/_rels/workbook.xml.rels', XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  add('xl/styles.xml', STYLES);
  // Add one sheet at a time: the journal's original workbook is never duplicated.
  sheets.forEach((sheet, i) => { onProgress({ phase: 'file', done: i, total: sheets.length }); add(`xl/worksheets/sheet${i + 1}.xml`, sheetXML(sheet, generated, MAX_REPORT_XML_BYTES - archiveBytes)); });
  const bytes = XLSX.CFB.write(archive, { fileType: 'zip', type: 'array', compression: true });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
