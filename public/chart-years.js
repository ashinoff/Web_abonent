const COLORS = ['#c34c54', '#328262', '#3979bd', '#b77b21', '#8b62b6', '#25888e', '#b25e90', '#697846'];
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
    ...series, color: COLORS[i] || `hsl(${Math.round(i * 137.508) % 360} 48% 42%)`,
  }));
}
