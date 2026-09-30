import { TUNE_DEFS, BOOST_DEFS } from './analysis-engine.js';
export const defaultSettings = () => ({ levels: {}, algOff: {}, boosts: {}, red: 45, amber: 20, zone: 'score', lossRed: 5000, lossAmber: 1000, balPct: 10, gran: 'auto' });
const clamp = (v, lo, hi, fallback) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback;
export function normalizeSettings(input = {}) {
  const v = { ...defaultSettings(), ...input }, out = defaultSettings();
  out.red = Math.round(clamp(v.red, 30, 70, 45)); out.amber = Math.round(clamp(v.amber, 10, Math.min(40, out.red - 5), 20));
  out.lossRed = clamp(v.lossRed, 1, 1e9, 5000); out.lossAmber = clamp(v.lossAmber, 1, out.lossRed, 1000);
  out.zone = v.zone === 'loss' ? 'loss' : 'score'; out.balPct = clamp(v.balPct, 0, 50, 10); out.gran = v.gran === 'month' ? 'month' : 'auto';
  for (const key of Object.keys(TUNE_DEFS)) { out.levels[key] = Math.round(clamp(v.levels?.[key], -2, 2, 0)); out.algOff[key] = v.algOff?.[key] === true; }
  for (const { id } of BOOST_DEFS) out.boosts[id] = v.boosts?.[id] === true;
  return out;
}
