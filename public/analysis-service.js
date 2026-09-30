import { analyze, setTune, setZoneMode, setBoosts, setAlgOff } from './analysis-engine.js';
import { normalizeSettings } from './analysis-settings.js';
import { idKey } from './core.js';
import { numeric, tpKey, strictSum } from './monthly.js';

export function createAnalysisService(model, records = []) {
  const byAccount = new Map();
  for (const record of records) {
    const key = idKey(record.fields.account); if (!key) continue;
    if (!byAccount.has(key)) byAccount.set(key, []); byAccount.get(key).push(record);
  }
  const registryFor = rows => {
    const keys = new Set(rows.flatMap(r => [r.accountKey, idKey(r.alias)]).filter(k => k && model.aliases.get(k)?.size === 1));
    return [...new Set([...keys].flatMap(k => byAccount.get(k) || []))];
  };
  function meter(rows, key) {
    const account = rows[0].account, knownTPs = [...new Map(rows.filter(r => r.tp).map(r => [tpKey(r.tp), r.tp])).values()];
    const registry = registryFor(rows), points = new Set(rows.map(r => r.point).filter(Boolean));
    // Power only belongs to this volume when every reported point is matched.
    const pointPowers = new Map(); let power = null;
    for (const r of registry) {
      const point = String(r.fields.point || r.fields.pointNumber || '');
      if (!point || !points.has(point)) continue;
      const p = numeric(r.fields.power); if (p != null && p > 0) {
        if (!pointPowers.has(point)) pointPowers.set(point, new Set()); pointPowers.get(point).add(p);
      }
    }
    if (points.size && rows.every(r => r.point) && [...points].every(p => pointPowers.get(p)?.size === 1)) power = [...points].reduce((s, p) => s + [...pointPowers.get(p)][0], 0);
    const name = rows[0].name || registry[0]?.fields.name || 'Потребитель';
    // JS \b is ASCII-only: explicit Cyrillic boundary below.
    const kind = /^(ооо|ао|пао|оао|зао|ип|тсн|тсж|снт|муп|гуп|фгуп|нко)(?:\s|[«"'])/i.test(name) ? 'ul' : /^(гражданин|гражданка|физическое лицо)(?:\s|$)/i.test(name) ? 'fl' : null;
    const usedMeters = registry.filter(r => rows.some(row => row.point && row.point === (r.fields.point || r.fields.pointNumber))).map(r => idKey(r.fields.meter)).filter(Boolean);
    return { id: key, account, name, tp: knownTPs.length === 1 ? 'tp:' + tpKey(knownTPs[0]) : 'all:multi', tpNames: knownTPs, values: strictSum(rows, model.months.length), power, ctype: kind, voltage: null, dup: new Set(usedMeters).size < usedMeters.length, pointCount: points.size, rowCount: rows.length, sources: rows.map(r => r.source), incomplete: model.months.filter((_, i) => rows.some(r => r.values[i] == null)).length, negative: rows.some(r => r.values.some(v => v != null && v < 0)) };
  }
  const globalMeters = [...model.accounts].map(([key, rows]) => meter(rows, key));
  const tpRows = new Map();
  for (const row of model.rows) if (row.tp) {
    const key = tpKey(row.tp); if (!tpRows.has(key)) tpRows.set(key, { name: row.tp, rows: [], accounts: new Map() });
    const group = tpRows.get(key); group.rows.push(row);
    if (!group.accounts.has(row.accountKey)) group.accounts.set(row.accountKey, []); group.accounts.get(row.accountKey).push(row);
  }
  const contourMeters = [...tpRows].flatMap(([tp, group]) => [...group.accounts].map(([key, rows]) => meter(rows, `${tp}|${key}`)));
  let cache = new Map(), settingsKey = '';
  function run(scope, settings) {
    const config = normalizeSettings(settings), signature = JSON.stringify(config);
    if (signature !== settingsKey) { cache.clear(); settingsKey = signature; }
    if (cache.has(scope)) return cache.get(scope);
    setTune(config.levels, config); setZoneMode(config.zone, config.lossRed, config.lossAmber); setBoosts(config.boosts); setAlgOff(scope.startsWith('contour:') ? config.algOff : { ...config.algOff, zeroAlive: true, peers: true, season: true, imb: true, dzero: true, dsync: true });
    const meters = scope.startsWith('contour:') ? contourMeters.filter(m => m.tp === 'tp:' + scope.slice(8)) : globalMeters.filter(m => m.id === scope.slice(9));
    // Negative adjustments are not evidence of a stopped meter; mark them unknown
    // to the detector, but retain the original values in the chart and totals.
    const engineMeters = meters.map(m => ({ ...m, values: m.values.map(v => v != null && v < 0 ? null : v) }));
    const result = analyze({ meters: engineMeters, months: model.months, supplyRows: [], gran: 'month' }, null);
    const raw = new Map(meters.map(m => [m.id, m]));
    for (const r of result.results) {
      r.meter = raw.get(r.meter.id);
      r.total = r.meter.values.some(v => v != null) ? r.meter.values.reduce((s, v) => s + (v ?? 0), 0) : null;
      if (!r.meter.values.some(v => v != null && v >= 0)) { r.cls = 'unknown'; r.flags = []; r.lossKwh = null; r.score = null; }
    }
    if (cache.size >= 12) cache.delete(cache.keys().next().value);
    cache.set(scope, result); return result;
  }
  function resolveAccount(value) {
    const key = idKey(value), choices = model.aliases.get(key);
    if (!choices?.size) throw new Error(`ЛС ${value} не найден в «ПО по месячно». Проверьте номер договора и выбранную РЭС.`);
    if (choices.size > 1) throw new Error('Этот номер СТЕК соответствует нескольким договорам. Уточните основной ЛС в исходной выгрузке.');
    return [...choices][0];
  }
  const metadata = { months: model.months, warnings: model.warnings, rowCount: model.rows.length, accountCount: model.accounts.size, missingTP: model.rows.filter(r => !r.tp).length };
  return {
    summary: metadata,
    tps: () => [...tpRows].map(([key, g]) => ({ key, name: g.name, accounts: g.accounts.size })).sort((a,b) => a.name.localeCompare(b.name,'ru',{numeric:true})),
    consumer(account, settings, tp = null) {
      const key = resolveAccount(account), group = tp ? tpRows.get(tpKey(tp)) : null;
      if (tp && !group?.accounts.has(key)) throw new Error('Этот ЛС отсутствует в выбранном контуре ТП.');
      const result = run(tp ? 'contour:' + tpKey(tp) : 'consumer:' + key, settings);
      const r = result.results.find(r => r.meter.id === (tp ? `${tpKey(tp)}|${key}` : key));
      return { ...metadata, result: r, scope: tp ? `ЛС в контуре ${group.name}` : 'Все точки ЛС в выбранной РЭС', tp, individual: !tp, groupFallback: result.groupFallback, typeSplit: result.typeSplit };
    },
    contour(tp, settings) {
      const key = tpKey(tp), group = tpRows.get(key);
      if (!group) throw new Error(`ТП ${tp} не найдена в файле потребления. Проверьте столбец «ТП» в «ПО по месячно».`);
      const results = run('contour:' + key, settings).results.filter(r => r.meter.tp === 'tp:' + key);
      const values = strictSum(group.rows, model.months.length);
      const flags = new Map(); for (const r of results) for (const f of r.flags) { const old = flags.get(f.code) || { code: f.code, title: f.title, count: 0 }; old.count++; flags.set(f.code, old); }
      const registryMeters = new Set(records.filter(r => tpKey(r.fields.tp) === key).map(r => idKey(r.fields.meter)).filter(Boolean));
      return { ...metadata, tp: group.name, values, total: values.some(v => v != null) ? values.reduce((s,v) => s + (v ?? 0), 0) : null, completeMonths: values.filter(v => v != null).length, rowCount: group.rows.length, pointCount: new Set(group.rows.map(r => r.point).filter(Boolean)).size, meterCount: registryMeters.size, results, flags: [...flags.values()], incoming: { status: 'awaiting-format', values: null }, counts: Object.fromEntries(['red','amber','green','dead','unknown'].map(k => [k, results.filter(r => r.cls === k).length])) };
    },
  };
}
