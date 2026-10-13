import { flagObservation } from './analysis-observations.js';
import { formatEnergy, formatEnergyText } from './energy-format.js';

const clean = value => String(value || '').trim().replace(/\.+$/, '');
const month = value => String(value || '').replace(/^(\d{4})-(\d{2})$/, '$2.$1');
export const findingDate = value => String(value || '').replace(/^(\d{4})-(\d{2})-(\d{2})T?/, '$3.$2.$1 ').trim();
const distinct = lines => [...new Set(lines.filter(Boolean))];
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
function registrations(flag) {
  if (flag.timestampBasis === 'report_period') return '';
  const count = Number.isFinite(flag.count) && flag.count > 0 ? `Регистраций: ${flag.count}` : '';
  const periods = (flag.months || []).filter(item => item && typeof item === 'object' && item.month)
    .map(item => `${month(item.month)}: ${item.count || 1}`);
  return [count, periods.length ? `По месяцам: ${periods.join('; ')}` : ''].filter(Boolean).join('. ');
}
export function instantFindingLines(flag) {
  const qualifier = flag.conditional ? 'Условное наблюдение' : flag.informational ? 'Справочное наблюдение' : '';
  const detail = clean(String(flag.detail || '').replace(/^ПУ [^:]+:\s*/, '').split(' Наблюдений:')[0]);
  const lines = [`${flag.title || 'Электрический признак'}${qualifier ? '. ' + qualifier : ''}`, detail, registrations(flag)];
  // Profile min/avg/max cover the report interval, not an instant timestamp.
  if (flag.timestampBasis !== 'report_period') {
    const observations = (flag.months || []).flatMap(period => period.observations || [])
      .filter(item => item.at && item.detail).sort((a, b) => a.at.localeCompare(b.at));
    if (observations.length) {
      const first = observations[0], last = observations.at(-1);
      lines[1] = `Первое измерение ${findingDate(first.at)}: ${clean(first.detail)}`;
      if (last.at !== first.at) lines.push(`Последнее измерение ${findingDate(last.at)}: ${clean(last.detail)}`);
    } else {
      if (flag.first) lines.push(`Первое: ${findingDate(flag.first)}`);
      if (flag.last && flag.last !== flag.first) lines.push(`Последнее: ${findingDate(flag.last)}`);
    }
  }
  if (flag.recommendation) lines.push(`Проверить: ${clean(flag.recommendation).replace(/^Проверить\s+/i, '')}`);
  return distinct(lines);
}
export function eventFindingLines(flag) {
  return distinct([flag.title || 'Событие ПУ', registrations(flag),
    flag.first && `Первое: ${findingDate(flag.first)}`, flag.last && flag.last !== flag.first && `Последнее: ${findingDate(flag.last)}`,
    flag.recommendation && clean(flag.recommendation)]);
}
function sourceText(row, role, report) {
  const flags = role === 'events' ? row.eventFlags : row.instantFlags;
  if (flags?.length) return flags.map(flag => (role === 'events' ? eventFindingLines(flag) : instantFindingLines(flag)).join('. ')).join('\n\n');
  if (!report.coverage?.[role]?.loaded) return 'Журнал не загружен';
  if (!row[role === 'events' ? 'eventsPresent' : 'instantPresent']) return 'Записей по этому ПУ нет';
  return 'Признаки не выявлены';
}
function consumptionText(row) {
  const result = row.consumption;
  if (!result) return 'Потребление не сопоставлено: ' + (row.mappingReason || 'нет однозначной связи ПУ с ЛС + ТУ');
  const flags = result.flags || [], lines = flags.map(flag => {
    const comparison = flag.comparison;
    if (!comparison) return [flag.title, flagObservation(flag)].filter(Boolean).join(': ');
    const text = [flag.title];
    if (comparison.months.length) text.push('Месяцы: ' + comparison.months.map(month).join(', '));
    if (comparison.month && Number.isFinite(comparison.value)) {
      text.push(`Сопоставление за ${month(comparison.month)}: ПО ${formatEnergy(comparison.value)} кВт·ч`);
      for (const [key, value] of Object.entries(comparison.comparisons)) {
        const label = { previous: 'Предыдущий месяц', yearAgo: 'Тот же месяц прошлого года', median3: 'Медиана трёх предыдущих месяцев' }[key];
        text.push(value.available ? `${label}: ${formatEnergy(value.value)} кВт·ч; ${value.dropPercent >= 0 ? 'снижение' : 'рост'} ${number(Math.abs(value.dropPercent))}%` : `${label}: нет сравнения (${value.reason})`);
      }
    }
    text.push(comparison.preExistingReason || { same_month: 'Событие и расход совпали по месяцу; порядок изменений внутри месяца неизвестен', after: 'Снижение в последующем месяце; причинная связь требует проверки', journals_only: 'Снижение потребления не подтверждено' }[comparison.temporalRelation]);
    if (comparison.seasonalAlternative) text.push('Возможна сезонность: расход не ниже 90% того же месяца прошлого года');
    if (comparison.commonDecline) text.push(comparison.commonDecline);
    return text.filter(Boolean).join('. ');
  });
  if (!lines.length) lines.push(result.cls === 'unknown' ? 'Недостаточно данных для анализа потребления' : result.cls === 'dead' ? 'Практически нулевое потребление; проверить статус договора и отключения' : 'Претензий по включённым правилам потребления не выявлено');
  if (result.incomplete) lines.push(`Неполных месяцев: ${result.incomplete}; пропуски не приняты за ноль`);
  if (result.negative) lines.push('Есть отрицательные корректировки; они исключены из поиска признаков');
  return formatEnergyText([`ЛС ${result.account}; собственная ТУ${result.point ? ': ' + result.point : ''}`, ...distinct(lines)].join('\n'));
}
export function journalReportSheet(report, context = {}) {
  if (!Array.isArray(report?.rows)) throw new Error('Нет результатов анализа журналов для выгрузки.');
  const res = typeof context.res === 'object' ? context.res?.name || context.res?.path : context.res;
  const findings = report.rows.filter(row => row.instantFlags?.length || row.eventFlags?.length);
  // Keep references to compact findings rather than all rendered cell strings.
  // Planning measures one row; downloading formats only the selected part.
  const rows = { length: findings.length, at(index) {
    const row = findings[index];
    return { cells: [String(row.serial), sourceText(row, 'events', report), sourceText(row, 'instant', report), consumptionText(row)] };
  } };
  const sources = ['events', 'instant'].map(role => `Журнал ${role === 'events' ? '46' : '31'}: ${report.coverage?.[role]?.loaded ? 'загружен' : 'не загружен'}`).join('. ');
  return { title: 'Флаги журналов', subtitle: [res || 'Выбранная РЭС', `ПУ с признаками: ${rows.length}`, sources].join('. '),
    headers: ['Номер ПУ', 'Журнал 46 · события и комментарии', 'Журнал 31 · параметры и комментарии', 'Замечания к потреблению'],
    widths: [24, 62, 74, 70], rows, freezeColumns: 1 };
}
