import { pointKey, tpKey } from './monthly.js';

const calendar = ({ y, m }) => y * 12 + m;
const positive = value => Number.isFinite(value) && value > 0;
const strictAt = (rows, index) => {
  if (index == null) return null;
  let total = 0;
  for (const row of rows) {
    const value = row.values[index];
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return rows.length ? total : null;
};

// Compare other accounts in the actual TP, never unrelated RES consumers.
// This supplies an alternative explanation; empirical detector scores stay intact.
export function createJournalPeerContext(model) {
  const indexes = new Map(model.months.map((month, index) => [calendar(month), index]));
  const groups = new Map(), cache = new Map();
  for (const row of model.rows) {
    const key = tpKey(row.tp);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { name: row.tp, accounts: new Map() });
    const accounts = groups.get(key).accounts;
    if (!accounts.has(row.accountKey)) accounts.set(row.accountKey, []);
    accounts.get(row.accountKey).push(row);
  }
  function observation(rows, month, comparison) {
    const value = strictAt(rows, indexes.get(month));
    if (value == null) return null;
    let baseline;
    if (comparison === 'median3') {
      const previous = [3, 2, 1].map(offset => strictAt(rows, indexes.get(month - offset)));
      if (!previous.every(positive)) return null;
      baseline = previous.sort((a, b) => a - b)[1];
    } else baseline = strictAt(rows, indexes.get(month - (comparison === 'yearAgo' ? 12 : 1)));
    if (!positive(baseline) || baseline < 30) return null;
    return { declined: value <= baseline * (comparison === 'median3' ? 0.5 : 0.7) };
  }
  function context(item, rows) {
    const missing = reason => ({ available: false, reason, commonDecline: false });
    if (!item.month) return missing('Для сочетания журналов без месяца снижения сравнение с соседями не выполнялось.');
    const match = /^(\d{4})-(\d{2})$/.exec(item.month);
    if (!match) return missing('Не определён календарный месяц наблюдения.');
    const selected = rows.filter(row => pointKey(row) === item.point?.key);
    const keys = new Set(selected.map(row => tpKey(row.tp)));
    if (!selected.length || keys.size !== 1 || keys.has('')) return missing('Для этой ТУ не определена единственная ТП.');
    const key = [...keys][0], group = groups.get(key);
    if (!group) return missing('В потреблении нет сопоставимого контура ТП.');
    const comparisons = item.comparisons || {};
    const comparison = ['previous', 'yearAgo', 'median3'].find(name => {
      const candidate = comparisons[name];
      return candidate?.available && candidate.value >= 30 && (candidate.exactDropPercent ?? candidate.dropPercent) >= (name === 'median3' ? 50 : 30);
    });
    if (!comparison) return missing('Нет пригодной базы снижения для сравнения с соседями.');
    const month = Number(match[1]) * 12 + Number(match[2]) - 1;
    const cacheKey = JSON.stringify([key, month, comparison]);
    let summary = cache.get(cacheKey);
    if (!summary) {
      summary = { eligible: 0, declined: 0 };
      for (const peerRows of group.accounts.values()) {
        const observed = observation(peerRows, month, comparison);
        if (observed) { summary.eligible++; if (observed.declined) summary.declined++; }
      }
      // Bounded cache stores two counts, not second copies of monthly series.
      if (cache.size >= 2048) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, summary);
    }
    const ownRows = group.accounts.get(item.account);
    const own = ownRows ? observation(ownRows, month, comparison) : null;
    const eligiblePeers = summary.eligible - (own ? 1 : 0);
    const declinedPeers = summary.declined - (own?.declined ? 1 : 0);
    if (eligiblePeers < 6) return { ...missing('Меньше шести других ЛС с полными сопоставимыми объёмами; общий спад ТП не оценивался.'), tp: group.name, comparison, eligiblePeers, declinedPeers };
    const sharePercent = Math.round(declinedPeers / eligiblePeers * 100);
    const commonDecline = declinedPeers / eligiblePeers >= 0.6;
    const base = comparison === 'yearAgo' ? 'тому же месяцу прошлого года' : comparison === 'median3' ? 'трёхмесячной базе' : 'предыдущему месяцу';
    const detail = `${group.name}: у ${declinedPeers} из ${eligiblePeers} других ЛС (${sharePercent}%) потребление снизилось минимум на ${comparison === 'median3' ? 50 : 30}% к ${base}. ${commonDecline ? 'Спад затронул большинство сопоставимых соседей; проверить общее отключение и изменение режима ТП.' : 'Массовое снижение по этому правилу не выявлено.'} Это контекст, а не подтверждение причины.`;
    return { available: true, tp: group.name, comparison, eligiblePeers, declinedPeers, sharePercent, commonDecline, detail };
  }
  return function annotate(item, rows) {
    if (item.months?.length) {
      for (const period of item.months) period.peerContext = context({ ...item, ...period }, rows);
      item.peerContext = item.months[0].peerContext;
    } else item.peerContext = context(item, rows);
    return item;
  };
}
