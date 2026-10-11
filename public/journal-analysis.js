import { idKey } from './core.js';
import { pointKey, samePoint } from './monthly.js';
import { serialKey, eventKinds } from './journals.js';

const monthKey = ({ y, m }) => `${y}-${String(m + 1).padStart(2, '0')}`;
const minDate = values => values.filter(Boolean).sort()[0] || null;
const maxDate = values => values.filter(Boolean).sort().at(-1) || null;
const unique = values => [...new Set(values.filter(Boolean))];
const dated = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(value || ''));
const pointId = (account, point) => JSON.stringify([account, point]);
const informational = signal => signal.informational === true || /UNBALANCE|ASYMMETRY|НЕСИММЕТР/i.test(`${signal.code} ${signal.title}`);

// An instantaneous reading cannot estimate energy. Correlation only reports
// temporal coincidence against three immediately preceding complete months.
export function correlateJournalMonths(months, values, markers, now = new Date()) {
  const civilParts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  const currentMonth = `${civilParts.year}-${civilParts.month}`;
  const observed = new Map();
  for (const marker of markers) {
    if (!dated(marker.at)) continue;
    const key = marker.at.slice(0, 7);
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push(marker);
  }
  const coincidences = [];
  for (let i = 3; i < months.length; i++) {
    const key = monthKey(months[i]), inMonth = observed.get(key), value = values[i];
    if (!inMonth?.length || key >= currentMonth || value == null || value < 0) continue;
    const previous = values.slice(i - 3, i);
    if (previous.length !== 3 || previous.some(v => v == null || !Number.isFinite(v) || v <= 0)) continue;
    const sorted = [...previous].sort((a, b) => a - b), baseline = sorted[1];
    if (baseline < 30 || value > baseline * 0.5) continue;
    coincidences.push({ month: key, value, baseline, dropPercent: Math.round((1 - value / baseline) * 100), markers: inMonth });
  }
  return coincidences;
}

export function createJournalAnalysis(model, records, journals = {}) {
  const instant = journals.instant || null, events = journals.events || null;
  if (!instant && !events) return null;
  const identities = new Map(), bindings = new Map(), points = new Map(), reasons = new Map();
  for (const record of records) {
    const fields = record.fields || {}, serial = serialKey(fields.meter);
    if (!serial) continue;
    const choices = model.aliases.get(idKey(fields.account));
    const account = choices?.size === 1 ? [...choices][0] : idKey(fields.account);
    const identity = pointId(account, pointKey(fields));
    if (!identities.has(serial)) identities.set(serial, new Map());
    identities.get(serial).set(identity, fields);
  }
  for (const [serial, candidates] of identities) {
    if (candidates.size !== 1) { reasons.set(serial, 'Серийный номер связан с несколькими ЛС или ТУ в реестре.'); continue; }
    const fields = [...candidates.values()][0], choices = model.aliases.get(idKey(fields.account));
    if (choices?.size !== 1) { reasons.set(serial, choices?.size ? 'ЛС реестра неоднозначно связан с потреблением.' : 'ЛС реестра отсутствует в потреблении.'); continue; }
    if (!pointKey(fields)) { reasons.set(serial, 'В реестре отсутствуют идентификаторы ТУ.'); continue; }
    const account = [...choices][0], matches = model.accounts.get(account).filter(row => samePoint(row, fields));
    if (!matches.length || new Set(matches.map(pointKey)).size !== 1) {
      reasons.set(serial, matches.length ? 'ТУ реестра соответствует нескольким точкам потребления.' : 'ЛС + ТУ не найдены в потреблении.'); continue;
    }
    const point = pointKey(matches[0]), binding = { account, point, serial: String(fields.meter).trim(), fields };
    bindings.set(serial, binding);
    const key = pointId(account, point);
    if (!points.has(key)) points.set(key, new Set());
    points.get(key).add(serial);
  }
  const instantBySerial = new Map(), eventsBySerial = new Map();
  for (const meter of instant?.meters || []) {
    const key = serialKey(meter.serial); if (key) instantBySerial.set(key, meter);
  }
  let eventRows = 0;
  for (const row of events?.rows || []) {
    if (!Array.isArray(row)) continue;
    const [serial, at, description] = row, key = serialKey(serial);
    if (!key || !dated(at)) continue;
    eventRows++;
    const classifications = eventKinds(description), kind = classifications[0];
    const item = { serial: String(serial), at, description: String(description || ''), kind: kind?.kind || null, title: kind?.title || 'Событие журнала 46', code: kind?.code || null, recommendation: kind?.recommendation || '', classifications };
    if (!eventsBySerial.has(key)) eventsBySerial.set(key, []);
    eventsBySerial.get(key).push(item);
  }
  for (const entries of eventsBySerial.values()) entries.sort((a, b) => a.at.localeCompare(b.at));
  const sourceKeys = { instant: [...instantBySerial.keys()], events: [...eventsBySerial.keys()] };
  const sourceMaps = { instant: instantBySerial, events: eventsBySerial };
  const matchedCounts = Object.fromEntries(['instant', 'events'].map(role => [role, sourceKeys[role].filter(key => bindings.has(key)).length]));
  const sourcePeriod = {
    instant: [minDate((instant?.meters || []).map(m => m.first)), maxDate((instant?.meters || []).map(m => m.last))],
    events: [minDate([...eventsBySerial.values()].map(list => list[0]?.at)), maxDate([...eventsBySerial.values()].map(list => list.at(-1)?.at))],
  };
  function coverage(scope = null) {
    const source = (role, data) => ({ loaded: !!data, totalMeters: sourceKeys[role].length,
      matchedMeters: scope ? [...scope].filter(k => bindings.has(k) && sourceMaps[role].has(k)).length : matchedCounts[role],
      first: sourcePeriod[role][0], last: sourcePeriod[role][1], warnings: [...(data?.warnings || [])], ...(role === 'instant' ? { reportPeriod: data?.reportPeriod || null, coefficientMode: data?.coefficientMode || 'unknown' } : {}) });
    return { instant: source('instant', instant), events: source('events', events), monthlyFirst: model.months.length ? monthKey(model.months[0]) : null, monthlyLast: model.months.length ? monthKey(model.months.at(-1)) : null };
  }
  const unmatched = {};
  for (const role of ['instant', 'events']) {
    const keys = sourceKeys[role].filter(k => !bindings.has(k)), grouped = new Map();
    for (const key of keys) {
      const reason = reasons.get(key) || 'Серийный номер отсутствует в реестре.';
      grouped.set(reason, (grouped.get(reason) || 0) + 1);
    }
    unmatched[role] = { meters: keys.length, rows: role === 'events' ? keys.reduce((sum, k) => sum + eventsBySerial.get(k).length, 0) : keys.reduce((sum, k) => sum + (instantBySerial.get(k).samples || 0), 0), reasons: [...grouped].map(([reason, meters]) => ({ reason, meters })) };
  }
  function serialsForRows(rows) {
    return new Set(rows.flatMap(row => [...(points.get(pointId(row.accountKey, pointKey(row))) || [])]));
  }
  function supplement(result, rows) {
    const serials = serialsForRows(rows), matchedEvents = [], markers = [], flags = [], latestMetrics = [];
    let latestMetricCount = 0;
    for (const key of serials) {
      const sample = instantBySerial.get(key);
      if (sample) {
        if (sample.latest) {
          latestMetricCount++;
          if (latestMetrics.length < 50) {
            const fields = instant.fields || [], values = Array.isArray(sample.latest.values) ? Object.fromEntries(fields.map((field, i) => [field, sample.latest.values[i]])) : sample.latest.values || {};
            latestMetrics.push({ serial: sample.serial, at: sample.latest.at || null, values, fields, coefficientMode: instant.coefficientMode || 'unknown' });
          }
        }
        for (const signal of sample.signals || []) {
          const info = informational(signal), code = String(signal.code || 'J31_OBSERVATION');
          const item = { ...signal, code, source: 'instant', pts: info ? 0 : 10, weak: true,
            detail: `ПУ ${sample.serial}: ${signal.detail || signal.title || 'электрический признак'}. Наблюдений: ${signal.count || 1}.${signal.first ? ` Первое: ${signal.first}.` : ''}${signal.last && signal.last !== signal.first ? ` Последнее: ${signal.last}.` : ''}`,
            recommendation: signal.recommendation || 'Проверить исходные измерения и схему подключения ПУ.' };
          flags.push(item);
          for (const period of signal.months || []) {
            const at = period.first;
            if (!dated(at)) continue;
            const marker = { serial: sample.serial, at, description: `${item.title}. ${period.detail || signal.detail || ''} Наблюдений в месяце: ${period.count || 1}.`, kind: 'electrical', title: item.title, code: item.code };
            matchedEvents.push(marker); if (!info) markers.push(marker);
            if (dated(period.last) && period.last !== at) matchedEvents.push({ ...marker, at: period.last });
          }
        }
      }
      const byKind = new Map();
      for (const event of eventsBySerial.get(key) || []) {
        matchedEvents.push(event);
        if (!event.kind) continue;
        markers.push({ ...event, title: event.classifications.map(item => item.title).join(' / ') });
        for (const classification of event.classifications) {
          if (!byKind.has(classification.code)) byKind.set(classification.code, []);
          byKind.get(classification.code).push({ ...event, ...classification });
        }
      }
      for (const [code, entries] of byKind) {
        const first = entries[0], last = entries.at(-1);
        flags.push({ code: String(code).startsWith('J46_') ? code : `J46_${code}`, title: first.title, source: 'events', pts: 10, weak: true, first: first.at, last: last.at, count: entries.length,
          detail: `ПУ ${first.serial}: ${entries.length} событий. Первое: ${first.at}; последнее: ${last.at}. ${first.description}`,
          recommendation: first.recommendation || 'Сверить событие с актами работ и проверить состояние ПУ и пломб.' });
      }
    }
    const coincidences = markers.length ? correlateJournalMonths(model.months, result.meter.values, markers) : [];
    for (const item of coincidences) {
      const titles = unique(item.markers.map(marker => `${marker.title} (ПУ ${marker.serial})`));
      flags.push({ code: 'J_CORRELATION', title: 'Событие совпало со снижением потребления', source: 'correlation', pts: 15, weak: true,
        first: minDate(item.markers.map(m => m.at)), last: maxDate(item.markers.map(m => m.at)), count: item.markers.length,
        month: item.month, detail: `${item.month}: ${item.value.toLocaleString('ru-RU')} кВт·ч; медиана трёх предыдущих полных положительных месяцев ${item.baseline.toLocaleString('ru-RU')} кВт·ч, снижение ${item.dropPercent}%. ${titles.join('; ')}. Это совпадение в пределах месяца; порядок изменения потребления внутри месяца не установлен.`,
        recommendation: 'Сопоставить даты события с актами обслуживания, заменой ПУ, режимом работы потребителя и более подробным профилем нагрузки.' });
    }
    matchedEvents.sort((a, b) => a.at.localeCompare(b.at));
    result.monthlyScore = result.score; result.monthlyCls = result.cls;
    result.journalScore = Math.min(100, flags.reduce((sum, flag) => sum + flag.pts, 0));
    result.journalPriority = coincidences.length ? 'high' : flags.some(f => f.pts > 0) ? 'check' : 'none';
    result.flags.push(...flags);
    const truncated = matchedEvents.length > 500;
    // Keep relevant dates in the chart window before older/out-of-period events.
    const firstMonth = model.months.length ? monthKey(model.months[0]) : '', lastMonth = model.months.length ? monthKey(model.months.at(-1)) : '';
    const inPeriod = event => event.at.slice(0, 7) >= firstMonth && event.at.slice(0, 7) <= lastMonth;
    const display = truncated ? [...matchedEvents.filter(inPeriod), ...matchedEvents.filter(e => !inPeriod(e))].slice(0, 500).sort((a,b) => a.at.localeCompare(b.at)) : matchedEvents;
    result.journal = { events: display, eventCount: matchedEvents.length, displayTruncated: truncated, flags, latestMetrics, latestMetricCount, latestMetricsTruncated: latestMetricCount > latestMetrics.length, coverage: coverage(serials), unmatched,
      outsidePeriod: matchedEvents.filter(e => !inPeriod(e)).length, recognizedEvents: matchedEvents.filter(e => e.kind).length };
    return result;
  }
  function reportEvents() {
    const out = [];
    for (const [key, entries] of eventsBySerial) {
      const binding = bindings.get(key);
      for (const event of entries) out.push({ account: binding?.account || '', mappingReason: binding ? '' : reasons.get(key) || 'Серийный номер отсутствует в реестре.', ...event });
    }
    out.sort((a,b) => a.at.localeCompare(b.at));
    return out;
  }
  function reportMetrics(accounts) {
    const out = [], fields = instant?.fields || [];
    for (const [key, sample] of instantBySerial) {
      const binding = bindings.get(key);
      if (!binding || !sample.latest || accounts && !accounts.has(binding.account)) continue;
      const values = Array.isArray(sample.latest.values) ? Object.fromEntries(fields.map((field, i) => [field, sample.latest.values[i]])) : sample.latest.values || {};
      out.push({ account: binding.account, serial: sample.serial, at: sample.latest.at || null, values, coefficientMode: instant.coefficientMode || 'unknown', reportPeriod: instant.reportPeriod || null });
    }
    return out;
  }
  return { supplement, coverage, unmatched, reportEvents, reportMetrics, serialsForRows, stats: { eventRows } };
}
