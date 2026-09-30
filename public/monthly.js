import { clean, norm, idKey, columnName } from './core.js';

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
export const tpKey = value => norm(value).replace(/[‐‑–—]/g, '-').replace(/\s+/g, '');
// A STEK identifier alone does not distinguish all TUs in these exports.
// Keep the local TU number and its name instead of discarding them as fallbacks.
const pointParts = row => [idKey(row.pointNumber), idKey(row.point), norm(row.pointName)];
export function pointKey(row) {
  const parts = pointParts(row);
  return parts.some(Boolean) ? JSON.stringify(parts) : '';
}
export function accountPointKey(row) {
  const point = pointKey(row);
  return point ? JSON.stringify([row.accountKey || idKey(row.account), point]) : '';
}
export function samePoint(a, b) {
  const left = pointParts(a), right = pointParts(b);
  const shared = left.map((value, i) => value && right[i] ? i : -1).filter(i => i >= 0);
  return shared.length > 0 && shared.every(i => left[i] === right[i]);
}
export function selectPointRows(rows, selector) {
  if (!pointKey(selector)) throw new Error('В карточке не указана ТУ. Проверьте столбцы «ТУ», «Номер ТУ» и «Номер ТУСТЕК» в реестре.');
  const matches = rows.filter(row => samePoint(row, selector));
  if (!matches.length) throw new Error('Связка ЛС + ТУ не найдена в файле потребления. Проверьте номер и наименование ТУ в обоих файлах.');
  if (new Set(matches.map(pointKey)).size > 1) throw new Error('Этому ЛС и данным ТУ соответствуют несколько точек. Уточните номер или наименование ТУ в реестре.');
  return matches;
}
export function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = clean(value).replace(/[\s\u202f]/g, '').replace(/−/g, '-').replace(',', '.');
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) && Number.isFinite(Number(s)) ? Number(s) : null;
}
function month(value) {
  const s = norm(value).replace(/<br\s*\/?>/g, ' ');
  if (/всего/.test(s)) return null;
  for (let m = 0; m < 12; m++) if (new RegExp('(?:^|[^а-я])' + MONTHS[m] + '[а-я]*(?=$|[^а-я])').test(s)) return { m, y: Number(s.match(/20\d{2}/)?.[0]) || null };
  const hit = s.match(/^(?:(20\d{2})[.\/-](\d{1,2})|(\d{1,2})[.\/-](20\d{2}))$/);
  if (hit) { const m = Number(hit[2] || hit[3]) - 1; if (m >= 0 && m < 12) return { m, y: Number(hit[1] || hit[4]) }; }
  return null;
}
function periodFromTitle(rows) {
  for (const row of rows) for (const cell of row) {
    const s = norm(cell); if (!/полезный отпуск|за период|период/.test(s)) continue;
    const named = [...s.matchAll(new RegExp('(' + MONTHS.join('|') + ')[а-я]*\\s+(20\\d{2})', 'g'))];
    if (named.length >= 2) return [month(named[0][0]), month(named[named.length - 1][0])];
  }
  return null;
}
const accountHeader = s => /^(лс\s*\/\s*номер договора|лс|лс\s*\/\s*лс стек|номер договора|лицевой счет)$/.test(norm(s));
export function parseMonthlyMatrix(matrix, { sheet = 'Лист1', worksheet = null } = {}) {
  const h = matrix.findIndex((row, i) => i < 80 && row.some(accountHeader) && row.filter(v => month(v)).length >= 1);
  if (h < 0) throw new Error('Не найдена шапка «ЛС/Номер договора» с помесячным полезным отпуском.');
  const header = matrix[h].map(clean), cols = header.map((v, c) => ({ ...month(v), c })).filter(v => v.m != null);
  if (!cols.length) throw new Error('Нет столбцов с месяцами.');
  const period = periodFromTitle(matrix.slice(0, h));
  const explicit = cols.findIndex(c => c.y != null);
  let start = period ? period[0].y * 12 + period[0].m : null;
  if (start == null && explicit >= 0) start = cols[explicit].y * 12 + cols[explicit].m - explicit;
  if (start == null) throw new Error('В шапке нет года. Укажите период отчёта (например, Июнь 2024 — Август 2026) или год каждого месяца.');
  const months = cols.map((c, i) => {
    const n = start + i, y = Math.floor(n / 12), m = n % 12;
    if (c.m !== m || c.y != null && c.y !== y) throw new Error('Месяцы в шапке не совпадают с периодом отчёта или идут с пропуском. Проверьте годы и порядок столбцов.');
    return { y, m };
  });
  if (period && period[1].y * 12 + period[1].m !== start + cols.length - 1) throw new Error('Количество месячных столбцов не совпадает с периодом в заголовке.');
  const find = rx => header.findIndex(v => rx.test(norm(v)));
  const c = { account: header.findIndex(accountHeader), alias: find(/^лицевой счет стек$/), point: find(/^(номер точки учета стек|номер ту\s*стек)$/), pointNumber: find(/^(№\s*ту|номер ту)$/), name: find(/^наименование договора$/), pointName: find(/^(фио\s*\/\s*наименование точки учета|ту|наименование ту|наименование точки учета)$/), tp: find(/^тп$/), zone: find(/^тарифная зона$/), off: find(/^откл$/) };
  const rows = [], warnings = []; let invalid = 0, totalsMismatch = 0;
  const totalCol = find(/^всего.*по/);
  function identifier(row, r, col) {
    if (col < 0) return '';
    const cell = worksheet?.[`${columnName(col)}${r + 1}`];
    const value = cell?.t === 'n' ? cell.v : row[col];
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Math.abs(value) >= 1e15) throw new Error(`Строка ${r + 1}: номер сохранён числом и мог быть округлён Excel. Восстановите номер в текстовом формате.`);
      // Keep explicit zero padding, but never SheetJS scientific display notation.
      return cell?.z && /^0+$/.test(cell.z) ? String(value).padStart(cell.z.length, '0') : String(value);
    }
    return clean(value);
  }
  for (let r = h + 1; r < matrix.length; r++) {
    const row = matrix[r]; if (!row.some(v => clean(v))) continue;
    const account = identifier(row, r, c.account);
    if (!account || /^(итого|всего|лс\b|лицевой счет)/i.test(account)) continue;
    if (!/\d/.test(account)) { invalid++; continue; }
    const values = cols.map(({ c }) => {
      const v = worksheet?.[`${columnName(c)}${r + 1}`]?.v ?? row[c];
      const n = numeric(v); if (n == null && clean(v) && !/^[-—–]$/.test(clean(v))) invalid++;
      return n;
    });
    const total = numeric(row[totalCol]);
    if (total != null && values.every(v => v != null) && Math.abs(total - values.reduce((s, v) => s + v, 0)) > 0.05) totalsMismatch++;
    rows.push({ account, accountKey: idKey(account), alias: identifier(row, r, c.alias), point: identifier(row, r, c.point), pointNumber: identifier(row, r, c.pointNumber), name: clean(row[c.name]), pointName: clean(row[c.pointName]), tp: clean(row[c.tp]), zone: clean(row[c.zone]), off: clean(row[c.off]), values, source: `${sheet}:${r + 1}` });
  }
  if (!rows.length) throw new Error('Нет строк с лицевыми счетами.');
  if (!rows.some(r => r.values.some(v => v != null))) throw new Error('Нет числовых месячных объёмов потребления.');
  if (invalid) warnings.push(`Нераспознанных значений или строк: ${invalid}. Пустые/нечисловые объёмы не считаются нулями.`);
  if (totalsMismatch) warnings.push(`У ${totalsMismatch} строк итог не совпадает с суммой месяцев; использованы месячные столбцы.`);
  return { months, rows, warnings };
}
export function readMonthlyWorkbook(buffer, XLSX) {
  const bytes = new Uint8Array(buffer);
  const valid = [0xd0,0xcf,0x11,0xe0].every((v,i) => bytes[i] === v) || bytes[0] === 0x50 && bytes[1] === 0x4b || bytes[0] === 9 && [0,2,4,8].includes(bytes[1]);
  if (!valid) throw new Error('Выберите книгу Excel в формате XLS или XLSX.');
  const book = XLSX.read(buffer, { type: 'array', cellHTML: false, cellNF: true, cellText: true, sheetRows: 100002 });
  let result = null; const errors = [];
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name]; if (!ws?.['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    if (range.e.r > 100000 || range.e.c > 255 || ws['!fullref']) throw new Error('Максимум 100 000 строк и 256 столбцов на лист.');
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
    let part;
    try { part = parseMonthlyMatrix(matrix, { sheet: name, worksheet: ws }); }
    catch (error) {
      // Non-report helper sheets can be skipped. A recognized but invalid report cannot.
      if (!/Не найдена шапка/.test(error.message)) throw new Error(`Лист «${name}»: ${error.message}`);
      errors.push(`Лист «${name}» пропущен: ${error.message}`); continue;
    }
    if (result && JSON.stringify(result.months) !== JSON.stringify(part.months)) throw new Error('Листы содержат разные периоды отчёта. Оставьте один согласованный период.');
    if (!result) result = part; else { result.rows.push(...part.rows); result.warnings.push(...part.warnings); }
  }
  if (!result) throw new Error(errors[0] || 'Книга не содержит данных.');
  result.warnings.push(...errors);
  return result;
}
// Collapse equal LS + TU + TP + tariff rows only. Distinct TUs under one LS
// remain independent even when they share the same STEK identifier.
export function indexMonthly(parsed) {
  const unique = new Map(), accounts = new Map(), aliases = new Map(); let duplicates = 0;
  for (const row of parsed.rows) {
    const tu = accountPointKey(row);
    const identity = tu ? JSON.stringify([tu, tpKey(row.tp), norm(row.zone)]) : null;
    if (identity && unique.has(identity)) {
      const old = unique.get(identity);
      if (JSON.stringify(old.values) !== JSON.stringify(row.values)) throw new Error(`У ЛС ${row.account} повторяется одна и та же ТУ «${[row.pointNumber, row.pointName, row.point && 'СТЕК ' + row.point].filter(Boolean).join(' · ')}» с разными объёмами (${old.source}, ${row.source}). Проверьте эти строки выгрузки.`);
      duplicates++; continue;
    }
    if (identity) unique.set(identity, row);
    if (!accounts.has(row.accountKey)) accounts.set(row.accountKey, []);
    accounts.get(row.accountKey).push(row);
    for (const alias of [row.accountKey, idKey(row.alias)].filter(Boolean)) {
      if (!aliases.has(alias)) aliases.set(alias, new Set()); aliases.get(alias).add(row.accountKey);
    }
  }
  const warnings = [...parsed.warnings];
  if (duplicates) warnings.push(`Точных повторов строк точек учёта исключено: ${duplicates}.`);
  return { ...parsed, rows: [...accounts.values()].flat(), accounts, aliases, warnings, duplicates };
}
export function strictSum(rows, n) {
  return Array.from({ length: n }, (_, i) => rows.length && rows.every(r => r.values[i] != null) ? rows.reduce((s, r) => s + r.values[i], 0) : null);
}
