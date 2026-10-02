/* SheetJS runs away from the interface thread; workbooks never leave the device. */
importScripts('./vendor/xlsx.full.min.js');
const core = import('./core.js');
let sourceSheets = [], sheets = [], index = null, analysisService = null, monthlyModel = null;
self.onmessage = async ({ data }) => {
  const { id, action, payload } = data;
  try {
    if (action === 'checkIncoming') {
      const { inspectExcelWorkbook } = await import('./workbook-check.js');
      self.postMessage({ id, result: inspectExcelWorkbook(payload.buffer, XLSX) }); return;
    }
    if (action === 'loadMonthly' || action === 'demoMonthly') {
      analysisService = null;
      const { readMonthlyWorkbook, indexMonthly } = await import('./monthly.js');
      const { createAnalysisService } = await import('./analysis-service.js');
      const parsed = action === 'demoMonthly' ? payload.parsed : readMonthlyWorkbook(payload.buffer, XLSX);
      monthlyModel = indexMonthly(parsed);
      analysisService = createAnalysisService(monthlyModel, payload.records);
      self.postMessage({ id, result: analysisService.summary }); return;
    }
    if (action === 'updateAnalysisRegistry') {
      if (monthlyModel) { const { createAnalysisService } = await import('./analysis-service.js'); analysisService = createAnalysisService(monthlyModel, payload.records); }
      self.postMessage({ id, result: true }); return;
    }
    if (['analysisConsumer', 'analysisTP', 'analysisTPs'].includes(action)) {
      if (!analysisService) throw new Error('Файл потребления не загружен.');
      const result = action === 'analysisConsumer' ? analysisService.consumer(payload.account, payload.settings, payload.tp, payload.point) : action === 'analysisTP' ? analysisService.contour(payload.tp, payload.settings) : analysisService.tps();
      self.postMessage({ id, result }); return;
    }
    if (action === 'analysisRecords') { self.postMessage({ id, result: (index?.records || []).map(({ fields }) => ({ fields })) }); return; }
    const { parseMatrix, buildIndex, search, detectLayout, restoreNumericIdentifiers, listTPs, metersByTP, listNotes } = await core;
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
      self.postMessage({ id, result: { count: index.records.length, notesCount: index.notes.length, hasNotesColumn: index.hasNotesColumn, skipped, sheets: sheets.map(({ sheet, layout, sample }) => ({ sheet, layout, sample })) } });
    } else if (action === 'search') {
      if (!index) throw new Error('Сначала откройте реестр.');
      self.postMessage({ id, result: search(index, payload) });
    } else if (action === 'notes') {
      if (!index) throw new Error('Сначала откройте реестр.');
      self.postMessage({ id, result: listNotes(index, payload) });
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
