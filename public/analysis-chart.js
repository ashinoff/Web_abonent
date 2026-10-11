import { splitYears, MONTH_LABELS, yearPath } from './chart-years.js';
import { fmt, ymLabel } from './analysis-engine.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const EVENT_KINDS = { intrusion: 'Вскрытие / пломбы', magnetic: 'Магнитное поле', electrical: 'Электрические параметры' };
const MAX_MONTH_EVENTS = 50;
const MAX_MONTH_CASES = 8;
const CASE_TITLES = { combined:'Параметры 31 + события 46 + снижение', electrical_drop:'Электрические признаки + снижение', event_drop:'События 46 + снижение', journals_only:'Признаки журналов 31 и 46 по одному ПУ', load_zero:'Нагрузка ПУ при нулевом ПО собственной ТУ' };
const isMonthlyEvent = event => event.kind !== 'electrical' && /^\d{4}-(0[1-9]|1[0-2])$/.test(String(event.month || '')) && !!event.first && !!event.last;
const registrationCount = event => isMonthlyEvent(event) && Number.isFinite(event.count) && event.count > 0 ? event.count : 1;
const monthlyEventLabel = event => `${monthLabel(event.month)} · ПУ ${event.serial}: ${event.title || EVENT_KINDS[event.kind] || 'Журнал 46'}, регистраций ${registrationCount(event)}. Первая регистрация ${eventDate(event.first)}; последняя ${eventDate(event.last)}.`;
function monthlyEventHTML(event) {
  const examples = (event.examples || []).slice(0,3);
  return `<p class="event-registration-count">Журнал 46 · ${escape(monthLabel(event.month))} · регистраций: <strong>${escape(registrationCount(event))}</strong>${Array.isArray(event.days) ? ` · дней с регистрациями: ${event.days.length}` : ''}.</p><p class="event-registration-range">Первая регистрация: ${escape(eventDate(event.first))}.<br>Последняя регистрация: ${escape(eventDate(event.last))}.</p><p class="event-registration-note">Число записей журнала не равно числу независимых вскрытий. Промежуток между крайними датами не означает непрерывную тревогу.</p>${examples.length ? `<div class="event-examples"><span>Фактические примеры записей</span>${examples.map(example=>`<div><time>${escape(eventDate(example.at))}</time><p>${escape(example.description)}</p></div>`).join('')}</div>` : `<p>${escape(event.description || 'Описание группы отсутствует.')}</p>`}${event.examplesTruncated ? '<p class="event-registration-note">Сохранено до 3 примеров. Месячная сводка — в Excel-отчёте; все исходные записи — в журнале 46.</p>' : ''}`;
}
export const journalCaseTitle = item => item.temporalRelation === 'pre_existing' ? 'Журнальные признаки на фоне прежнего снижения' : CASE_TITLES[item.scenario] || 'Совокупность признаков';
const monthLabel = month => {
  const parts = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  return parts ? ymLabel({y:Number(parts[1]),m:Number(parts[2])-1}) : 'Месяц сопоставления не установлен';
};
export function journalCaseMonths(item) {
  return Array.isArray(item.months) && item.months.length ? item.months : [item];
}
export function indexChartCases(months, cases = []) {
  const slots = new Map(months.map(({y,m},i)=>[`${y}-${String(m+1).padStart(2,'0')}`,i])), byMonth = new Map();
  let outsidePeriod = 0;
  for (const item of cases) {
    const seen = new Set();
    for (const entry of journalCaseMonths(item)) {
      if (!/^(\d{4})-(0[1-9]|1[0-2])$/.test(String(entry.month || '')) || seen.has(entry.month)) continue;
      seen.add(entry.month);
      const index = slots.get(entry.month);
      if (index === undefined) { outsidePeriod++; continue; }
      if (!byMonth.has(index)) byMonth.set(index, []);
      byMonth.get(index).push({item,entry});
    }
  }
  return {byMonth,outsidePeriod};
}
function comparisonHTML(comparisons = {}, thresholdMatches = []) {
  return `<dl class="case-comparisons">${[['previous','Предыдущий месяц'],['yearAgo','Тот же месяц год назад'],['median3','Медиана 3 предыдущих месяцев']].map(([key,title])=>{
    const value = comparisons[key];
    if (!value?.available || !Number.isFinite(value.value)) return `<div data-available="false"><dt>${title}</dt><dd>${Number.isFinite(value?.value) ? `<strong>${fmt(value.value,3)} кВт·ч</strong>` : ''}${escape(value?.reason || 'Нет сопоставимых полных данных.')}</dd></div>`;
    const change = Number.isFinite(value.dropPercent) ? value.dropPercent > 0 ? `Снижение на ${fmt(value.dropPercent,1)}%` : value.dropPercent < 0 ? `Рост на ${fmt(-value.dropPercent,1)}%` : 'Без изменения' : 'Изменение не рассчитано';
    return `<div data-available="true" data-triggered="${thresholdMatches.includes(key)}"><dt>${title}${value.month ? ` · ${escape(monthLabel(value.month))}` : ''}</dt><dd><strong>${fmt(value.value,3)} кВт·ч</strong><span>${escape(change)}</span>${thresholdMatches.includes(key) ? '<small>Порог отбора выполнен</small>' : ''}${value.reason ? `<small>${escape(value.reason)}</small>` : ''}</dd></div>`;
  }).join('')}</dl>`;
}
function evidenceHTML(evidence = {}, compact = false) {
  const electrical = evidence.electrical || [], events = evidence.events || [], limit = compact ? 2 : 4;
  const electricalDates = evidence.electricalTimestampCount ?? electrical.length;
  const monthlyRegistrations = evidence.eventRegistrationCountScope === 'participating_month_groups';
  const eventDates = evidence.eventTimestampCount ?? (monthlyRegistrations ? events.length : evidence.eventCount ?? events.length);
  const electricalHTML = electrical.slice(0,limit).map(record=>`<li><div><strong>${escape(record.title || record.code || 'Электрический признак')}</strong><time>${record.at ? escape(eventDate(record.at)) : 'Дата измерения не указана'}</time></div><p>${escape(record.detail || 'Подробности измерения отсутствуют.')}</p>${record.timestampDetailExact === false ? '<small>Описание агрегировано по нескольким измерениям; дата не устанавливает время каждого значения.</small>' : ''}${record.conditional ? '<small>Признак зависит от схемы учёта и условий измерения.</small>' : ''}${record.count != null ? `<small>Наблюдений: ${escape(record.count)}</small>` : ''}</li>`).join('');
  const eventsHTML = events.slice(0,limit).map(record=>`<li><div><strong>${escape((record.classifications || []).map(item=>item.title).filter(Boolean).join(' / ') || 'Регистрация журнала 46')}</strong><time>${record.at ? escape(eventDate(record.at)) : 'Дата регистрации не указана'}</time></div><p>${escape(record.description || 'Описание регистрации отсутствует.')}</p>${record.timestampDetailExact === false ? '<small>Описание обобщено по месячной группе; этот текст не привязан к конкретной регистрации.</small>' : ''}</li>`).join('');
  const eventCountsHTML = !monthlyRegistrations ? '' : `<p class="case-evidence-count">Участвующих месячных групп: ${escape(evidence.eventGroupCount ?? 0)} · регистраций в них: ${escape(evidence.eventCount ?? 0)}.</p><p class="event-registration-note">Полное число записей этих групп за месяц, а не число независимых вскрытий. Оно не ограничено точным временным окном измерений журнала 31.</p>`;
  return `<div class="case-evidence">${electrical.length ? `<section><h5>Журнал 31 · измерения</h5>${evidence.electricalCount != null ? `<p class="case-evidence-count">Наблюдений: ${escape(evidence.electricalCount)}.</p>` : ''}<ul>${electricalHTML}</ul>${electricalDates>Math.min(limit,electrical.length) || evidence.electricalDetailsTruncated ? `<p class="case-limit">Показано ${Math.min(limit,electrical.length)} из ${escape(electricalDates)} сохранённых записей с датами. Сводка — в Excel-отчёте; полные измерения — в исходном журнале 31.</p>` : ''}</section>` : ''}${events.length ? `<section><h5>Журнал 46 · регистрации</h5>${eventCountsHTML}<ul>${eventsHTML}</ul>${eventDates>Math.min(limit,events.length) || evidence.eventDetailsTruncated ? `<p class="case-limit">Показано ${Math.min(limit,events.length)} из ${escape(eventDates)} сохранённых фактических дат регистраций. Месячные группы — в Excel-отчёте; все исходные записи — в журнале 46.</p>` : ''}</section>` : ''}</div>`;
}
export function journalCaseDetailHTML(item, entry = item, compact = false) {
  const temporal = entry.temporalRelation || item.temporalRelation;
  const temporalText = item.scenario === 'load_zero' ? 'Нагрузка зафиксирована при измерении в месяце с нулевым полезным отпуском собственной ТУ. Мгновенная мощность не интегрировалась в месячную энергию.' : temporal === 'pre_existing' ? 'Низкий уровень потребления наблюдался до журнальных признаков. Новое снижение после них не подтверждено; связь начала спада с этими событиями не установлена.' : temporal === 'same_month' ? 'Признаки и снижение попали в один календарный месяц. Порядок изменения нагрузки внутри месяца не установлен.' : temporal === 'after' ? 'Снижение отмечено после журнального признака. Точный момент изменения внутри месяца не установлен; сверьте даты исходных записей.' : 'Временная связь с изменением потребления не установлена.';
  const season = entry.seasonalAlternative ?? item.seasonalAlternative;
  const supporting = entry.supportingMonthlyFlags || item.supportingMonthlyFlags || [];
  const peer = entry.peerContext || item.peerContext;
  const peerHTML = !peer ? '' : peer.available ? `<p class="case-peer${peer.commonDecline ? ' case-peer-common' : ''}">${escape(peer.detail || `Сопоставимых других ЛС в ТП: ${peer.eligiblePeers ?? 0}.`)}${peer.tp ? ` · ${escape(peer.tp)}` : ''}</p>` : `<p class="case-peer">Сравнение с другими ЛС ТП недоступно: ${escape(peer.reason || 'недостаточно сопоставимых данных.')}</p>`;
  const earlier = entry.preExistingDecline || item.preExistingDecline;
  const earlierHTML = !earlier ? '' : `<p class="case-preexisting">Низкий уровень до журнальных признаков: ${escape(monthLabel(earlier.month))}${Number.isFinite(earlier.value) ? ` · ${fmt(earlier.value,3)} кВт·ч` : ''}. ${earlier.newDecline && Number.isFinite(earlier.additionalDropPercent) ? `В месяце сопоставления расход дополнительно снизился на ${fmt(earlier.additionalDropPercent,1)}% относительно этого уровня.` : 'Дополнительное снижение относительно этого уровня не подтверждено.'}${earlier.reason ? ` ${escape(earlier.reason)}` : ''}</p>`;
  return `<p class="case-scope">${escape(item.consumptionScope || 'Потребление ЛС + ТУ; события и измерения одного ПУ.')}${item.point?.label ? ` · ТУ: ${escape(item.point.label)}` : ''}</p><div class="case-month-value"><strong>${escape(monthLabel(entry.month))}</strong><span>${Number.isFinite(entry.value) ? fmt(entry.value,3)+' кВт·ч' : 'Нет полного месячного объёма'}</span></div>${comparisonHTML(entry.comparisons || item.comparisons,entry.thresholdMatches || item.thresholdMatches || [])}<p class="case-temporal">${escape(temporalText)}</p>${earlierHTML}${season === true ? '<p class="case-seasonal">Сезонная альтернатива: похожий низкий расход был в том же месяце прошлого года. Сверьте режим работы и сезонную нагрузку.</p>' : ''}${peerHTML}${evidenceHTML(entry.evidence || item.evidence,compact)}${!compact && supporting.length ? `<p class="case-supporting">Месячные признаки основной модели (контекст): ${supporting.map(flag=>escape(typeof flag==='string' ? flag : [flag.code,flag.title,flag.scope].filter(Boolean).join(' · '))).join(', ')}.</p>` : ''}`;
}
// Match the actual calendar month, including its year. Never clamp an event to
// either edge of the consumption period, or merge January from different years.
export function indexChartEvents(months, events = []) {
  const slots = new Map(months.map(({ y, m }, i) => [`${y}-${String(m + 1).padStart(2, '0')}`, i]));
  const byMonth = new Map(); let outsidePeriod = 0, outsideGroups = 0;
  for (const event of events) {
    if (!event) continue;
    const kind = event.kind === 'opening' ? 'intrusion' : event.kind;
    if (!Object.hasOwn(EVENT_KINDS, kind)) continue;
    const monthly = isMonthlyEvent(event), at = monthly ? event.first : event.at;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(String(at || ''));
    if (!match) continue;
    const [, year, month, day] = match, date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) continue;
    if (monthly && event.month !== `${year}-${month}`) continue;
    const i = slots.get(`${year}-${month}`);
    if (i === undefined) { outsidePeriod += registrationCount(event); if (monthly) outsideGroups++; continue; }
    if (!byMonth.has(i)) byMonth.set(i, []);
    byMonth.get(i).push({ ...event, at, kind });
  }
  for (const list of byMonth.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.serial).localeCompare(String(b.serial)));
  return { byMonth, outsidePeriod, outsideGroups };
}
const eventDate = at => String(at || '').replace(/^(\d{4})-(\d{2})-(\d{2})T?/, '$3.$2.$1 ').trim();
// Keep the window width when browsing; zoom expands at either boundary too.
export function chartWindow({ start, end }, action, count, selected = end) {
  const length = end - start + 1;
  if (action === 'all') return { start: 0, end: count - 1 };
  let nextStart = start, nextLength = length;
  if (action === 'left' || action === 'right') nextStart += (action === 'left' ? -1 : 1) * Math.max(1, Math.round(length / 2));
  if (action === 'in' || action === 'out') {
    nextLength = Math.min(count, action === 'in' ? Math.max(3, Math.round(length / 2)) : length * 2);
    const anchor = Math.max(start, Math.min(end, selected));
    const position = length > 1 ? (anchor - start) / (length - 1) : .5;
    nextStart = anchor - Math.round(position * (nextLength - 1));
  }
  nextStart = Math.max(0, Math.min(count - nextLength, nextStart));
  return { start: nextStart, end: nextStart + nextLength - 1 };
}
export function mountChart(host, { months, values, group = null, baseline = null, shift = null, title = 'Потребление', scenario = null, events = [], cases = [] }) {
  const years = splitYears(months, values);
  const journal = indexChartEvents(months, events), hasEvents = journal.byMonth.size > 0;
  const joint = indexChartCases(months,cases), hasCases = joint.byMonth.size > 0;
  let mode = 'timeline', selectedMonth = months.at(-1)?.m ?? 0;
  let start = 0, end = months.length - 1, selected = end, smoothing = 0;
  const controls = `<div class="chart-controls" data-no-swipe><button type="button" data-zoom="in" aria-label="Сузить период">＋</button><button type="button" data-zoom="out" aria-label="Расширить период">−</button><button type="button" data-zoom="left" aria-label="Предыдущий период">←</button><button type="button" data-zoom="right" aria-label="Следующий период">→</button><button type="button" data-zoom="all">Весь период</button></div>`;
  host.innerHTML = `<div class="chart-title"><h3>${escape(title)}</h3><span>кВт·ч</span></div><div class="chart-mode" role="group" aria-label="Вид графика"><button type="button" data-chart-mode="timeline" aria-pressed="true">Весь период</button><button type="button" data-chart-mode="yearly" aria-pressed="false">По годам</button></div><div class="chart-legend timeline-legend"><span class="legend-fact">Полезный отпуск</span>${group ? '<span class="legend-group">Медиана группы</span>' : ''}${baseline != null ? '<span class="legend-base">Базовый уровень</span>' : ''}${shift != null ? '<span class="legend-shift">Изменение профиля</span>' : ''}${scenario ? '<span class="legend-scenario">Сценарий</span>' : ''}</div><div class="chart-legend year-legend" hidden></div><div class="plot" data-no-swipe></div>${controls}<div class="chart-settings"><label>Сглаживание<select data-smoothing><option value="0">Без сглаживания</option><option value="3">3 месяца</option><option value="6">6 месяцев</option></select></label><span class="chart-window"></span></div><label class="chart-scrubber"><span class="sr-only">Месяц на графике</span><input class="month-scrubber" type="range" min="0" max="${end}" value="${end}" step="1"></label><div class="chart-reading" aria-live="polite"></div><p class="chart-note">Нажмите на график, чтобы увидеть месяц. Пропуски — нет полных данных; точки у нуля — ≤ 3 кВт·ч. Сглаживание и масштаб меняют только график.</p>`;
  host.querySelector('.chart-reading').insertAdjacentHTML('afterend', `<div class="chart-event-legend" ${hasEvents ? '' : 'hidden'} aria-label="Обозначения событий">${Object.entries(EVENT_KINDS).filter(([kind]) => [...journal.byMonth.values()].some(list => list.some(event => event.kind === kind))).map(([kind, label]) => `<span data-event-kind="${kind}">${label}</span>`).join('')}${[...journal.byMonth.values()].some(list=>list.some(isMonthlyEvent)) ? '<small>Одна метка 46 — одна месячная группа ПУ и категорий; число у метки — регистрации журнала.</small>' : ''}</div><section class="chart-event-details" aria-live="polite" hidden></section>${journal.outsidePeriod ? `<p class="chart-event-outside">Записей журналов вне периода потребления: ${journal.outsidePeriod}${journal.outsideGroups ? ` · месячных групп 46: ${journal.outsideGroups}` : ''}. На этот график они не переносятся.</p>` : ''}`);
  host.querySelector('.chart-event-legend').insertAdjacentHTML('afterend', `<div class="chart-case-legend" ${hasCases ? '' : 'hidden'}><span>Сопоставление журналов и ПО</span><small>Выделен календарный месяц сопоставления; месячные объёмы исходные.</small></div><section class="chart-case-details" aria-live="polite" hidden></section>`);
  const smooth = arr => !smoothing ? arr : arr.map((x, i) => {
    if (x == null) return null;
    const part = arr.slice(Math.max(0, i - Math.floor((smoothing - 1) / 2)), i + Math.ceil((smoothing - 1) / 2) + 1).filter(v => v != null);
    return part.reduce((s,v) => s+v,0) / part.length;
  });
  function eventDetails(indices) {
    const details = host.querySelector('.chart-event-details'), list = indices.flatMap(i => journal.byMonth.get(i) || []);
    details.hidden = !list.length;
    if (!list.length) { details.replaceChildren(); return; }
    const monthly = list.filter(isMonthlyEvent), electrical = list.filter(event=>event.kind==='electrical');
    const counts = monthly.length ? `<p class="chart-event-counts">На графике · журнал 46: ${monthly.length} месячных групп · ${monthly.reduce((sum,event)=>sum+registrationCount(event),0)} регистраций${electrical.length ? `; журнал 31: ${electrical.length} сохранённых отметок измерений` : ''}.</p>` : '';
    details.innerHTML = `<h4>Журнальные отметки в выбранном месяце <span>${list.length}</span></h4>${counts}<ul>${list.slice(0, MAX_MONTH_EVENTS).map(event => `<li data-event-kind="${event.kind}"><div>${!isMonthlyEvent(event) ? `<time>${escape(eventDate(event.at))}</time>` : ''}<span>ПУ ${escape(event.serial)}</span></div><strong>${escape(event.title || EVENT_KINDS[event.kind])}</strong>${isMonthlyEvent(event) ? monthlyEventHTML(event) : `<p>${escape(event.description)}</p>`}</li>`).join('')}</ul>${list.length > MAX_MONTH_EVENTS ? `<p class="chart-event-limit">Показаны первые ${MAX_MONTH_EVENTS} из ${list.length} журнальных отметок. Месячные группы 46 и сводка параметров 31 доступны в Excel-отчёте; все исходные регистрации и измерения — в соответствующих журналах.</p>` : ''}`;
  }
  function caseDetails(indices) {
    const details = host.querySelector('.chart-case-details'), list = indices.flatMap(i=>joint.byMonth.get(i) || []);
    details.hidden = !list.length;
    if (!list.length) { details.replaceChildren(); return; }
    details.innerHTML = `<h4>Сопоставления в выбранном месяце <span>${list.length}</span></h4>${list.slice(0,MAX_MONTH_CASES).map(({item,entry})=>`<article class="journal-case chart-journal-case" data-priority="${item.priority === 'high' ? 'high' : 'check'}"><div class="case-heading"><h4>${escape(journalCaseTitle(item))}</h4><span class="case-meter">ПУ ${escape(item.serial)}</span></div>${journalCaseDetailHTML(item,entry,true)}</article>`).join('')}${list.length>MAX_MONTH_CASES ? `<p class="case-limit">Показано ${MAX_MONTH_CASES} из ${list.length} сопоставлений в этом месяце. Полный состав — в Excel-отчёте.</p>` : ''}`;
  }
  function caseMarker(i,x,y,yearly=false) {
    const list = joint.byMonth.get(i); if (!list?.length) return '';
    const priority = list.some(({item})=>item.priority==='high') ? 'high' : 'check', label = `${ymLabel(months[i])}: сопоставление журналов и ПО, сопоставлений ${list.length}`;
    return `<g class="plot-case" data-case-priority="${priority}" ${yearly ? `data-calendar-month="${months[i].m}" data-case-year="${months[i].y}"` : `data-month="${i}"`} tabindex="0" role="button" aria-label="${escape(label)}"><title>${escape(label)}</title><rect class="plot-event-target" x="${x-10}" y="${y-9}" width="20" height="18"/><path d="M${x},${y-6}l6,6l-6,6l-6,-6Z"/>${list.length>1 ? `<text x="${x}" y="${y+2}">${list.length>9 ? '9+' : list.length}</text>` : ''}</g>`;
  }
  function markers(i, x, y, yearly = false) {
    const list = journal.byMonth.get(i); if (!list?.length) return '';
    const monthly = list.filter(isMonthlyEvent), legacy = list.filter(event=>!isMonthlyEvent(event));
    const items = [...monthly.map(event=>({kind:event.kind,count:registrationCount(event),event})),...Object.keys(EVENT_KINDS).filter(kind=>legacy.some(event=>event.kind===kind)).map(kind=>({kind,count:legacy.filter(event=>event.kind===kind).length}))];
    return items.map(({kind,count,event}, k) => {
      const width=Math.min(60,(items.length-1)*15), plotWidth=Math.max(280,host.querySelector('.plot').clientWidth || host.clientWidth || 360);
      const cx = monthly.length ? Math.max(56,Math.min(plotWidth-24,x+(items.length>1 ? (k/(items.length-1)-.5)*width : 0))) : x+(k-(items.length-1)/2)*15;
      const label = event ? monthlyEventLabel(event) : `${ymLabel(months[i])}: ${EVENT_KINDS[kind]}, ${kind==='electrical' ? 'отметок измерений' : 'записей'} ${count}`;
      const examples = event ? (event.examples || []).slice(0,3).map(example=>`${eventDate(example.at)}: ${String(example.description || '').slice(0,140)}`).join('; ') : '';
      const shape = kind === 'intrusion' ? `<path d="M${cx-5},${y-8}h12l-3,5l3,5h-12Z"/><path class="plot-event-pole" d="M${cx-5},${y-8}v20"/>` : kind === 'magnetic' ? `<circle cx="${cx}" cy="${y}" r="6"/>` : `<rect x="${cx-5}" y="${y-5}" width="10" height="10" rx="1"/>`;
      return `<g class="plot-event" data-event-kind="${kind}" ${event ? 'data-monthly-group="true"' : ''} ${yearly ? `data-calendar-month="${months[i].m}" data-event-year="${months[i].y}"` : `data-month="${i}"`} tabindex="0" role="button" aria-label="${escape(label)}"><title>${escape(label)}${examples ? ` Фактические примеры: ${escape(examples)}` : ''}</title><rect class="plot-event-target" x="${cx-9}" y="${y-10}" width="18" height="20"/>${shape}${count > 1 ? `<text x="${cx}" y="${y+22}">${event && count>999 ? '999+' : count}</text>` : ''}</g>`;
    }).join('');
  }
  function reading() {
    host.querySelector('.chart-reading').innerHTML = `<strong>${escape(ymLabel(months[selected]))}</strong><span>${values[selected] == null ? 'Нет полных данных' : fmt(values[selected], 3) + ' кВт·ч'}${group?.[selected] != null ? `<small>Группа: ${fmt(group[selected], 3)} кВт·ч</small>` : ''}${scenario?.[selected] != null ? `<small>Сценарий: ${fmt(scenario[selected], 3)} кВт·ч</small>` : ''}</span>`;
    host.querySelector('.month-scrubber').value = selected;
    eventDetails([selected]);
    caseDetails([selected]);
  }
  function drawYearly() {
    const W = Math.max(280, host.querySelector('.plot').clientWidth || 360), H = 248, L = 47, R = 14, T = 16, B = 40;
    const displayed = years.map(series => ({ ...series, plotted: smooth(series.values) }));
    const known = displayed.flatMap(series => series.plotted).filter(v => v != null && Number.isFinite(v));
    const hi = Math.max(10, ...known) * 1.12, lo = Math.min(0, ...known) * 1.12;
    const X = m => L + m * (W-L-R)/11, Y = v => T + (H-T-B)*(hi-v)/(hi-lo);
    let grid = '', labels = '', lines = '', hits = '', eventMarks = '', caseMarks = '';
    for (let k = 0; k < 5; k++) {
      const v = lo+(hi-lo)*k/4, y = Y(v);
      grid += `<line class="plot-grid" x1="${L}" x2="${W-R}" y1="${y}" y2="${y}"/><text class="plot-y" x="${L-7}" y="${y+4}">${escape(Math.abs(v)>=10000 ? fmt(v/1000,1)+'к' : fmt(v))}</text>`;
    }
    for (const series of displayed) {
      const d = yearPath(series.plotted, X, Y); let dots = '';
      series.plotted.forEach((v, m) => {
        if (v == null) return;
        dots += `<circle class="plot-year-dot${m === selectedMonth ? ' is-selected' : ''}" cx="${X(m)}" cy="${Y(v)}" r="${m === selectedMonth ? 3.5 : 2.5}"/>`;
      });
      lines += `<g class="plot-year" data-year="${series.year}" data-current-year="${series.current}" data-year-color="${series.color}"><path d="${d}"/>${dots}</g>`;
    }
    for (const [i] of journal.byMonth) {
      const year = displayed.find(series => series.year === months[i].y), value = year?.plotted[months[i].m];
      eventMarks += markers(i, X(months[i].m), value == null ? T + 10 : Math.max(T + 6, Math.min(H-B-20, Y(value)-12)), true);
    }
    for (const [i] of joint.byMonth) {
      const year = displayed.find(series=>series.year===months[i].y), value = year?.plotted[months[i].m];
      caseMarks += caseMarker(i,X(months[i].m),value==null ? T-6 : Math.max(T+8,Math.min(H-B-8,Y(value)+12)),true);
    }
    for (let m = 0; m < 12; m++) {
      const x = X(m), half = (W-L-R)/22, left = Math.max(L,x-half), right = Math.min(W-R,x+half);
      labels += `<text class="plot-x plot-month" text-anchor="middle" x="${x}" y="${H-12}">${MONTH_LABELS[m]}</text>`;
      hits += `<rect class="plot-hit" data-calendar-month="${m}" x="${left}" y="0" width="${right-left}" height="${H}" tabindex="0" role="button" aria-label="${MONTH_LABELS[m]}: сравнить годы"/>`;
    }
    host.querySelector('.plot').innerHTML = `<svg role="img" aria-label="${escape(title)}: сравнение по годам, январь — декабрь" viewBox="0 0 ${W} ${H}">${grid}${labels}<line class="plot-cursor" x1="${X(selectedMonth)}" x2="${X(selectedMonth)}" y1="${T}" y2="${H-B}"/>${lines}${hits}${eventMarks}${caseMarks}</svg>`;
    host.querySelector('.year-legend').innerHTML = years.map(s => `<span data-year-color="${s.color}">${s.year}${s.current ? ' · текущий' : ''}</span>`).join('');
    host.querySelector('.chart-window').textContent = `${ymLabel(months[0])} — ${ymLabel(months.at(-1))}`;
    host.querySelector('.chart-reading').innerHTML = `<strong>${MONTH_LABELS[selectedMonth]} · по годам</strong><div class="year-readings">${years.map(s => `<div data-year-color="${s.color}"><strong>${s.year}</strong><span>${!s.included[selectedMonth] ? 'Вне периода отчёта' : s.values[selectedMonth] == null ? 'Нет полных данных' : fmt(s.values[selectedMonth],3)+' кВт·ч'}</span></div>`).join('')}</div>`;
    host.querySelectorAll('[data-year-color]').forEach(el => el.style.setProperty('--year-color', el.dataset.yearColor));
    eventDetails(months.flatMap(({ m }, i) => m === selectedMonth ? [i] : []));
    caseDetails(months.flatMap(({m},i)=>m===selectedMonth ? [i] : []));
    const scrub = host.querySelector('.month-scrubber'); scrub.min = 0; scrub.max = 11; scrub.value = selectedMonth;
  }
  function draw() {
    const yearly = mode === 'yearly';
    host.querySelectorAll('[data-chart-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.chartMode === mode)));
    host.querySelector('.chart-controls').hidden = yearly;
    host.querySelector('.timeline-legend').hidden = yearly;
    host.querySelector('.year-legend').hidden = !yearly;
    host.querySelector('.chart-reading').classList.toggle('year-reading', yearly);
    host.querySelector('.chart-note').textContent = yearly
      ? 'Каждый цвет — отдельный год. Нажмите на месяц для сравнения. Пропуски и месяцы вне периода отчёта не считаются нулём. Линии проходят через месячные точки. Сглаживание применяется только при выборе в списке; значения под графиком — исходные.'
      : 'Нажмите на график, чтобы увидеть месяц. Пропуски — нет полных данных; точки у нуля — ≤ 3 кВт·ч. Сглаживание и масштаб меняют только график.';
    if (yearly) { drawYearly(); return; }
    const W = Math.max(280, host.clientWidth || 360), H = 248, L = 47, R = 14, T = 16, B = 40, n = end - start + 1;
    const fact = smooth(values), peers = group ? smooth(group) : null, scn = scenario ? smooth(scenario) : null;
    const known = [...fact.slice(start, end + 1), ...(peers?.slice(start, end + 1) || []), ...(scn?.slice(start,end+1) || []), baseline].filter(v => v != null && Number.isFinite(v));
    const hi = Math.max(10, ...known) * 1.12, lo = Math.min(0, ...known) * 1.12;
    const X = i => L + (i - start) * (W - L - R) / Math.max(1, n - 1), Y = v => T + (H-T-B) * (hi - v) / (hi - lo);
    const path = arr => { let d = '', pen = false; for (let i = start; i <= end; i++) { if (arr[i] == null) { pen = false; continue; } d += (pen?'L':'M') + X(i).toFixed(1) + ',' + Y(arr[i]).toFixed(1); pen = true; } return d; };
    let grid = '', labels = '', hits = '', eventMarks = '', caseBands = '', caseMarks = '';
    for (let k = 0; k < 5; k++) { const v = lo + (hi-lo)*k/4, y = Y(v); grid += `<line class="plot-grid" x1="${L}" x2="${W-R}" y1="${y}" y2="${y}"/><text class="plot-y" x="${L-7}" y="${y+4}">${escape(Math.abs(v) >= 10000 ? fmt(v/1000,1)+'к' : fmt(v))}</text>`; }
    const step = Math.max(1, Math.ceil(n / (W < 450 ? 4 : 7)));
    for (let i = start; i <= end; i++) {
      const x = X(i), half = (W-L-R)/Math.max(1,n-1)/2;
      if (i === end || (i-start)%step === 0 && end-i >= step) labels += `<text class="plot-x" text-anchor="${i===start?'start':i===end?'end':'middle'}" x="${x}" y="${H-12}">${escape(ymLabel(months[i]))}</text>`;
      if (values[i] == null) hits += `<rect class="plot-missing" x="${Math.max(L,x-half)}" y="${T}" width="${Math.min(W-R,x+half)-Math.max(L,x-half)}" height="${H-T-B}"/>`;
      if (fact[i] != null) hits += `<circle class="${values[i] <= 3 ? 'plot-zero' : 'plot-dot'}" cx="${x}" cy="${Y(fact[i])}" r="${n>80?1.5:3}"/>`;
      hits += `<rect class="plot-hit" data-month="${i}" x="${Math.max(0,x-half)}" y="0" width="${Math.max(12,half*2)}" height="${H}" tabindex="0" role="button" aria-label="${escape(ymLabel(months[i]) + ': ' + (values[i] == null ? 'нет данных' : fmt(values[i],3)+' кВт·ч'))}"/>`;
      eventMarks += markers(i, x, fact[i] == null ? T + 10 : Math.max(T + 6, Math.min(H-B-20, Y(fact[i])-12)));
      if(joint.byMonth.has(i)) {
        const left=Math.max(L,x-half),right=Math.min(W-R,x+half),priority=joint.byMonth.get(i).some(({item})=>item.priority==='high') ? 'high' : 'check';
        caseBands += `<rect class="plot-case-band" data-case-priority="${priority}" x="${left}" y="${T}" width="${right-left}" height="${H-T-B}"/>`;
        caseMarks += caseMarker(i,x,T-6);
      }
    }
    host.querySelector('.plot').innerHTML = `<svg role="img" aria-label="${escape(title)}: ${escape(ymLabel(months[start]))} — ${escape(ymLabel(months[end]))}" viewBox="0 0 ${W} ${H}">${caseBands}${grid}${labels}${baseline != null ? `<path class="plot-base" d="M${L},${Y(baseline)}H${W-R}"/>` : ''}${peers ? `<path class="plot-group" d="${path(peers)}"/>` : ''}${scn ? `<path class="plot-scenario" d="${path(scn)}"/>` : ''}<path class="plot-fact" d="${path(fact)}"/>${shift != null && shift >= start && shift <= end ? `<path class="plot-shift" d="M${X(shift)},${T}V${H-B}"/>` : ''}<line class="plot-cursor" x1="${X(selected)}" x2="${X(selected)}" y1="${T}" y2="${H-B}"/>${hits}${eventMarks}${caseMarks}</svg>`;
    host.querySelector('.chart-window').textContent = `${ymLabel(months[start])} — ${ymLabel(months[end])}`;
    const scrub = host.querySelector('.month-scrubber'); scrub.min = start; scrub.max = end;
    for (const [action, disabled] of Object.entries({ left: start === 0, right: end === months.length - 1, in: end - start < 3, out: start === 0 && end === months.length - 1 })) host.querySelector(`[data-zoom="${action}"]`).disabled = disabled;
    reading();
  }
  host.addEventListener('click', e => {
    const toggle = e.target.closest('[data-chart-mode]');
    if (toggle) { mode = toggle.dataset.chartMode; draw(); return; }
    const calendar = e.target.closest('[data-calendar-month]');
    if (calendar) { selectedMonth = Number(calendar.dataset.calendarMonth); draw(); return; }
    const point = e.target.closest('[data-month]'); if (point) { selected = Number(point.dataset.month); draw(); return; }
    const action = e.target.closest('[data-zoom]')?.dataset.zoom; if (!action) return;
    ({ start, end } = chartWindow({ start, end }, action, months.length, selected));
    selected=Math.max(start,Math.min(end,selected)); draw();
  });
  host.addEventListener('keydown', e => {
    const target = e.target.closest('[data-month], [data-calendar-month]');
    if (target && ['Enter',' '].includes(e.key)) {
      e.preventDefault();
      if (mode === 'yearly') selectedMonth = Number(target.dataset.calendarMonth); else selected = Number(target.dataset.month);
      const selector = mode === 'yearly' ? `[data-calendar-month="${selectedMonth}"]` : `[data-month="${selected}"]`;
      draw(); host.querySelector(selector)?.focus();
    }
  });
  host.querySelector('[data-smoothing]').addEventListener('change', e => { smoothing = Number(e.target.value); draw(); });
  host.querySelector('.month-scrubber').addEventListener('input', e => { if (mode === 'yearly') selectedMonth=Number(e.target.value); else selected=Number(e.target.value); draw(); });
  draw();
}
