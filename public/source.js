export const REGISTRY_NAME = 'Расширенный список.xls';
export const CONSUMPTION_NAME = 'По по месячно.xls';
export const isRegistryFile = name => String(name).normalize('NFKC').trim().toLocaleLowerCase('ru-RU') === REGISTRY_NAME.toLocaleLowerCase('ru-RU');
// Other files may be listed, but are never used as the subscriber registry.
export const isConsumptionFile = name => String(name).normalize('NFKC').trim().toLocaleLowerCase('ru-RU') === CONSUMPTION_NAME.toLocaleLowerCase('ru-RU');

// These sources remain separate: finding consumption never adds it to subscriber search.
export function findRegistry(items) { return items.find(item => item.type === 'file' && isRegistryFile(item.name)) || null; }
export function findConsumption(items) { return items.find(item => item.type === 'file' && isConsumptionFile(item.name)) || null; }
