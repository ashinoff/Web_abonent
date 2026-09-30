export const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
export const norm = value => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
export const idKey = value => norm(value).replace(/\s+/g, '');
const aliases = {
  meter: ['номер счетчика', 'заводской номер счетчика', 'номер пу', 'заводской номер пу', 'серийный номер', 'счетчик номер'],
  account: ['лс / лс стек', 'лс', 'л/с', 'лицевой счет', 'номер лс', 'номер лицевого счета', 'лс стек'],
  name: ['наименование договора', 'фио', 'абонент', 'наименование абонента', 'потребитель', 'наименование потребителя'],
  locality: ['населенный пункт', 'город', 'н.п.'], street: ['улица'], house: ['дом', 'номер дома'],
  building: ['корпус'], flat: ['квартира', 'кв.'], address: ['адрес', 'адрес точки учета', 'адрес объекта'],
  phone: ['телефон', 'контактный телефон'], status: ['состояние ту', 'статус', 'состояние'],
  model: ['вид счетчика', 'тип счетчика', 'модель счетчика', 'тип пу'],
  transformerRatio: ['коэффициент трансформации', 'коэфициент трансформации', 'коэф. трансформации', 'коэф трансформации', 'коэффициент трансформации тт', 'коэф тт', 'коэф. тт', 'прибор учета коэффициент трансформации', 'прибор учета коэфициент трансформации'],
  station: ['подстанция', 'пс'], feeder: ['фидер10', 'фидер 10', 'фидер'], tp: ['тп'],
  power: ['максимальная мощность', 'мощность'], point: ['номер тустек', 'номер ту стек', 'номер ту'],
};
export function fieldKey(label) {
  const parts = norm(label).split(' · ').reverse();
  for (const part of parts) {
    for (const [key, options] of Object.entries(aliases)) if (options.includes(part)) return key;
  }
  return null;
}
function headerScore(row) {
  const keys = new Set(row.map(fieldKey).filter(Boolean));
  return (keys.has('meter') ? 7 : 0) + (keys.has('account') ? 7 : 0) + Math.min(keys.size, 6);
}
export function detectLayout(matrix, merges = []) {
  const rows = matrix.map(row => row.map(clean));
  let start = -1, best = 0;
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const score = headerScore(rows[i]);
    if (score > best) { best = score; start = i; }
  }
  if (start < 0 || best < 8) throw new Error('Не найдена шапка с номером ПУ или лицевым счётом. Проверьте, что выбран реестр абонентов.');
  // A flattened two-line 1C header loses its merged-cell offsets when copied.
  // Recognize this exact layout; do not apply a blind fixed-column mapping.
  let flattened = false;
  if (start > 0 && norm(rows[start][0]) === 'субабонент' && fieldKey(rows[start - 1][4]) === 'account' && norm(rows[start - 1][5]) === 'наименование договора' && !merges.length) {
    start--; flattened = true;
  }
  let end = start;
  if (flattened) end = start + 1;
  else {
    // Select the top of a merged header block if the most descriptive row is below it.
    const enclosing = merges.filter(m => m.s.r <= start && m.e.r >= start && m.e.r - m.s.r < 6);
    if (enclosing.length) start = Math.min(start, ...enclosing.map(m => m.s.r));
    end = Math.max(end, ...merges.filter(m => m.s.r >= start && m.s.r <= end && m.e.r - m.s.r < 6).map(m => m.e.r));
    while (end + 1 < rows.length && end - start < 4 && headerScore(rows[end + 1]) >= 8 && !/^\d+$/.test(rows[end + 1][0] || '')) end++;
  }
  const width = Math.max(0, ...rows.slice(start, Math.min(rows.length, end + 11)).map(r => r.length));
  if (width > 256) throw new Error('В реестре больше 256 столбцов. Удалите лишние столбцы из выгрузки.');
  let labels;
  if (flattened) {
    labels = [...rows[start].slice(0, 6), ...rows[start + 1]];
  } else {
    labels = Array.from({ length: width }, (_, c) => {
      const parts = [];
      for (let r = start; r <= end; r++) {
        const merge = merges.find(m => m.s.r <= r && m.e.r >= r && m.s.c <= c && m.e.c >= c);
        const text = merge ? rows[merge.s.r]?.[merge.s.c] : rows[r]?.[c];
        if (text && !parts.includes(text)) parts.push(text);
      }
      return parts.join(' · ');
    });
  }
  labels = Array.from({ length: width }, (_, c) => labels[c] || `Столбец ${columnName(c)}`);
  const seen = new Map();
  labels = labels.map(label => { const n = (seen.get(label) || 0) + 1; seen.set(label, n); return n === 1 ? label : `${label} (${n})`; });
  const mapping = {};
  labels.forEach((label, c) => { const key = fieldKey(label); if (key && mapping[key] === undefined) mapping[key] = c; });
  // The requested quick value belongs to the meter section, not a similarly named TN field.
  const meterRatio = labels.findIndex(label => norm(label).includes('прибор учета') && fieldKey(label) === 'transformerRatio');
  if (meterRatio >= 0) mapping.transformerRatio = meterRatio;
  return { start, end, labels, mapping, flattened };
}
export function columnName(n) { let result = ''; for (n++; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; }
export function restoreNumericIdentifiers(matrix, worksheet, layout) {
  // Excel's General display format switches long IDs to scientific notation.
  // Read their stored integer value without losing intentional zero padding.
  const columns = new Set(['meter', 'account', 'point', 'phone'].map(key => layout.mapping[key]).filter(Number.isInteger));
  for (const [c, label] of layout.labels.entries()) if (/номер|телефон|лицевой|^лс/i.test(label)) columns.add(c);
  for (let r = layout.end + 1; r < matrix.length; r++) for (const c of columns) {
    const cell = worksheet[`${columnName(c)}${r + 1}`];
    if (cell?.t !== 'n' || !Number.isInteger(cell.v)) continue;
    if (!Number.isSafeInteger(cell.v) || Math.abs(cell.v) >= 1e15) throw new Error(`Строка ${r + 1}: длинный номер хранится в Excel как число. Установите текстовый формат и восстановите исходный номер — Excel мог округлить его.`);
    if (/e[+-]\d+/i.test(String(matrix[r]?.[c])) || !cell.z || cell.z === 'General') matrix[r][c] = String(cell.v);
  }
  return matrix;
}
export function parseMatrix(matrix, { sheet = 'Лист1', file = '', merges = [], overrides = null } = {}) {
  const layout = detectLayout(matrix, merges);
  if (overrides) {
    for (const key of ['meter', 'account']) {
      delete layout.mapping[key];
      if (Number.isInteger(overrides[key]) && overrides[key] >= 0) layout.mapping[key] = overrides[key];
    }
  }
  if (layout.mapping.meter === undefined && layout.mapping.account === undefined) throw new Error('Укажите столбец номера ПУ или лицевого счёта.');
  const records = [];
  for (let r = layout.end + 1; r < matrix.length; r++) {
    const values = Array.from({ length: layout.labels.length }, (_, c) => clean(matrix[r]?.[c]));
    if (!values.some(Boolean) || headerScore(values) >= 8 || /^(итого|всего)(\s|$)/i.test(values[0])) continue;
    const get = key => values[layout.mapping[key]] || '';
    if (!get('meter') && !get('account')) continue;
    const address = [get('locality'), get('street'), get('house') && `д. ${get('house')}`, get('building') && `корп. ${get('building')}`, get('flat') && `кв. ${get('flat')}`].filter(Boolean).join(', ') || get('address');
    const fields = Object.fromEntries(Object.keys(layout.mapping).map(key => [key, get(key)]));
    records.push({ id: `${sheet}:${r + 1}`, row: r + 1, sheet, file, values, fields, address, meterKey: idKey(get('meter')), accountKey: idKey(get('account')), addressKey: norm(address) });
  }
  return { records, layout, sheet, file, sample: records.slice(0, 3).map(r => r.values) };
}
export function buildIndex(sheets) {
  const records = sheets.flatMap(s => s.records);
  const meter = new Map(), account = new Map();
  records.forEach((record, index) => {
    for (const [map, key] of [[meter, record.meterKey], [account, record.accountKey]]) {
      if (key) { const ids = map.get(key) || []; ids.push(index); map.set(key, ids); }
    }
  });
  return { records, meter, account };
}
export function search(index, { query, field = 'meter', partial = false, offset = 0, limit = 30 }) {
  if (!['meter', 'account', 'address'].includes(field)) throw new Error('Неизвестное поле поиска.');
  const q = field === 'address' ? norm(query) : idKey(query);
  if (!q) return { total: 0, records: [] };
  let matches;
  if (field !== 'address' && !partial) matches = (index[field].get(q) || []).map(i => index.records[i]);
  else matches = index.records.filter(r => field === 'address' ? q.split(' ').every(word => r.addressKey.includes(word)) : r[`${field}Key`].includes(q));
  return { total: matches.length, records: matches.slice(offset, offset + limit) };
}
