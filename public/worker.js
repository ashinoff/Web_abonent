/* SheetJS runs away from the interface thread; workbooks never leave the device. */
importScripts('./vendor/xlsx.full.min.js');
const core = import('./core.js');
let sourceSheets = [], sheets = [], index = null;
self.onmessage = async ({ data }) => {
  const { id, action, payload } = data;
  try {
    if (action === 'checkConsumption') {
      const { inspectMonthlyWorkbook } = await import('./workbook-check.js');
      self.postMessage({ id, result: inspectMonthlyWorkbook(payload.buffer, XLSX) }); return;
    }
    const { parseMatrix, buildIndex, search, detectLayout, restoreNumericIdentifiers, listTPs, metersByTP } = await core;
    if (action === 'clear') { sourceSheets = []; sheets = []; index = null; self.postMessage({ id, result: true }); return; }
    if (action === 'load' || action === 'demo') {
      sourceSheets = []; sheets = []; index = null;
      if (action === 'demo') sourceSheets = payload.sheets;
      else {
        const book = XLSX.read(payload.buffer, { type: 'array', cellText: true, cellDates: false, cellHTML: false, cellNF: true, sheetRows: 100002 });
        for (const name of book.SheetNames) {
          const ws = book.Sheets[name];
          if (!ws['!ref']) continue;
          const range = XLSX.utils.decode_range(ws['!ref']);
          if (range.e.r > 100000 || range.e.c > 255 || ws['!fullref']) throw new Error('Реестр слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
          const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
          try { restoreNumericIdentifiers(matrix, ws, detectLayout(matrix, ws['!merges'] || [])); }
          catch (error) { if (/Excel мог округлить/.test(error.message)) throw error; }
          sourceSheets.push({ matrix, sheet: name, file: payload.file, merges: ws['!merges'] || [] });
        }
      }
    }
    if (action === 'load' || action === 'demo' || action === 'remap') {
      const skipped = [];
      sheets = [];
      for (const source of sourceSheets) {
        try {
          const parsed = parseMatrix(source.matrix, { ...source, overrides: payload.overrides?.[source.sheet] || null });
          if (!parsed.records.length) { skipped.push({ sheet: source.sheet, error: 'Нет строк с номером ПУ или ЛС.' }); continue; }
          sheets.push(parsed);
        } catch (error) { skipped.push({ sheet: source.sheet, error: error.message }); }
      }
      if (!sheets.length) throw new Error(skipped[0]?.error || 'В файле нет доступных строк реестра.');
      index = buildIndex(sheets);
      self.postMessage({ id, result: { count: index.records.length, skipped, sheets: sheets.map(({ sheet, layout, sample }) => ({ sheet, layout, sample })) } });
    } else if (action === 'search') {
      if (!index) throw new Error('Сначала откройте реестр.');
      self.postMessage({ id, result: search(index, payload) });
    } else if (action === 'tps' || action === 'tpMeters') {
      if (!index) throw new Error('Сначала откройте реестр.');
      self.postMessage({ id, result: action === 'tps' ? listTPs(index) : metersByTP(index, payload) });
    } else if (action === 'record') {
      const record = index?.records.find(r => r.id === payload.id);
      if (!record) throw new Error('Запись не найдена.');
      self.postMessage({ id, result: { ...record, labels: sheets.find(s => s.sheet === record.sheet).layout.labels } });
    }
  } catch (error) { self.postMessage({ id, error: error.message || 'Не удалось прочитать реестр.' }); }
};
