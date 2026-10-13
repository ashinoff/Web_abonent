import { formatEnergyText } from './energy-format.js';

// Preserve measured journal evidence. Monthly detector prose predates the
// current presentation and includes guesses after its factual observation.
export function flagObservation(flag = {}) {
  if (['instant', 'events', 'correlation'].includes(flag.source)) return formatEnergyText(flag.detail || '');
  let observation = String(flag.detail || '').split(/\.\s+(?=[А-ЯЁ])/u)[0];
  if (flag.code === 'S7') observation = observation.split(' — ')[0] + ' — преобладают округлённые объёмы';
  if (flag.code === 'S8') observation = observation.replace(/ниже 30% медианы группы/, 'ниже настроенного порога группы');
  return formatEnergyText(observation);
}
