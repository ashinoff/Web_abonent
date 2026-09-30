import { clean, norm, fieldKey } from './core.js';

const definitions = [
  ['account', 'Лицевой счёт и договор'], ['point', 'Точка учёта'],
  ['address', 'Адрес и контакты'], ['connection', 'Подключение'],
  ['meter', 'Прибор учёта'], ['events', 'События и показания'],
  ['calculated', 'Рассчитанные величины'], ['tt', 'Характеристики ТТ'],
  ['tn', 'Характеристики ТН'], ['other', 'Другие сведения'],
];
export function recordSection(label) {
  const text = norm(label), key = fieldKey(label);
  if (text.startsWith('прибор учета ·')) return 'meter';
  if (/^характеристики тт(?: ·|$)|(?:^|\s)тт(?:\s|\(|$)/.test(text)) return 'tt';
  if (/^характеристики тн(?: ·|$)|(?:^|\s)тн(?:\s|\(|$)/.test(text)) return 'tn';
  if (text.startsWith('подключение ·') || ['station', 'feeder', 'tp', 'power'].includes(key) || /^опора/.test(text)) return 'connection';
  if (text.startsWith('прибор учета ·') || ['meter', 'model', 'transformerRatio'].includes(key)) return 'meter';
  if (text.startsWith('адрес точки учета ·') || ['address', 'locality', 'street', 'house', 'building', 'flat', 'phone'].includes(key)) return 'address';
  if (text.startsWith('события ·') || /показани|проверка схемы/.test(text)) return 'events';
  if (text.startsWith('рассчитанные величины ·') || /^итоговый по/.test(text)) return 'calculated';
  if (['point', 'pointNumber', 'pointName'].includes(key)) return 'point';
  if (text.startsWith('основные реквизиты ·') || ['account', 'name', 'status'].includes(key) || /^№\s*п\/?п|^субабонент/.test(text)) return 'account';
  return 'other';
}
export function groupRecordFields(labels, values) {
  const groups = new Map(definitions.map(([key, title]) => [key, { key, title, fields: [] }]));
  labels.forEach((label, index) => {
    const group = groups.get(recordSection(label));
    const parts = clean(label).split(' · ');
    // Section titles already carry the original Excel group; retain the full label for copying.
    group.fields.push({ index, label, displayLabel: parts.length > 1 && group.key !== 'other' ? parts.slice(1).join(' · ') : label, value: clean(values[index]) });
  });
  return [...groups.values()].filter(group => group.fields.length);
}
