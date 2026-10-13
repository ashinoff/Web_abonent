import { numeric } from './monthly.js';
import { calculateReading } from './readings.js';

const whole = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
// Round presentation only. Source volumes, aggregation and detector thresholds
// keep their precision, including small negative adjustments.
export function formatEnergy(value) {
  const amount = typeof value === 'number' ? value : numeric(value);
  return Number.isFinite(amount) ? whole.format(Math.abs(amount) < .5 ? 0 : amount) : '—';
}
export function formatEnergyText(value) {
  return String(value ?? '').replace(/(?<![\p{L}\p{N}_.,+−-])([+−-]?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?)\s*(кВт\s*[·⋅*.]?\s*ч|кВтч|kWh)/giu,
    (text, amount, unit) => formatEnergy(amount.replace('−', '-')) + ' ' + unit);
}
export function isEnergyLabel(label) {
  const text = String(label || '').toLowerCase().replace(/ё/g, 'е').split(' · ').at(-1).trim();
  return /квт\s*[·⋅*.]?\s*ч|kwh|^итоговый\s+по(?:\s|$)|^полезный\s+отпуск(?:\s|$)|^(?:объем|расход|потребление)\s+(?:электроэнергии|электрической энергии|активной энергии)/.test(text);
}
export function observeReadingEnergy(host) {
  if (!host) return;
  const observer = new host.ownerDocument.defaultView.MutationObserver(records => {
    const outputs = new Set();
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const output = element?.closest('.reading-calculator output');
      if (output && host.contains(output)) outputs.add(output);
    }
    for (const output of outputs) {
      const current = output.textContent, box = output.closest('.reading-calculator');
      let formatted = formatEnergyText(current);
      if (box.dataset.calculated === 'true') {
        try { formatted = formatEnergy(calculateReading(box.querySelector('input').value, box.dataset.previous, box.dataset.ratio).volume) + ' кВт·ч'; }
        catch { /* Keep the existing result when the calculator has no complete inputs. */ }
      }
      if (formatted !== current) output.textContent = formatted;
    }
  });
  // Observe only rendered calculator outputs. Inputs, formulas, source records
  // and the exact calculateReading result are never rewritten. Reuse the exact
  // inputs to avoid rounding a result that was already formatted to six decimals.
  observer.observe(host, { subtree: true, childList: true, characterData: true });
  return observer;
}
