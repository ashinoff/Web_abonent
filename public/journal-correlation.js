import { pointKey, strictSum } from './monthly.js';
import { flagObservation } from './analysis-observations.js';

const DAY = 86400000, WINDOW = 31 * DAY, DETAIL_LIMIT = 8;
const MOSCOW_MONTH = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' });
const keyOf = ({ y, m }) => `${y}-${String(m + 1).padStart(2, '0')}`;
const ordinal = value => { const m = String(value || '').match(/^(\d{4})-(\d{2})/); return m ? +m[1] * 12 + +m[2] - 1 : null; };
const keyFromOrdinal = n => keyOf({ y: Math.floor(n / 12), m: n % 12 });
const ownPoint = (account, point) => JSON.stringify([account, point]);
const uniq = values => [...new Set(values)];
const fmt = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : 'нет данных';
export const informationalElectrical = signal => /UNBALANCE|ASYMMETRY|НЕСИММЕТР/i.test(`${signal.code} ${signal.title}`) || /(?:^|_)PF(?:_|$)/i.test(String(signal.code)) || signal.informational === true && signal.conditional !== true;
export function civilMilliseconds(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [y, m, d, h, min, sec] = match.slice(1).map(Number), ms = Date.UTC(y, m - 1, d, h, min, sec), date = new Date(ms);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && h < 24 && min < 60 && sec < 60 ? ms : null;
}
const lower = (values, wanted) => { let a = 0, b = values.length; while (a < b) { const m = (a + b) >>> 1; if (values[m] < wanted) a = m + 1; else b = m; } return a; };
const upper = (values, wanted) => { let a = 0, b = values.length; while (a < b) { const m = (a + b) >>> 1; if (values[m] <= wanted) a = m + 1; else b = m; } return a; };
const monthStart = n => Date.UTC(Math.floor(n / 12), n % 12, 1);
const missing = (reason, extra = {}) => ({ available: false, value: null, dropPercent: null, reason, ...extra });

// Index actual calendar months. A missing month, missing row or negative
// adjustment cannot be bridged by using the nearest available value.
export function indexPointComparisons(months, rows, now = new Date(), wantedOrdinals = null) {
  const parts = Object.fromEntries(MOSCOW_MONTH.formatToParts(now).map(p => [p.type, p.value]));
  const current = +parts.year * 12 + +parts.month - 1, values = strictSum(rows, months.length), indexed = new Map();
  months.forEach((month, i) => {
    const n = month.y * 12 + month.m, value = values[i];
    const reason = n >= current ? 'Текущий или будущий месяц ещё не завершён.'
      : value == null ? 'Неполный месяц: отсутствуют объёмы одной или нескольких строк ТУ.'
      : !Number.isFinite(value) || rows.some(row => !Number.isFinite(row.values[i])) ? 'В месяце есть нечисловые или бесконечные объёмы; сравнение недоступно.'
      : rows.some(row => row.values[i] < 0 && row.values[i] != null) ? 'В месяце есть отрицательные корректировки; они не используются как признак снижения.' : '';
    indexed.set(n, { month: keyOf(month), index: i, value, available: !reason, reason });
  });
  function baseline(target, offsets, median = false) {
    const sourceMonths = offsets.map(offset => keyFromOrdinal(target - offset)), entries = offsets.map(offset => indexed.get(target - offset));
    const extra = median ? { months: sourceMonths } : { month: sourceMonths[0] };
    if (entries.some(entry => !entry)) return missing('В выгрузке нет необходимого календарного месяца.', extra);
    if (entries.some(entry => !entry.available)) return missing(entries.find(entry => !entry.available).reason, extra);
    if (entries.some(entry => entry.value <= 0)) return missing('Для процентного сравнения необходим положительный базовый объём.', { ...extra, value: median ? null : entries[0].value });
    const base = median ? entries.map(entry => entry.value).sort((a, b) => a - b)[1] : entries[0].value;
    if (!Number.isFinite(base)) return missing('Базовый объём не является конечным числом.', extra);
    const value = indexed.get(target).value, exact = (1 - value / base) * 100;
    return { available: true, value: base, dropPercent: Math.round(exact * 10) / 10, eligible: base >= 30, reason: base >= 30 ? '' : 'Базовый объём менее 30 кВт·ч; порог отбора не применяется.', ...extra, exactDropPercent: exact };
  }
  const output = new Map();
  for (const n of wantedOrdinals || indexed.keys()) {
    const entry = indexed.get(n); if (!entry) continue;
    entry.comparisons = entry.available ? { previous: baseline(n, [1]), yearAgo: baseline(n, [12]), median3: baseline(n, [3, 2, 1], true) }
      : { previous: missing(entry.reason), yearAgo: missing(entry.reason), median3: missing(entry.reason) };
    entry.thresholdMatches = Object.entries(entry.comparisons).filter(([key, value]) => value.available && value.eligible && value.exactDropPercent >= (key === 'median3' ? 50 : 30)).map(([key]) => key);
    entry.seasonalAlternative = entry.comparisons.yearAgo.available && entry.comparisons.yearAgo.dropPercent < 10 && entry.thresholdMatches.some(key => key !== 'yearAgo');
    output.set(n, entry);
  }
  return output;
}

// New packages carry details at their actual endpoint timestamps. Legacy
// first/last dates remain usable, but their detail is a monthly summary.
export function electricalObservations(sample) {
  const out = [], seen = new Set();
  for (const signal of sample?.signals || []) {
    if (informationalElectrical(signal)) continue;
    const periods = signal.months?.length ? signal.months : [{ month: signal.first?.slice(0, 7), first: signal.first, last: signal.last, count: signal.count, detail: signal.detail }];
    for (const period of periods) {
      const exact = Array.isArray(period.observations) && period.observations.length > 0;
      const observations = exact ? period.observations : uniq([period.first, period.last].filter(Boolean)).map(at => ({ at, detail: at === period.first
        ? `Сводка признака за период, без точного соответствия параметров времени: ${period.detail || signal.detail || ''}` : 'В старом формате сохранено последнее время признака; конкретные параметры этого измерения недоступны.' }));
      for (const observation of observations) {
        const ms = civilMilliseconds(observation.at), identity = `${signal.code}|${observation.at}`;
        if (ms == null || seen.has(identity)) continue;
        seen.add(identity);
        out.push({ serial: sample.serial, code: signal.code, title: signal.title, at: observation.at, ms, count: period.count || signal.count || 1,
          detail: observation.detail || period.detail || signal.detail || '', conditional: signal.conditional === true, timestampDetailExact: exact,
          observationPeriod: period.month || observation.at.slice(0, 7), recommendation: signal.recommendation || '' });
      }
    }
  }
  return out.sort((a, b) => a.ms - b.ms || String(a.code).localeCompare(String(b.code)));
}

function mergeRanges(ranges) {
  const out = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else out.push([...range]);
  }
  return out;
}
function eventSummary(events, ranges) {
  const merged = mergeRanges(ranges), count = merged.reduce((sum, [from, to]) => sum + to - from, 0), representatives = new Map();
  for (const [from, to] of merged) {
    if (to <= from) continue;
    representatives.set(from, events[from]); representatives.set(to - 1, events[to - 1]);
  }
  const values = [...representatives].sort((a, b) => a[0] - b[0]);
  const selected = (values.length <= DETAIL_LIMIT ? values : [...values.slice(0, DETAIL_LIMIT / 2), ...values.slice(-DETAIL_LIMIT / 2)]).map(([, event]) => event);
  return { events: selected, eventCount: count, eventDetailsTruncated: count > selected.length, ranges: merged };
}
function electricalSummary(observations) {
  const distinct = new Map(observations.map(observation => [`${observation.code}|${observation.at}`, observation]));
  const values = [...distinct.values()].sort((a, b) => a.ms - b.ms), periods = new Map(values.map(o => [`${o.code}|${o.observationPeriod}`, o.count]));
  const selected = values.length <= DETAIL_LIMIT ? values : [...values.slice(0, DETAIL_LIMIT / 2), ...values.slice(-DETAIL_LIMIT / 2)];
  return { electrical: selected, electricalCount: [...periods.values()].reduce((sum, count) => sum + count, 0), electricalTimestampCount: values.length, electricalDetailsTruncated: values.length > selected.length };
}
const unavailableComparisons = reason => ({ previous: missing(reason), yearAgo: missing(reason), median3: missing(reason) });
const comparisonText = comparisons => Object.entries(comparisons).map(([key, value]) => {
  const title = { previous: 'предыдущий календарный месяц', yearAgo: 'тот же месяц прошлого года', median3: 'медиана трёх непосредственно предыдущих полных положительных месяцев' }[key];
  return value.available ? `${title}: ${fmt(value.value)} кВт·ч, снижение ${fmt(value.dropPercent)}%${value.reason ? ` (${value.reason})` : ''}` : `${title}: сравнение недоступно — ${value.reason}`;
}).join('; ');

export function createJournalCorrelation({ model, bindings, instantBySerial, eventsBySerial, instantFields = [], instantLoaded, eventsLoaded, now = new Date() }) {
  const pointRows = new Map(), comparisonCache = new Map(), caseCache = new Map();
  const monthIndexes = new Map(model.months.map((month, i) => [keyOf(month), i]));
  const currentParts = Object.fromEntries(MOSCOW_MONTH.formatToParts(now).map(part => [part.type, part.value]));
  const currentMonth = +currentParts.year * 12 + +currentParts.month - 1;
  const fieldIndexes = new Map(instantFields.map((field, i) => [field, i]));
  const stats = { comparisonMonths: 0, comparisonBuilds: 0, skippedWithoutCandidates: 0 };
  for (const row of model.rows) {
    const key = ownPoint(row.accountKey, pointKey(row));
    if (!pointRows.has(key)) pointRows.set(key, []);
    pointRows.get(key).push(row);
  }
  function canonicalCases(serial) {
    if (caseCache.has(serial)) return caseCache.get(serial);
    const binding = bindings.get(serial);
    if (!binding) return [];
    const point = ownPoint(binding.account, binding.point), rows = pointRows.get(point) || [];
    const sample = instantBySerial.get(serial);
    const electrical = electricalObservations(sample), events = (eventsBySerial.get(serial) || []).filter(event => event.kind && civilMilliseconds(event.at) != null).sort((a, b) => a.at.localeCompare(b.at));
    const latestAt = sample?.latest?.at, latestMonth = ordinal(latestAt), latestIndex = monthIndexes.get(latestAt?.slice(0, 7));
    const rawValues = sample?.latest?.values, valueAt = field => Array.isArray(rawValues) ? rawValues[fieldIndexes.get(field)] : rawValues?.[field];
    const totalPower = valueAt('activeTotal'), phasePower = [1, 2, 3].map(p => valueAt('active' + p)).filter(value => Number.isFinite(value) && value > 0).reduce((sum, value) => sum + value, 0);
    const loadPower = Number.isFinite(totalPower) && totalPower >= 0.2 ? totalPower : phasePower;
    const potentialLoadZero = civilMilliseconds(latestAt) != null && loadPower >= 0.2 && latestMonth < currentMonth && latestIndex != null && rows.length > 0
      && rows.every(row => Number.isFinite(row.values[latestIndex]) && row.values[latestIndex] >= 0) && rows.reduce((sum, row) => sum + row.values[latestIndex], 0) === 0;
    if ((!electrical.length || electrical.every(observation => observation.conditional)) && !events.length && !potentialLoadZero) {
      stats.skippedWithoutCandidates++; caseCache.set(serial, []); return [];
    }
    const wanted = new Set();
    for (const observation of [...electrical, ...events]) { const first = ordinal(observation.at); wanted.add(first - 1); for (let offset = 0; offset <= 2; offset++) wanted.add(first + offset); }
    if (potentialLoadZero) wanted.add(latestMonth);
    if (!comparisonCache.has(point)) {
      if (comparisonCache.size >= 64) comparisonCache.delete(comparisonCache.keys().next().value);
      comparisonCache.set(point, { wanted: new Set(), comparisons: new Map() });
    }
    const cached = comparisonCache.get(point), additional = [...wanted].filter(n => !cached.wanted.has(n));
    if (additional.length) {
      const built = indexPointComparisons(model.months, rows, now, additional);
      for (const [n, value] of built) cached.comparisons.set(n, value);
      for (const n of additional) cached.wanted.add(n);
      stats.comparisonBuilds++; stats.comparisonMonths += built.size;
    }
    const comparisons = cached.comparisons;
    const eventTimes = events.map(event => civilMilliseconds(event.at)), candidates = new Map(), groups = new Map();
    const addCandidate = n => { if (comparisons.get(n)?.available && !candidates.has(n)) candidates.set(n, []); };
    for (const observation of electrical) {
      const first = ordinal(observation.at);
      for (let offset = 0; offset <= 2; offset++) {
        const n = first + offset; addCandidate(n); if (candidates.has(n)) candidates.get(n).push(observation);
      }
    }
    for (const event of events) { const first = ordinal(event.at); for (let offset = 0; offset <= 2; offset++) addCandidate(first + offset); }
    // Positive instantaneous power is a loaded-meter observation, not energy.
    // It is relevant only when the exact same TU's complete monthly volume is 0.
    let loadZero = null;
    if (potentialLoadZero) {
      const n = latestMonth, monthly = comparisons.get(n);
      if (monthly?.available && monthly.value === 0) {
        loadZero = { serial: sample.serial, code: 'J31_LOAD_ZERO', title: 'Нагрузка ПУ при нулевом месячном ПО ТУ', at: sample.latest.at, ms: civilMilliseconds(sample.latest.at), count: 1,
          detail: `В момент измерения P=${fmt(loadPower)} кВт; полный месячный объём собственной ТУ равен 0 кВт·ч. Мгновенная мощность не интегрировалась в энергию.`, conditional: true, timestampDetailExact: true, observationPeriod: sample.latest.at.slice(0, 7), recommendation: 'Сверить полноту ПО собственной ТУ, дату замены ПУ, контрольные показания и профиль нагрузки.' };
        addCandidate(n); candidates.get(n).push(loadZero);
      }
    }
    const availability = {
      instant: { loaded: !!instantLoaded, matched: !!sample, meaningfulEvidence: electrical.length > 0 || !!loadZero, reason: !instantLoaded ? 'Журнал 31 не загружен.' : !sample ? 'Для этого ПУ нет измерений журнала 31.' : !electrical.length && !loadZero ? 'Нет значимых датированных электрических признаков.' : '' },
      events: { loaded: !!eventsLoaded, matched: (eventsBySerial.get(serial)?.length || 0) > 0, recognizedEvents: events.length, reason: !eventsLoaded ? 'Журнал 46 не загружен.' : !events.length ? 'Для этого ПУ нет распознанных событий вскрытия или магнитного воздействия.' : '' },
    };
    const pointLabel = [rows[0]?.pointName, rows[0]?.pointNumber && '№ ' + rows[0].pointNumber, rows[0]?.point && 'СТЕК ' + rows[0].point].filter(Boolean).join(' · ');
    function addCase(scenario, month, observations, eventRanges, { priority, temporalRelation, reason = '' } = {}) {
      const e = electricalSummary(observations), v = eventSummary(events, eventRanges), evidence = { ...e, ...v, serial: binding.serial, sameMeter: true, samePoint: true }; delete evidence.ranges;
      const earliest = [...observations, ...v.events].map(item => item.at).sort()[0], anchor = earliest ? comparisons.get(ordinal(earliest) - 1) : null;
      const additionalDrop = anchor?.available && anchor.value > 0 && month ? (1 - month.value / anchor.value) * 100 : null;
      const preExistingDecline = month && anchor?.available && anchor.thresholdMatches.length ? { month: anchor.month, value: anchor.value, comparisons: anchor.comparisons,
        additionalDropPercent: additionalDrop == null ? null : Math.round(additionalDrop * 10) / 10, newDecline: additionalDrop != null && additionalDrop >= 30,
        reason: additionalDrop != null && additionalDrop >= 30 ? 'После ранее низкого уровня есть дополнительное снижение не менее 30%.' : 'Низкий уровень наблюдался до признаков; новое снижение после них не подтверждено.' } : null;
      const preExisting = preExistingDecline && !preExistingDecline.newDecline;
      const seasonal = month?.seasonalAlternative || false, zone = priority || (seasonal || preExisting ? 'check' : scenario === 'journals_only' || scenario === 'load_zero' ? 'check' : 'high');
      const temporal = preExisting ? 'pre_existing' : temporalRelation || ((observations.some(o => ordinal(o.at) === ordinal(month?.month)) || v.events.some(event => ordinal(event.at) === ordinal(month?.month))) ? 'same_month' : 'after');
      const groupKey = `${scenario}|${zone}|${temporal}|${seasonal}`;
      const period = { month: month?.month || null, value: month?.value ?? null, comparisons: month?.comparisons || unavailableComparisons(reason || 'Снижение в допустимом окне не установлено.'), thresholdMatches: month?.thresholdMatches || [], seasonalAlternative: seasonal,
        temporalRelation: temporal, preExistingDecline, evidence, supportingMonthlyFlags: [] };
      const temporalText = temporal === 'same_month' ? 'Это совпадение в пределах месяца; порядок изменения потребления внутри месяца не установлен.'
        : temporal === 'after' ? 'Снижение зарегистрировано в последующем месяце, не позднее двух календарных месяцев после признаков. Причинная связь не установлена.'
        : temporal === 'pre_existing' ? preExistingDecline.reason : 'Журналы содержат совместимые по времени признаки одного ПУ, но подходящее снижение потребления не установлено.';
      period.detail = `${month?.month ? `${month.month}: ПО собственной ТУ ${fmt(month.value)} кВт·ч. ${comparisonText(period.comparisons)}. ` : ''}${temporalText}${preExistingDecline ? ` До признаков: ${preExistingDecline.month}, ${fmt(preExistingDecline.value)} кВт·ч; дополнительное снижение ${preExistingDecline.additionalDropPercent == null ? 'не вычисляется при нулевой базе' : fmt(preExistingDecline.additionalDropPercent) + '%'}.` : ''}${seasonal ? ' Альтернатива: расход в том же месяце прошлого года не ниже более чем на 10%; возможна сезонность.' : ''}${reason ? ' ' + reason : ''}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { id: JSON.stringify([binding.account, binding.point, serial, groupKey]), account: binding.account, serial: binding.serial,
          point: { key: binding.point, label: pointLabel }, scope: 'ЛС + ТУ', consumptionScope: 'События и измерения одного ПУ; потребление его собственной ЛС + ТУ', scenario, priority: zone,
          score: preExisting ? 10 : scenario === 'combined' && !seasonal ? 25 : scenario === 'journals_only' || scenario === 'load_zero' || seasonal ? 10 : 15,
          availability, months: [], evidence: { electrical: [], events: [] }, supportingMonthlyFlags: [], recommendation: scenario === 'load_zero'
            ? loadZero.recommendation : 'Сверить журнал работ, замену ПУ, полноту ПО ТУ и режим объекта; проверить схему учёта и профиль нагрузки. Совокупность признаков определяет приоритет проверки, а не доказанный объём недоучёта.', _observations: [], _eventRanges: [] };
        groups.set(groupKey, group);
      }
      group.months.push(period); group._observations.push(...observations); group._eventRanges.push(...eventRanges);
    }
    const usedJoint = new Set();
    for (const [n, observations] of [...candidates].sort((a, b) => a[0] - b[0])) {
      const month = comparisons.get(n), allRange = [lower(eventTimes, monthStart(n - 2)), lower(eventTimes, monthStart(n + 1))];
      const significant = observations.filter(observation => !observation.conditional), paired = [], pairedRanges = [];
      if (month.thresholdMatches.length) {
        for (const observation of observations) {
          const from = Math.max(allRange[0], lower(eventTimes, observation.ms - WINDOW)), to = Math.min(allRange[1], upper(eventTimes, observation.ms + WINDOW));
          if (to > from) { paired.push(observation); pairedRanges.push([from, to]); usedJoint.add(`${observation.code}|${observation.at}`); }
        }
        if (paired.length) addCase('combined', month, paired, pairedRanges);
        else {
          if (significant.length) addCase('electrical_drop', month, significant, []);
          if (allRange[1] > allRange[0]) addCase('event_drop', month, [], [allRange]);
        }
      }
      if (loadZero && ordinal(loadZero.at) === n && !paired.includes(loadZero)) addCase('load_zero', month, [loadZero], [], { priority: 'check', temporalRelation: 'same_month' });
    }
    // No fabricated consumption drop when only the two journals coincide.
    const unscoredJoint = [], jointRanges = [];
    for (const observation of electrical) {
      if (observation.conditional || usedJoint.has(`${observation.code}|${observation.at}`)) continue;
      const from = lower(eventTimes, observation.ms - WINDOW), to = upper(eventTimes, observation.ms + WINDOW);
      if (to > from) { unscoredJoint.push(observation); jointRanges.push([from, to]); }
    }
    if (unscoredJoint.length) addCase('journals_only', null, unscoredJoint, jointRanges, { priority: 'check', temporalRelation: 'journals_only', reason: 'Снижение не подтверждено доступными завершёнными месяцами и настроенными здесь порогами сопоставления.' });
    const cases = [...groups.values()];
    for (const item of cases) {
      item.months.sort((a, b) => String(a.month || '').localeCompare(String(b.month || '')));
      Object.assign(item, item.months[0]);
      const electrical = electricalSummary(item._observations), event = eventSummary(events, item._eventRanges); delete event.ranges;
      item.evidence = { ...electrical, ...event, serial: binding.serial, sameMeter: true, samePoint: true };
      item.first = [...item.evidence.electrical, ...item.evidence.events].map(e => e.at).sort()[0] || null;
      item.last = [...item.evidence.electrical, ...item.evidence.events].map(e => e.at).sort().at(-1) || null;
      item.evidenceTruncated = item.evidence.electricalDetailsTruncated || item.evidence.eventDetailsTruncated;
      delete item._observations; delete item._eventRanges;
    }
    cases.sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || b.score - a.score || String(a.month).localeCompare(String(b.month)));
    caseCache.set(serial, cases); return cases;
  }
  function attachMonthlySupport(cases, result) {
    const context = result.meter.pointCount > 1 ? 'ЛС, все ТУ (контекст)' : 'ЛС + ТУ';
    for (const item of cases) {
      const all = new Map();
      for (const period of item.months) {
        const n = monthIndexes.get(period.month) ?? -1;
        period.supportingMonthlyFlags = n < 0 ? [] : result.flags.filter(flag => !flag.source && Number.isInteger(flag.shiftIdx)
          && (['S1', 'S13'].includes(flag.code) ? n < flag.shiftIdx : n >= flag.shiftIdx)
          && (flag.endIdx == null || n < flag.endIdx)).map(flag => ({ code: flag.code, title: flag.title, detail: flagObservation(flag), scope: context }));
        for (const flag of period.supportingMonthlyFlags) all.set(flag.code, flag);
      }
      item.supportingMonthlyFlags = [...all.values()];
    }
  }
  const cloneCase = item => ({ ...item, supportingMonthlyFlags: [], months: item.months.map(period => ({ ...period, supportingMonthlyFlags: [] })) });
  const casesForSerial = serial => canonicalCases(serial).map(cloneCase);
  function reportCases(accounts, resultsByAccount = null) {
    const out = [];
    for (const [serial, binding] of bindings) if (!accounts || accounts.has(binding.account)) {
      const cases = casesForSerial(serial), result = resultsByAccount?.get(binding.account);
      if (result) attachMonthlySupport(cases, result);
      out.push(...cases);
    }
    return out;
  }
  return { casesForSerial, attachMonthlySupport, reportCases, stats };
}
