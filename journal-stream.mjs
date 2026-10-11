import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { StringDecoder } from 'node:string_decoder';
import { mkdtemp, rm } from 'node:fs/promises';
import { openSync, closeSync, readSync, writeSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { clean } from './public/core.js';
import { createEventAggregator, detectEventHeader, journalIdentifier, parseJournalTimestamp } from './public/journals.js';

const MB = 1048576;
const MAX_CELL_BYTES = MB, MAX_METADATA_BYTES = 32 * MB;
const MAX_ENTRY_BYTES = 1024 * MB, MAX_ARCHIVE_BYTES = 2048 * MB;
const MAX_SHARED_STRINGS = 4000000, MAX_SHARED_BYTES = 512 * MB;
const local = name => String(name).split(':').at(-1);
const excelText = text => String(text).replace(/_x([0-9a-f]{4})_/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
const nonempty = cell => cell?.v != null && clean(cell.v) !== '';
const xmlError = message => new Error(`Некорректный XLSX журнала 46: ${message}`);

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

function partPath(base, target) {
  if (!target || target.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(target)) throw xmlError('неподдерживаемая ссылка на часть книги.');
  const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(base), target));
  if (path === '..' || path.startsWith('../')) throw xmlError('ссылка выходит за пределы книги.');
  return path;
}
const relationsPath = part => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');

async function archive(path) {
  const zip = await yauzl.openPromise(path, { autoClose: false, validateEntrySizes: true });
  const entries = new Map(); let bytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/')) continue;
      if (entries.size >= 4096 || entries.has(entry.fileName)) throw xmlError('слишком много или повторяющиеся ZIP-части.');
      bytes += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_ENTRY_BYTES || bytes > MAX_ARCHIVE_BYTES) throw xmlError('распакованная книга превышает безопасный размер.');
      entries.set(entry.fileName, entry);
    }
    return { zip, entries };
  } catch (error) { zip.close(); throw error; }
}

async function parseXML(book, part, handlers, limit = MAX_METADATA_BYTES) {
  const entry = book.entries.get(part);
  if (!entry) throw xmlError(`не найдена часть «${part}».`);
  if (entry.uncompressedSize > limit) throw xmlError(`часть «${part}» слишком большая.`);
  const parser = new SaxesParser({ xmlns: false, fileName: part });
  let depth = 0, bytes = 0;
  parser.on('doctype', () => { throw xmlError('DTD в книге не поддерживается.'); });
  parser.on('opentag', tag => {
    if (++depth > 64) throw xmlError('слишком большая вложенность XML.');
    handlers.open?.(local(tag.name), tag.attributes);
  });
  parser.on('closetag', tag => { handlers.close?.(local(tag.name)); depth--; });
  parser.on('text', text => handlers.text?.(text));
  parser.on('cdata', text => handlers.text?.(text));
  const stream = await book.zip.openReadStreamPromise(entry), decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      if ((bytes += chunk.length) > limit) throw xmlError(`часть «${part}» слишком большая.`);
      parser.write(decoder.write(chunk));
    }
    parser.write(decoder.end()).close();
  } finally { stream.destroy(); }
}

async function relationships(book, part) {
  const result = new Map();
  await parseXML(book, relationsPath(part), { open(name, attr) {
    if (name === 'Relationship' && attr.TargetMode !== 'External') result.set(attr.Id, { target: partPath(part, attr.Target), type: attr.Type });
  } });
  return result;
}

async function workbookInfo(book) {
  let workbook = 'xl/workbook.xml';
  if (book.entries.has('_rels/.rels')) await parseXML(book, '_rels/.rels', { open(name, attr) {
    if (name === 'Relationship' && String(attr.Type).endsWith('/officeDocument') && attr.TargetMode !== 'External') workbook = partPath('', attr.Target);
  } });
  const sheets = []; let date1904 = false;
  await parseXML(book, workbook, { open(name, attr) {
    if (name === 'workbookPr') date1904 = /^(1|true)$/i.test(attr.date1904 || '');
    if (name === 'sheet') {
      if (sheets.length >= 1024) throw xmlError('слишком много листов.');
      const rid = attr['r:id'] || Object.entries(attr).find(([key]) => local(key) === 'id')?.[1];
      sheets.push({ name: attr.name || `Лист ${sheets.length + 1}`, rid });
    }
  } });
  const rels = await relationships(book, workbook);
  for (const sheet of sheets) {
    const relation = rels.get(sheet.rid);
    sheet.path = relation?.type?.endsWith('/worksheet') ? relation.target : null;
  }
  return { sheets, date1904,
    sharedStrings: [...rels.values()].find(item => item.type?.endsWith('/sharedStrings'))?.target,
    styles: [...rels.values()].find(item => item.type?.endsWith('/styles'))?.target };
}

async function numberFormats(book, part) {
  if (!part) return [];
  const formats = new Map([[0, 'General'], [1, '0']]), styles = []; let inCellFormats = false;
  await parseXML(book, part, { open(name, attr) {
    if (name === 'numFmt') formats.set(Number(attr.numFmtId), attr.formatCode || '');
    if (name === 'cellXfs') inCellFormats = true;
    if (name === 'xf' && inCellFormats) {
      if (styles.length >= 100000) throw xmlError('слишком много стилей.');
      styles.push(Number(attr.numFmtId || 0));
    }
  }, close(name) { if (name === 'cellXfs') inCellFormats = false; } });
  return styles.map(id => formats.get(id) || '');
}

// A workbook's shared-string table can itself contain hundreds of thousands of
// unused strings. Index UTF-8 bytes on disk; keep only typed offsets and a small
// cache in memory. The temporary directory is always removed by the caller.
class SharedStrings {
  constructor(path) { this.fd = openSync(path, 'w+'); this.blocks = []; this.count = 0; this.bytes = 0; this.pending = []; this.pendingBytes = 0; this.cache = new Map(); this.cacheBytes = 0; }
  add(text) {
    if (this.count >= MAX_SHARED_STRINGS) throw xmlError('слишком много общих строк.');
    const bytes = Buffer.from(excelText(text));
    if (bytes.length > MAX_CELL_BYTES || this.bytes + bytes.length > MAX_SHARED_BYTES) throw xmlError('таблица общих строк превышает безопасный размер.');
    const block = Math.floor(this.count / 65536), slot = this.count % 65536;
    if (!this.blocks[block]) this.blocks[block] = { offsets: new Float64Array(65536), lengths: new Uint32Array(65536), populated: new Uint8Array(65536) };
    this.blocks[block].offsets[slot] = this.bytes; this.blocks[block].lengths[slot] = bytes.length; this.blocks[block].populated[slot] = clean(text) ? 1 : 0;
    this.pending.push(bytes); this.pendingBytes += bytes.length; this.bytes += bytes.length; this.count++;
    if (this.pendingBytes >= 256 * 1024 || this.pending.length >= 4096) this.flush();
  }
  flush() {
    if (this.pendingBytes) { const bytes = Buffer.concat(this.pending, this.pendingBytes); let offset = 0; while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset); }
    this.pending = []; this.pendingBytes = 0;
  }
  get(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) throw xmlError('неверный индекс общей строки.');
    if (this.cache.has(index)) { const entry = this.cache.get(index); this.cache.delete(index); this.cache.set(index, entry); return entry.value; }
    const block = this.blocks[Math.floor(index / 65536)], slot = index % 65536, bytes = Buffer.allocUnsafe(block.lengths[slot]);
    let read = 0; while (read < bytes.length) { const size = readSync(this.fd, bytes, read, bytes.length - read, block.offsets[slot] + read); if (!size) throw xmlError('неполная таблица общих строк.'); read += size; }
    const value = bytes.toString('utf8'); this.cache.set(index, { value, bytes: value.length * 2 }); this.cacheBytes += value.length * 2;
    while (this.cache.size > 512 || this.cacheBytes > 4 * MB) { const oldest = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(oldest).bytes; this.cache.delete(oldest); }
    return value;
  }
  populated(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) throw xmlError('неверный индекс общей строки.');
    return !!this.blocks[Math.floor(index / 65536)].populated[index % 65536];
  }
  close() { closeSync(this.fd); }
}

async function readSharedStrings(book, part, strings) {
  if (!part) return;
  let inString = false, inText = false, phonetic = 0, text = '';
  await parseXML(book, part, { open(name) {
    if (name === 'si') { inString = true; text = ''; }
    if (name === 'rPh') phonetic++;
    if (name === 't' && inString && !phonetic) inText = true;
  }, text(value) {
    if (inText) { text += value; if (text.length > MAX_CELL_BYTES) throw xmlError('слишком длинная общая строка.'); }
  }, close(name) {
    if (name === 't') inText = false;
    if (name === 'rPh') phonetic--;
    if (name === 'si') { strings.add(text); inString = false; }
  } }, MAX_SHARED_BYTES);
  strings.flush();
}

const column = ref => {
  const match = /^([A-Z]{1,3})\d+$/.exec(ref || ''); if (!match) return null;
  let value = 0; for (const char of match[1]) value = value * 26 + char.charCodeAt(0) - 64;
  return value <= 16384 ? value - 1 : null;
};

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
  const book = await archive(path); let directory, strings;
  try {
    // The parent owns the input directory and removes it even if a preparation
    // child is killed by the RSS/timeout guard before this finally can run.
    directory = await mkdtemp(join(dirname(path), 'journal-strings-'));
    strings = new SharedStrings(join(directory, 'strings'));
    const info = await workbookInfo(book), formats = await numberFormats(book, info.styles);
    await readSharedStrings(book, info.sharedStrings, strings);
    const aggregator = createEventAggregator(), warnings = []; let recognized = 0;
    for (const sheet of info.sheets) if (sheet.path && await readSheet(book, sheet, formats, strings, info.date1904, aggregator, warnings)) recognized++;
    if (!recognized) throw new Error('Не найдена шапка журнала 46 или строгий трёхколоночный экспорт.');
    if (!aggregator.stats.accepted) throw new Error('Журнал 46 не содержит пригодных строк. Проверьте серийные номера, даты и значения.');
    return aggregator.finish(warnings);
  } finally { strings?.close(); book.zip.close(); if (directory) await rm(directory, { recursive: true, force: true }); }
}
