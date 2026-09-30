// Consumption workbooks are reserved for a separate workflow, never subscriber search.
export function isConsumptionFile(name) {
  const base = String(name).normalize('NFKC').replace(/\.[^.]+$/, '').toLocaleLowerCase('ru-RU').trim();
  return /(^|[^\p{L}])потребление([^\p{L}]|$)/u.test(base);
}

// One enterprise is one folder. Select its newest registry independently of API order.
export function newestRegistry(items) {
  return items.filter(item => item.type === 'file' && /\.(xlsx|xls|xlsm|csv)$/i.test(item.name) && !item.name.startsWith('~$') && !isConsumptionFile(item.name))
    .sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')) || a.name.localeCompare(b.name, 'ru'))[0] || null;
}
