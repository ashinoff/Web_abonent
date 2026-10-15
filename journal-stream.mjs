import { clean } from './public/core.js';
import { createEventAggregator, detectEventHeader, journalIdentifier, parseJournalTimestamp } from './public/journals.js';
import { openStreamingWorkbook, parseXML, column, excelText, xmlError, MAX_CELL_BYTES, MAX_ENTRY_BYTES } from './xlsx-stream.mjs';

const nonempty = cell => cell?.v != null && clean(cell.v) !== '';

// Excel stores civil time as a day number. Do not pass it through the local
// timezone, and reject Excel's fictional 29 February 1900 in the shared parser.
const excelDates = { SSF: { parse_date_code(value, { date1904 = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || value > 2958465) return null;
  let day = Math.floor(value), seconds = Math.floor((value - day) * 86400);
  if ((value - day) * 86400 - seconds > 0.9999 && ++seconds === 86400) { seconds = 0; day++; }
  if (date1904) day += 1462;
  let y, m, d;
  if (day === 60) { y = 1900; m = 2; d = 29; }
  else if (day === 0) { y = 1900; m = 1; d = 0; }
  else {
    const date = new Date(Date.UTC(1900, 0, 1) + (day - 1 - (day > 60 ? 1 : 0)) * 86400000);
    y = date.getUTCFullYear(); m = date.getUTCMonth() + 1; d = date.getUTCDate();
  }
  return { y, m, d, H: Math.floor(seconds / 3600), M: Math.floor(seconds / 60) % 60, S: seconds % 60 };
} } };
export const streamJournalTimestamp = (value, date1904 = false) => parseJournalTimestamp(value, excelDates, date1904);

async function readSheet(book, sheet, formats, strings, date1904, aggregator, warnings) {
  const chosen = new Set([0, 1, 2, 5, 9]);
  let row = [], rowNumber = 0, implicitRow = 0, nextColumn = 0, width = 0, cell = null, content = '', readValue = false, inText = false, phonetic = 0;
  let schema = null, firstNonempty = true, found = false, maxColumn = -1;
  function acceptRow() {
    if (!row.some(nonempty) && !width) return;
    if (!schema) {
      if (rowNumber > 80) return;
      const header = detectEventHeader(row.map(value => value?.v), width);
      if (header) { schema = header; found = true; firstNonempty = false; return; }
      if (firstNonempty && width <= 3 && journalIdentifier(row[0]) && streamJournalTimestamp(row[1]?.v, date1904) && nonempty(row[2])) {
        schema = { serial: 0, time: 1, info: 2, compact: true, headerless: true }; found = true;
      }
      firstNonempty = false;
      if (!schema) return;
    }
    const indices = Array.isArray(schema) ? schema : [schema.serial, schema.time, schema.info];
    if ((schema.headerless || schema.compact || indices[0] === 0) && maxColumn >= 3) throw xmlError(`лист «${sheet.name}» содержит данные за пределами трёхколоночного экспорта.`);
    const [serial, time, info] = indices;
    const rawTime = row[time]?.v, at = typeof rawTime === 'number' ? streamJournalTimestamp(rawTime, date1904) : rawTime;
    aggregator.add(row[serial], at, row[info]?.v);
  }
  await parseXML(book, sheet.path, { open(name, attr) {
    if (name === 'row') {
      rowNumber = attr.r ? Number(attr.r) : implicitRow + 1; implicitRow = rowNumber;
      if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > 1048576) throw xmlError('неверный номер строки.');
      row = []; width = 0; nextColumn = 0;
    }
    if (name === 'c') {
      const col = attr.r ? column(attr.r) : nextColumn; if (col == null || col > 16383) throw xmlError('неверная ссылка на ячейку.'); nextColumn = col + 1;
      cell = { col, type: attr.t || 'n', z: formats[Number(attr.s || 0)] || '', wanted: schema ? col === schema.serial || col === schema.time || col === schema.info : chosen.has(col), occupied: false }; content = '';
    }
    if (name === 'rPh') phonetic++;
    if (name === 'v' && cell) readValue = true;
    if (name === 't' && cell && !phonetic) inText = true;
  }, text(text) {
    if (cell && (readValue || inText)) {
      if (text.trim()) cell.occupied = true;
      if (cell.wanted || cell.type === 's') { content += text; if (content.length > MAX_CELL_BYTES) throw xmlError('слишком длинная ячейка.'); }
    }
  }, close(name) {
    if (name === 'v') readValue = false;
    if (name === 't') inText = false;
    if (name === 'rPh') phonetic--;
    if (name === 'c' && cell) {
      if (cell.type === 's' && content.trim()) cell.occupied = strings.populated(Number(content));
      if (cell.occupied) { width = Math.max(width, cell.col + 1); maxColumn = Math.max(maxColumn, cell.col); }
      if (cell.wanted) {
        let value = cell.type === 's' ? content.trim() ? strings.get(Number(content)) : '' : ['inlineStr', 'str', 'd'].includes(cell.type) ? excelText(content) : cell.type === 'b' ? content === '1' : cell.type === 'e' ? '' : content.trim() === '' ? '' : Number(content);
        if (typeof value === 'number' && !Number.isFinite(value)) value = '';
        row[cell.col] = { v: value, z: cell.z };
      }
      cell = null;
    }
    if (name === 'row') acceptRow();
  } }, MAX_ENTRY_BYTES);
  if (!found) warnings.push(`Лист «${sheet.name}» пропущен: не найдена шапка журнала 46 или строгий трёхколоночный экспорт.`);
  return found;
}

export async function readEventJournalXLSX(path) {
  const workbook = await openStreamingWorkbook(path);
  try {
    const { book, info, formats, strings } = workbook;
    const aggregator = createEventAggregator(), warnings = []; let recognized = 0;
    for (const sheet of info.sheets) if (sheet.path && await readSheet(book, sheet, formats, strings, info.date1904, aggregator, warnings)) recognized++;
    if (!recognized) throw new Error('Не найдена шапка журнала 46 или строгий трёхколоночный экспорт.');
    if (!aggregator.stats.accepted) throw new Error('Журнал 46 не содержит пригодных строк. Проверьте серийные номера, даты и значения.');
    return aggregator.finish(warnings);
  } finally { await workbook.close(); }
}
