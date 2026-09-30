export const REGISTRY_NAME = 'Расширенный список.xls';
export const isRegistryFile = name => String(name).normalize('NFKC').trim().toLocaleLowerCase('ru-RU') === REGISTRY_NAME.toLocaleLowerCase('ru-RU');
// Other files may be listed, but are never used as the subscriber registry.
export function isConsumptionFile(name) {
  const base = String(name).normalize('NFKC').replace(/\.[^.]+$/, '').toLocaleLowerCase('ru-RU').trim();
  return /(^|[^\p{L}])потребление([^\p{L}]|$)/u.test(base);
}

function newestWorkbook(items, consumption) {
  return items.filter(item => item.type === 'file' && /\.(xlsx|xls|xlsm|csv)$/i.test(item.name) && !item.name.startsWith('~$') && isConsumptionFile(item.name) === consumption)
    .sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')) || a.name.localeCompare(b.name, 'ru'))[0] || null;
}

// These sources remain separate: finding consumption never adds it to subscriber search.
export function findRegistry(items) { return items.find(item => item.type === 'file' && isRegistryFile(item.name)) || null; }
export function newestConsumption(items) { return newestWorkbook(items, true); }
