export const REGISTRY_NAME = 'Расширенный список.xls / .xlsx';
export const CONSUMPTION_NAME = 'ПО по месячно.xls / .xlsx';
const normalized = name => String(name).normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
export const isRegistryFile = name => /^расширенный список\.xlsx?$/.test(normalized(name));
export const isConsumptionFile = name => /^по по месячно\.xlsx?$/.test(normalized(name));
// If both formats exist, read only the newest; prefer XLSX on a timestamp tie.
function select(items, matches) {
  return items.filter(item => item.type === 'file' && matches(item.name)).sort((a, b) =>
    (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0) || Number(/\.xlsx$/i.test(b.name)) - Number(/\.xlsx$/i.test(a.name)) || a.name.localeCompare(b.name, 'ru'))[0] || null;
}
export const findRegistry = items => select(items, isRegistryFile);
export const findConsumption = items => select(items, isConsumptionFile);

export const INCOMING_NAME = 'прием.xls / .xlsx';
export const isIncomingFile = name => /^при[её]м\.xlsx?$/.test(normalized(name));
export const findIncoming = items => select(items, isIncomingFile);
