import { fmt, ymLabel } from './analysis-engine.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountChart(host, { months, values, group = null, baseline = null, shift = null, title = 'Потребление', scenario = null }) {
  let start = 0, end = months.length - 1, selected = end, smoothing = 0;
  const controls = `<div class="chart-controls"><button type="button" data-zoom="in" aria-label="Сузить период">＋</button><button type="button" data-zoom="out" aria-label="Расширить период">−</button><button type="button" data-zoom="left" aria-label="Предыдущий период">←</button><button type="button" data-zoom="right" aria-label="Следующий период">→</button><button type="button" data-zoom="all">Весь период</button></div>`;
  host.innerHTML = `<div class="chart-title"><h3>${escape(title)}</h3><span>кВт·ч</span></div><div class="chart-legend"><span class="legend-fact">Полезный отпуск</span>${group ? '<span class="legend-group">Медиана группы</span>' : ''}${baseline != null ? '<span class="legend-base">Базовый уровень</span>' : ''}${shift != null ? '<span class="legend-shift">Изменение профиля</span>' : ''}${scenario ? '<span class="legend-scenario">Сценарий</span>' : ''}</div><div class="plot" data-no-swipe></div>${controls}<div class="chart-settings"><label>Сглаживание<select data-smoothing><option value="0">Без сглаживания</option><option value="3">3 месяца</option><option value="6">6 месяцев</option></select></label><span class="chart-window"></span></div><label class="chart-scrubber"><span class="sr-only">Месяц на графике</span><input class="month-scrubber" type="range" min="0" max="${end}" value="${end}" step="1"></label><div class="chart-reading" aria-live="polite"></div><p class="chart-note">Нажмите на график, чтобы увидеть месяц. Пропуски — нет полных данных; точки у нуля — ≤ 3 кВт·ч. Сглаживание и масштаб меняют только график.</p>`;
  const smooth = arr => !smoothing ? arr : arr.map((x, i) => {
    if (x == null) return null;
    const part = arr.slice(Math.max(0, i - Math.floor((smoothing - 1) / 2)), i + Math.ceil((smoothing - 1) / 2) + 1).filter(v => v != null);
    return part.reduce((s,v) => s+v,0) / part.length;
  });
  function reading() {
    host.querySelector('.chart-reading').innerHTML = `<strong>${escape(ymLabel(months[selected]))}</strong><span>${values[selected] == null ? 'Нет полных данных' : fmt(values[selected], 3) + ' кВт·ч'}${group?.[selected] != null ? `<small>Группа: ${fmt(group[selected], 3)} кВт·ч</small>` : ''}${scenario?.[selected] != null ? `<small>Сценарий: ${fmt(scenario[selected], 3)} кВт·ч</small>` : ''}</span>`;
    host.querySelector('.month-scrubber').value = selected;
  }
  function draw() {
    const W = Math.max(280, host.clientWidth || 360), H = 248, L = 47, R = 14, T = 16, B = 40, n = end - start + 1;
    const fact = smooth(values), peers = group ? smooth(group) : null, scn = scenario ? smooth(scenario) : null;
    const known = [...fact.slice(start, end + 1), ...(peers?.slice(start, end + 1) || []), ...(scn?.slice(start,end+1) || []), baseline].filter(v => v != null && Number.isFinite(v));
    const hi = Math.max(10, ...known) * 1.12, lo = Math.min(0, ...known) * 1.12;
    const X = i => L + (i - start) * (W - L - R) / Math.max(1, n - 1), Y = v => T + (H-T-B) * (hi - v) / (hi - lo);
    const path = arr => { let d = '', pen = false; for (let i = start; i <= end; i++) { if (arr[i] == null) { pen = false; continue; } d += (pen?'L':'M') + X(i).toFixed(1) + ',' + Y(arr[i]).toFixed(1); pen = true; } return d; };
    let grid = '', labels = '', hits = '';
    for (let k = 0; k < 5; k++) { const v = lo + (hi-lo)*k/4, y = Y(v); grid += `<line class="plot-grid" x1="${L}" x2="${W-R}" y1="${y}" y2="${y}"/><text class="plot-y" x="${L-7}" y="${y+4}">${escape(Math.abs(v) >= 10000 ? fmt(v/1000,1)+'к' : fmt(v))}</text>`; }
    const step = Math.max(1, Math.ceil(n / (W < 450 ? 4 : 7)));
    for (let i = start; i <= end; i++) {
      const x = X(i), half = (W-L-R)/Math.max(1,n-1)/2;
      if (i === end || (i-start)%step === 0 && end-i >= step) labels += `<text class="plot-x" text-anchor="${i===start?'start':i===end?'end':'middle'}" x="${x}" y="${H-12}">${escape(ymLabel(months[i]))}</text>`;
      if (values[i] == null) hits += `<rect class="plot-missing" x="${Math.max(L,x-half)}" y="${T}" width="${Math.min(W-R,x+half)-Math.max(L,x-half)}" height="${H-T-B}"/>`;
      if (fact[i] != null) hits += `<circle class="${values[i] <= 3 ? 'plot-zero' : 'plot-dot'}" cx="${x}" cy="${Y(fact[i])}" r="${n>80?1.5:3}"/>`;
      hits += `<rect class="plot-hit" data-month="${i}" x="${Math.max(0,x-half)}" y="0" width="${Math.max(12,half*2)}" height="${H}" tabindex="0" role="button" aria-label="${escape(ymLabel(months[i]) + ': ' + (values[i] == null ? 'нет данных' : fmt(values[i],3)+' кВт·ч'))}"/>`;
    }
    host.querySelector('.plot').innerHTML = `<svg role="img" aria-label="${escape(title)}: ${escape(ymLabel(months[start]))} — ${escape(ymLabel(months[end]))}" viewBox="0 0 ${W} ${H}">${grid}${labels}${baseline != null ? `<path class="plot-base" d="M${L},${Y(baseline)}H${W-R}"/>` : ''}${peers ? `<path class="plot-group" d="${path(peers)}"/>` : ''}${scn ? `<path class="plot-scenario" d="${path(scn)}"/>` : ''}<path class="plot-fact" d="${path(fact)}"/>${shift != null && shift >= start && shift <= end ? `<path class="plot-shift" d="M${X(shift)},${T}V${H-B}"/>` : ''}<line class="plot-cursor" x1="${X(selected)}" x2="${X(selected)}" y1="${T}" y2="${H-B}"/>${hits}</svg>`;
    host.querySelector('.chart-window').textContent = `${ymLabel(months[start])} — ${ymLabel(months[end])}`;
    const scrub = host.querySelector('.month-scrubber'); scrub.min = start; scrub.max = end;
    reading();
  }
  host.addEventListener('click', e => {
    const point = e.target.closest('[data-month]'); if (point) { selected = Number(point.dataset.month); draw(); return; }
    const action = e.target.closest('[data-zoom]')?.dataset.zoom; if (!action) return;
    const n = months.length, len = end-start+1, shiftBy = Math.max(1,Math.round(len/2));
    if (action === 'all') { start=0; end=n-1; }
    if (action === 'in') start = Math.max(0,end-Math.max(3,Math.round(len/2))+1);
    if (action === 'out') start = Math.max(0,end-len*2+1);
    if (action === 'left') { start=Math.max(0,start-shiftBy); end=Math.min(n-1,start+len-1); }
    if (action === 'right') { end=Math.min(n-1,end+shiftBy); start=Math.max(0,end-len+1); }
    selected=Math.max(start,Math.min(end,selected)); draw();
  });
  host.addEventListener('keydown', e => { const target = e.target.closest('[data-month]'); if (target && ['Enter',' '].includes(e.key)) { e.preventDefault(); selected = Number(target.dataset.month); draw(); } });
  host.querySelector('[data-smoothing]').addEventListener('change', e => { smoothing = Number(e.target.value); draw(); });
  host.querySelector('.month-scrubber').addEventListener('input', e => { selected=Number(e.target.value); draw(); });
  draw();
}
