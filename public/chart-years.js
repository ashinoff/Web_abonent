const COLORS = ['#b9797e', '#689986', '#648fb3', '#b59b70', '#9783b2', '#60969d', '#af829c', '#8d9870'];
export const MONTH_LABELS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

// Calendar slots keep partial years and missing readings distinct from zero.
export function splitYears(months, values) {
  const years = new Map();
  months.forEach(({ y, m }, i) => {
    if (!years.has(y)) years.set(y, { year: y, values: Array(12).fill(null), included: Array(12).fill(false) });
    const series = years.get(y);
    series.values[m] = Number.isFinite(values[i]) ? values[i] : null;
    series.included[m] = true;
  });
  return [...years.values()].sort((a, b) => a.year - b.year).map((series, i) => ({
    ...series, color: COLORS[i] || `hsl(${Math.round(i * 137.508) % 360} 30% 55%)`,
  }));
}

// Shape-preserving cubic interpolation passes through the monthly readings.
// It adds no extrema, never bridges a missing month and never fills an absent year.
export function yearPath(values, X, Y) {
  const segments = []; let points = [];
  const flush = () => { if (points.length) segments.push(points); points = []; };
  values.forEach((v, m) => { if (v == null || !Number.isFinite(v)) flush(); else points.push([X(m), Y(v)]); });
  flush();
  const f = v => v.toFixed(2);
  return segments.map(p => {
    let d = `M${f(p[0][0])},${f(p[0][1])}`;
    const slopes = p.slice(1).map((next, i) => (next[1] - p[i][1]) / (next[0] - p[i][0]));
    const tangents = p.map((_, i) => {
      if (i === 0) return slopes[0] || 0;
      if (i === p.length - 1) return slopes[i - 1] || 0;
      const a = slopes[i - 1], b = slopes[i];
      return a * b <= 0 ? 0 : 2 * a * b / (a + b);
    });
    for (let i = 1; i < p.length; i++) {
      const [x0, y0] = p[i - 1], [x1, y1] = p[i], third = (x1 - x0) / 3;
      d += `C${f(x0 + third)},${f(y0 + tangents[i - 1] * third)} ${f(x1 - third)},${f(y1 - tangents[i] * third)} ${f(x1)},${f(y1)}`;
    }
    return d;
  }).join('');
}
