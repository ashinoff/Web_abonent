import { numeric } from './monthly.js';
export function calculateReading(actual, previous, ratio) {
  const a=numeric(actual), p=numeric(previous), k=numeric(ratio);
  if (a==null || a<0) throw new Error('Введите неотрицательные фактические показания.');
  if (p==null || p<0) throw new Error('В реестре нет корректных показаний с квитанции.');
  if (k==null || k<=0) throw new Error('В реестре нет корректного коэффициента ТТ.');
  const volume=(a-p)*k;
  if (!Number.isFinite(volume)) throw new Error('Значение слишком большое. Проверьте показания.');
  return { actual:a, previous:p, ratio:k, volume, negative:volume<0 };
}
