import { flagObservation } from './analysis-observations.js';
import { idKey } from './core.js';

const MAX_ROWS = 1048576, MAX_COLUMNS = 16384, MAX_TEXT = 32767;
const MAX_REPORT_XML_BYTES = 96 * 1024 * 1024;
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function xml(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
const uniqueLines = value => [...new Set((Array.isArray(value) ? value : [value]).filter(v => v != null && String(v).trim()).map(String))].join('\n');
const resultOf = row => row.result || row;
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
    let style = col === 0 ? index % 2 ? 14 : 13 : index % 2 ? 9 : 3;
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
      let style = col === 0 ? index % 2 ? 14 : 13 : index % 2 ? 9 : 3;
      if (col === priorityColumn) style = row.priority === 'high' ? 10 : row.priority === 'check' ? 11 : 12;
      chunks.push(cellXML(content[col], col, rowNumber, style, integers.has(col) ? 5 : numeric.has(col) ? 4 : 5));
    }
    chunks.push('</row>');
    if (index % 256 === 255) chunks.flush();
  }
  chunks.push(`</sheetData><autoFilter ref="A5:${end}${bottom}"/><mergeCells count="3"><mergeCell ref="A1:${end}1"/><mergeCell ref="A2:${end}2"/><mergeCell ref="A3:${end}3"/></mergeCells><printOptions horizontalCentered="0"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`);
  return chunks.finish();
}

const STYLES = XML + `<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00;0.00"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/><color rgb="FF19324F"/></font><font><b/><sz val="17"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font><font><sz val="10"/><name val="Calibri"/><color rgb="FF526B80"/></font></fonts><fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF19324F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF5F5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE5E5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0D8"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE4F2E9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="hair"><color rgb="FFD6E2E8"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="15"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" vertical="top"/></xf><xf numFmtId="49" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function shortDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
}
function dateRange(first, last) {
  const from = shortDate(first), to = shortDate(last);
  return from && to && from !== to ? `${from} — ${to}` : from || to || 'Дата не указана';
}
function flagMonths(flag) {
  const months = [...new Set((flag.months || [flag.month]).filter(Boolean))].sort();
  const label = value => String(value).replace(/^(\d{4})-(\d{2})$/, '$2.$1');
  return months.length ? months.map(label).join(', ') : '';
}
function correlationReason(flag, multipleMeters) {
  const detail = String(flag.detail || ''), notes = [];
  if (/Низкий уровень наблюдался до|новое снижение после них не подтверждено/i.test(detail)) notes.push('Низкое потребление было до событий; нового снижения не подтверждено');
  else if (/порядок изменения потребления внутри месяца не установлен/i.test(detail)) notes.push('Совпадение в одном месяце, порядок изменений неизвестен');
  else if (/Снижение зарегистрировано в последующем месяце/i.test(detail)) notes.push('Снижение в последующем месяце, связь требует проверки');
  if (/возможна сезонность/i.test(detail)) notes.push('Возможна сезонность');
  return [flag.title, multipleMeters && flag.serial ? `ПУ ${flag.serial}` : '', flagMonths(flag), ...notes].filter(Boolean).join('. ');
}
function reasonsFor(row, serials) {
  const result = resultOf(row), flags = result.flags || [], reasons = [];
  for (const flag of flags) {
    if (!flag.source || ['monthly', 'consumption'].includes(flag.source)) reasons.push([flag.title, flagObservation(flag)].filter(Boolean).join(': '));
    else if (flag.source === 'correlation' && (flag.pts > 0 || flag.supportingEvidence === true)) reasons.push(correlationReason(flag, serials.length > 1));
  }
  if (!reasons.length) reasons.push(...(row.reasons || []));
  if (!reasons.length) reasons.push('По сумме признаков месячного потребления');
  if (result.meter?.pointCount > 1) reasons.unshift(`Потребление оценено суммарно по ${result.meter.pointCount} точкам ЛС ${row.account || result.meter.account}`);
  return uniqueLines(reasons);
}
function journalsFor(row, serials, coverage = {}) {
  const flags = (resultOf(row).flags || []).filter(flag => ['instant', 'events'].includes(flag.source));
  const lines = flags.map(flag => {
    const conditional = flag.conditional ? ' (условный признак)' : flag.informational ? ' (контекст)' : '';
    const label = `${flag.source === 'events' ? '46' : '31'}: ${flag.title || 'Признак ПУ'}${conditional}`;
    // The existing analysis already combines duplicate registrations by PU/type.
    // Do not copy examples, daily counters or individual source measurements.
    const measured = flag.source === 'instant' ? String(flag.detail || '').replace(/^ПУ [^:]+:\s*/, '').split(' Наблюдений:')[0].trim().replace(/\.+$/, '') : '';
    const count = Number.isFinite(flag.count) && flag.count > 0 ? `регистраций: ${flag.count}` : '';
    return [serials.length > 1 && flag.serial ? `ПУ ${flag.serial}` : '', label, dateRange(flag.first, flag.last), count, measured].filter(Boolean).join('. ');
  });
  if (lines.length) return uniqueLines(lines);
  const scope = row.journalCoverage || resultOf(row).journal?.coverage;
  if (!coverage.instant?.loaded && !coverage.events?.loaded) return 'Журналы не загружены';
  if (scope && !scope.instant?.matchedMeters && !scope.events?.matchedMeters) return 'По этим ПУ нет сопоставленных записей в журналах';
  return 'В загруженных журналах признаки не найдены';
}
function reportSheet(report, context, generated) {
  const res = typeof context.res === 'object' ? context.res?.name || context.res?.path : context.res;
  const journals = ['instant', 'events'].map((role, i) => {
    const state = context.journalStates?.[role];
    return `Журнал ${i ? '46' : '31'}: ${state?.state === 'error' ? 'ошибка загрузки' : report.coverage?.[role]?.loaded ? 'загружен' : 'не загружен'}`;
  }).join('. ');
  const rows = [...report.rows].sort((a, b) => (resultOf(a).cls === 'red' ? 0 : 1) - (resultOf(b).cls === 'red' ? 0 : 1)
    || (resultOf(b).score || 0) - (resultOf(a).score || 0)).map(row => {
    const result = resultOf(row), serials = [...new Set((row.serials || result.meter?.serials || []).map(String).filter(value => value.trim()))];
    return { priority: result.cls === 'red' ? 'high' : 'check', cells: [
      serials.length ? serials.join('\n') : `ПУ не указан (ЛС ${row.account || result.meter?.account || 'не указан'})`,
      result.cls === 'red' ? 'Красный' : 'Жёлтый', reasonsFor(row, serials), journalsFor(row, serials, report.coverage),
    ] };
  });
  return { title: 'Аномалии', subtitle: [res || 'Выбранная РЭС', `Карточек: ${rows.length}`, journals].join('. '),
    generated, headers: ['Номер ПУ', 'Статус', 'Причины флагов', 'События из журналов'], widths: [24, 12, 68, 68], rows, priorityColumn: 1, freezeColumns: 2 };
}
function selectedReport(report) {
  if (!report || !Array.isArray(report.rows)) throw new Error('Нет результатов анализа выбранной РЭС для выгрузки.');
  // Journal priorities supplement the card; selection follows its monthly zone.
  return { ...report, rows: report.rows.filter(row => { const r = resultOf(row); return ['red', 'amber'].includes(r.cls) && r.score > 0; }) };
}
function reportClock(context) {
  const now = context.generatedAt instanceof Date ? context.generatedAt : new Date(context.generatedAt || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('Некорректная дата формирования отчёта.');
  const generated = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now) + ' МСК';
  return { now, generated };
}

/** Split the compact rows without repeating cards or allocating all XLSX files. */
export function planAnomalyWorkbooks(report, context = {}, options = {}) {
  return planCompactWorkbooks(reportSheet(selectedReport(report), context), context, options);
}
export async function planCompactWorkbooks(sheet, context = {}, { maxBytes = 12 * 1024 * 1024, onProgress = () => {}, assertCurrent = () => {} } = {}) {
  const clock = reportClock(context), encoder = new TextEncoder();
  const overhead = 8192 + sheetXML({ ...sheet, rows: [] }, clock.generated, MAX_REPORT_XML_BYTES).byteLength;
  const budget = Math.min(MAX_REPORT_XML_BYTES, maxBytes);
  if (!Number.isFinite(budget) || budget <= overhead) throw new Error('Недостаточный размер части Excel-отчёта.');
  const parts = []; let current;
  const rowAt = index => typeof sheet.rows.at === 'function' ? sheet.rows.at(index) : sheet.rows[index];
  const begin = () => { current = { start: 0, end: 0, xmlBytes: overhead }; parts.push(current); };
  begin();
  for (let index = 0; index < sheet.rows.length; index++) {
    assertCurrent();
    const cost = encoder.encode(dataRowXML(rowAt(index), index, sheet)).byteLength;
    if (overhead + cost > budget) throw new Error('Одна карточка превышает размер части Excel. Проверьте длину исходных причин.');
    if (current.end > current.start && (current.xmlBytes + cost > budget || current.end - current.start >= MAX_ROWS - 5)) { begin(); current.start = current.end = index; }
    current.end = index + 1; current.xmlBytes += cost;
    if (index % 500 === 499) { onProgress({ phase: 'parts', done: index + 1, total: sheet.rows.length }); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  assertCurrent();
  return { count: sheet.rows.length, ...clock, parts: parts.map((part, index) => ({
    count: part.end - part.start, xmlBytes: part.xmlBytes,
    sheets: [{ ...sheet, subtitle: `${sheet.subtitle}. Часть ${index + 1} из ${parts.length}`, rows: {
      length: part.end - part.start, at: i => rowAt(part.start + i),
    } }],
  })) };
}

/** Build a styled XLSX in the existing worker, without another workbook dependency. */
export function buildAnomalyWorkbook(report, XLSX, context = {}) {
  return buildCompactWorkbook(reportSheet(selectedReport(report), context), XLSX, context);
}
export function buildCompactWorkbook(sheet, XLSX, context = {}) {
  return writeWorkbook([sheet], XLSX, reportClock(context));
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
