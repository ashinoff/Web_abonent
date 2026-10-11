import { idKey } from './core.js';
import { pointKey, samePoint } from './monthly.js';
import { serialKey, normalizeEventPack, eventClassification } from './journals.js';
import { createJournalCorrelation } from './journal-correlation.js';

const monthKey = ({ y, m }) => `${y}-${String(m + 1).padStart(2, '0')}`;
const minDate = values => values.filter(Boolean).sort()[0] || null;
const maxDate = values => values.filter(Boolean).sort().at(-1) || null;
const dated = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(value || ''));
const pointId = (account, point) => JSON.stringify([account, point]);
const informational = signal => signal.informational === true || /UNBALANCE|ASYMMETRY|НЕСИММЕТР/i.test(`${signal.code} ${signal.title}`);
const registrations = event => Number.isFinite(event.count) && event.count > 0 ? event.count : 1;

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
  const instant = journals.instant || null, events = journals.events ? normalizeEventPack(journals.events) : null;
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
  let eventRows = 0, eventGroups = 0, eventFirst = null, eventLast = null;
  for (const group of events?.groups || []) {
    const key = serialKey(group.serial);
    if (!key || !dated(group.first) || !dated(group.last)) continue;
    const classifications = (group.codes || []).map(eventClassification).filter(Boolean), kind = classifications[0];
    const examples = group.examples || [], description = examples.length === 1 ? examples[0].description : examples.map(example => `${example.at}: ${example.description}`).join('\n');
    const item = { ...group, serial: String(group.serial), at: group.first, description,
      groupId: JSON.stringify([key, group.month, group.codes || []]), aggregationVersion: 1,
      timestampDetailExact: examples.some(example => example.at === group.first),
      kind: kind?.kind || null, title: classifications.length ? classifications.map(c => c.title).join('; ') : 'Событие журнала 46', code: kind?.code || null,
      recommendation: kind?.recommendation || '', classifications };
    eventRows += registrations(item); eventGroups++;
    if (!eventFirst || item.first < eventFirst) eventFirst = item.first;
    if (!eventLast || item.last > eventLast) eventLast = item.last;
    if (!eventsBySerial.has(key)) eventsBySerial.set(key, []);
    eventsBySerial.get(key).push(item);
  }
  for (const entries of eventsBySerial.values()) entries.sort((a, b) => a.at.localeCompare(b.at));
  const sourceKeys = { instant: [...instantBySerial.keys()], events: [...eventsBySerial.keys()] };
  const sourceMaps = { instant: instantBySerial, events: eventsBySerial };
  const matchedCounts = Object.fromEntries(['instant', 'events'].map(role => [role, sourceKeys[role].filter(key => bindings.has(key)).length]));
  const sourcePeriod = {
    instant: [minDate((instant?.meters || []).map(m => m.first)), maxDate((instant?.meters || []).map(m => m.last))],
    events: [eventFirst, eventLast],
  };
  const eventCountsBySerial = new Map([...eventsBySerial].map(([key, groups]) => [key, groups.reduce((sum, group) => sum + registrations(group), 0)]));
  const matchedEventRows = sourceKeys.events.reduce((sum, key) => sum + (bindings.has(key) ? eventCountsBySerial.get(key) : 0), 0);
  const matchedEventGroups = sourceKeys.events.reduce((sum, key) => sum + (bindings.has(key) ? eventsBySerial.get(key).length : 0), 0);
  function coverage(scope = null) {
    const source = (role, data) => ({ loaded: !!data, totalMeters: sourceKeys[role].length,
      matchedMeters: scope ? [...scope].filter(k => bindings.has(k) && sourceMaps[role].has(k)).length : matchedCounts[role],
      first: sourcePeriod[role][0], last: sourcePeriod[role][1], warnings: [...(data?.warnings || []), ...(role === 'instant' && data && (data.analysisVersion || 1) < 2
        ? ['Сохранён журнал 31 предыдущей версии: новые электрические проверки и точные описания крайних измерений могут быть недоступны. Обновите журнал при доступе к сети.'] : [])], ...(role === 'instant' ? { reportPeriod: data?.reportPeriod || null, coefficientMode: data?.coefficientMode || 'unknown' }
        : { totalRegistrations: eventRows, totalGroups: eventGroups,
          matchedRegistrations: scope ? [...scope].reduce((sum, key) => sum + (bindings.has(key) ? eventCountsBySerial.get(key) || 0 : 0), 0) : matchedEventRows,
          matchedGroups: scope ? [...scope].reduce((sum, key) => sum + (bindings.has(key) ? eventsBySerial.get(key)?.length || 0 : 0), 0) : matchedEventGroups }) });
    return { instant: source('instant', instant), events: source('events', events), monthlyFirst: model.months.length ? monthKey(model.months[0]) : null, monthlyLast: model.months.length ? monthKey(model.months.at(-1)) : null };
  }
  const unmatched = {};
  for (const role of ['instant', 'events']) {
    const keys = sourceKeys[role].filter(k => !bindings.has(k)), grouped = new Map();
    for (const key of keys) {
      const reason = reasons.get(key) || 'Серийный номер отсутствует в реестре.';
      grouped.set(reason, (grouped.get(reason) || 0) + 1);
    }
    unmatched[role] = { meters: keys.length, rows: role === 'events' ? keys.reduce((sum, k) => sum + eventCountsBySerial.get(k), 0) : keys.reduce((sum, k) => sum + (instantBySerial.get(k).samples || 0), 0),
      ...(role === 'events' ? { groups: keys.reduce((sum, k) => sum + eventsBySerial.get(k).length, 0) } : {}), reasons: [...grouped].map(([reason, meters]) => ({ reason, meters })) };
  }
  function serialsForRows(rows) {
    return new Set(rows.flatMap(row => [...(points.get(pointId(row.accountKey, pointKey(row))) || [])]));
  }
  const correlation = createJournalCorrelation({ model, bindings, instantBySerial, eventsBySerial, instantFields: instant?.fields || [], instantLoaded: !!instant, eventsLoaded: !!events });
  function supplement(result, rows) {
    const serials = serialsForRows(rows), matchedEvents = [], flags = [], latestMetrics = [], cases = [];
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
          const item = { ...signal, code, serial: sample.serial, source: 'instant', informational: info, supportingEvidence: !info && !signal.conditional, pts: info || signal.conditional ? 0 : 10, weak: true,
            detail: `ПУ ${sample.serial}: ${signal.detail || signal.title || 'электрический признак'}. Наблюдений: ${signal.count || 1}.${signal.first ? ` Первое: ${signal.first}.` : ''}${signal.last && signal.last !== signal.first ? ` Последнее: ${signal.last}.` : ''}`,
            recommendation: signal.recommendation || 'Проверить исходные измерения и схему подключения ПУ.' };
          flags.push(item);
          for (const period of signal.months || []) {
            const exact = Array.isArray(period.observations) && period.observations.length > 0;
            const observations = exact ? period.observations : [...new Set([period.first, period.last].filter(dated))].map(at => ({ at,
              detail: at === period.first ? `Сводка за месяц: ${period.detail || signal.detail || ''}` : 'В старом формате сохранено последнее время признака; параметры этого измерения недоступны.' }));
            for (const observation of observations) if (dated(observation.at)) matchedEvents.push({ serial: sample.serial, at: observation.at,
              description: `${item.title}. ${observation.detail || ''} Наблюдений в месяце: ${period.count || 1}.`, kind: 'electrical', title: item.title, code: item.code,
              timestampDetailExact: exact, informational: info, conditional: signal.conditional === true });
          }
        }
      }
      const byKind = new Map();
      for (const event of eventsBySerial.get(key) || []) {
        matchedEvents.push(event);
        if (!event.kind) continue;
        for (const classification of event.classifications) {
          if (!byKind.has(classification.code)) byKind.set(classification.code, []);
          byKind.get(classification.code).push({ ...event, ...classification });
        }
      }
      for (const [code, entries] of byKind) {
        const first = entries[0], last = maxDate(entries.map(entry => entry.last)), count = entries.reduce((sum, entry) => sum + registrations(entry), 0);
        flags.push({ code: String(code).startsWith('J46_') ? code : `J46_${code}`, serial: first.serial, title: first.title, source: 'events', supportingEvidence: true, pts: 10, weak: true, first: first.at, last, count, groupCount: entries.length,
          detail: `ПУ ${first.serial}: ${count} регистраций журнала 46 в ${entries.length} месячных группах. Первая: ${first.at}; последняя: ${last}. Повторные регистрации не считаются независимыми вскрытиями. Примеры описаний с их фактическими датами: ${first.description}`,
          recommendation: first.recommendation || 'Сверить событие с актами работ и проверить состояние ПУ и пломб.' });
      }
      cases.push(...correlation.casesForSerial(key));
    }
    correlation.attachMonthlySupport(cases, result);
    const strongest = new Map();
    for (const item of cases) if (!strongest.has(serialKey(item.serial)) || item.score > strongest.get(serialKey(item.serial)).score) strongest.set(serialKey(item.serial), item);
    const scoredSerials = new Set();
    for (const flag of flags) {
      const serial = serialKey(flag.serial);
      if (strongest.has(serial) || scoredSerials.has(serial)) flag.pts = 0;
      else if (flag.pts > 0) { flag.pts = 10; scoredSerials.add(serial); }
    }
    const titles = { combined: 'Совокупность двух журналов и снижения потребления', electrical_drop: 'Электрический признак и снижение потребления', event_drop: 'Событие ПУ и снижение потребления', journals_only: 'Совпадение двух журналов без подтверждённого снижения', load_zero: 'Нагрузка ПУ при нулевом месячном ПО собственной ТУ' };
    for (const item of cases) {
      flags.push({ code: ['journals_only', 'load_zero'].includes(item.scenario) ? item.scenario === 'load_zero' ? 'J_LOAD_ZERO' : 'J_JOURNALS_ONLY' : 'J_CORRELATION',
        caseId: item.id, serial: item.serial, title: titles[item.scenario], source: 'correlation', pts: strongest.get(serialKey(item.serial)) === item ? item.score : 0, weak: true,
        first: item.first, last: item.last, count: item.months.filter(month => month.month).length || 1, month: item.month, months: item.months.map(month => month.month).filter(Boolean),
        detail: `ПУ ${item.serial}; ${item.scope}: ${item.point.label}. ${item.detail}${item.months.length > 1 ? ` Совокупность повторяется в ${item.months.length} месяцах; все объёмы и сравнения представлены в сопоставлениях.` : ''}`,
        recommendation: item.recommendation });
    }
    matchedEvents.sort((a, b) => a.at.localeCompare(b.at));
    result.monthlyScore = result.score; result.monthlyCls = result.cls;
    result.journalScore = Math.min(100, flags.reduce((sum, flag) => sum + flag.pts, 0));
    result.journalPriority = cases.some(item => item.priority === 'high') ? 'high' : flags.some(f => f.pts > 0) ? 'check' : 'none';
    result.flags.push(...flags);
    const truncated = matchedEvents.length > 500;
    // Keep relevant dates in the chart window before older/out-of-period events.
    const firstMonth = model.months.length ? monthKey(model.months[0]) : '', lastMonth = model.months.length ? monthKey(model.months.at(-1)) : '';
    const inPeriod = event => event.at.slice(0, 7) >= firstMonth && event.at.slice(0, 7) <= lastMonth;
    const display = truncated ? [...matchedEvents.filter(inPeriod), ...matchedEvents.filter(e => !inPeriod(e))].slice(0, 500).sort((a,b) => a.at.localeCompare(b.at)) : matchedEvents;
    const sortedCases = [...cases].sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || b.score - a.score || String(a.month).localeCompare(String(b.month)));
    const groupedEvents = matchedEvents.filter(e => e.aggregationVersion === 1), electricalMarkerCount = matchedEvents.length - groupedEvents.length;
    const eventRegistrationCount = groupedEvents.reduce((sum, e) => sum + registrations(e), 0), recognizedRegistrationCount = groupedEvents.reduce((sum, e) => sum + (e.kind ? registrations(e) : 0), 0);
    result.journal = { events: display, eventCount: eventRegistrationCount + electricalMarkerCount, eventRegistrationCount, eventGroupCount: groupedEvents.length,
      recognizedRegistrationCount, electricalMarkerCount, displayEntryCount: matchedEvents.length, displayTruncated: truncated, flags, latestMetrics, latestMetricCount, latestMetricsTruncated: latestMetricCount > latestMetrics.length, coverage: coverage(serials), unmatched,
      cases: sortedCases.slice(0, 20), caseCount: cases.length, caseMonthCount: cases.reduce((count, item) => count + item.months.filter(month => month.month).length, 0), casesTruncated: cases.length > 20,
      caseCounts: Object.fromEntries(Object.keys(titles).map(scenario => [scenario, cases.filter(item => item.scenario === scenario).length])),
      outsidePeriod: matchedEvents.reduce((sum, e) => sum + (!inPeriod(e) ? registrations(e) : 0), 0),
      outsidePeriodRegistrations: groupedEvents.reduce((sum, e) => sum + (!inPeriod(e) ? registrations(e) : 0), 0), recognizedEvents: recognizedRegistrationCount + electricalMarkerCount };
    return result;
  }
  function reportEvents(accounts) {
    const out = [];
    for (const [key, entries] of eventsBySerial) {
      const binding = bindings.get(key);
      if (accounts && (!binding || !accounts.has(binding.account))) continue;
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
  function* flaggedMeters() {
    // Selection comes from journal findings, including conditional observations,
    // and never from an account's monthly score. Unmapped PUs remain visible.
    const keys = new Set([...instantBySerial.keys(), ...eventsBySerial.keys()]);
    for (const key of keys) {
      const sample = instantBySerial.get(key), eventFlags = new Map();
      for (const event of eventsBySerial.get(key) || []) for (const kind of event.classifications) {
        let flag = eventFlags.get(kind.code);
        if (!flag) {
          flag = { code: kind.code, title: kind.title, recommendation: kind.recommendation, count: 0, first: event.first, last: event.last, months: new Map() };
          eventFlags.set(kind.code, flag);
        }
        const count = registrations(event);
        flag.count += count; flag.first = minDate([flag.first, event.first]); flag.last = maxDate([flag.last, event.last]);
        flag.months.set(event.month, (flag.months.get(event.month) || 0) + count);
      }
      const instantFlags = sample?.signals || [];
      if (!instantFlags.length && !eventFlags.size) continue;
      const binding = bindings.get(key);
      yield { serial: String(sample?.serial || eventsBySerial.get(key)?.[0]?.serial || key), binding,
        mappingReason: binding ? '' : reasons.get(key) || 'Серийный номер отсутствует в реестре.',
        instantPresent: !!sample, eventsPresent: eventsBySerial.has(key), instantFlags,
        eventFlags: [...eventFlags.values()].map(flag => ({ ...flag, months: [...flag.months].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })) })) };
    }
  }
  return { supplement, coverage, unmatched, reportEvents, reportMetrics, flaggedMeters, casesForSerial: correlation.casesForSerial, reportCases: correlation.reportCases, serialsForRows, stats: { eventRows, eventGroups, correlation: correlation.stats } };
}
