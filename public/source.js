export const REGISTRY_NAME = 'Расширенный список.xls / .xlsx';
export const CONSUMPTION_NAME = 'ПО.xls / .xlsx';
export const INSTANT_NAME = '31. Мгновенные значения.xls / .xlsx';
export const EVENTS_NAME = '46. События по точкам учёта.xls / .xlsx';
export const sourceRoles = [['registry', 'Реестр'], ['consumption', 'ПО'], ['incoming', 'Приём'], ['instant', 'Журнал 31'], ['events', 'Журнал 46']];
export const sourceRoleKeys = sourceRoles.map(([role]) => role);
const normalized = name => String(name).normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
export const isRegistryFile = name => /^расширенный список\.xlsx?$/.test(normalized(name));
export const isConsumptionFile = name => /^по(?: по месячно)?\.xlsx?$/.test(normalized(name));
export const isExcelFile = name => /\.xlsx?$/.test(normalized(name)) && !normalized(name).startsWith('~$');
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

// Journal numbers are stable across dated exports. Recognise both numbered and
// human-readable names, while keeping temporary Excel lock files out of selection.
export const isInstantFile = name => isExcelFile(name) && /^(?:31[.\s_-]|мгновенные значения[.\s_(-])/.test(normalized(name));
export const isEventsFile = name => isExcelFile(name) && /^(?:46[.\s_-]|события по точкам уч[её]та[.\s_(-])/.test(normalized(name));
export const findInstant = items => select(items, isInstantFile);
export const findEvents = items => select(items, isEventsFile);

// Manual choices are resolved only against the freshly listed files of this RES.
// A missing saved file must not silently switch the user to a different workbook.
export function findSource(items, role, choices = {}) {
  const finder = { registry: findRegistry, consumption: findConsumption, incoming: findIncoming, instant: findInstant, events: findEvents }[role];
  if (!finder) return null;
  const chosen = choices[role];
  return chosen ? items.find(item => item.type === 'file' && item.path === chosen.path && isExcelFile(item.name)) || null : finder(items);
}
