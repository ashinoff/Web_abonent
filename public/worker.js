/* Prepared server packages skip SheetJS entirely; local Excel stays supported. */
const core = import('./core.js');
let sourceSheets = [], sheets = [], index = null, analysisService = null, monthlyModel = null;
let xlsxLoaded = false;
function ensureXLSX() { if (!xlsxLoaded) { importScripts('./vendor/xlsx.full.min.js'); xlsxLoaded = true; } }
self.onmessage = async ({ data }) => {
  const { id, action, payload } = data;
  try {
    if (['loadPreparedRegistry','loadPreparedMonthly','checkPreparedIncoming'].includes(action)) {
      const { fetchPrepared } = await import('./prepared-cache.js?v=12');
      const { data: pack, ...cacheInfo } = await fetchPrepared(payload);
      if (action === 'loadPreparedRegistry') {
        const { unpackRegistry } = await import('./prepared-data.js');
        const { buildIndex } = await core;
        sourceSheets = []; sheets = unpackRegistry(pack); index = buildIndex(sheets);
        self.postMessage({ id, result: { count: index.records.length, notesCount: index.notes.length, hasNotesColumn: index.hasNotesColumn,
          skipped: pack.skipped || [], sheets: sheets.map(({ sheet, layout, sample }) => ({ sheet, layout, sample })), ...cacheInfo } }); return;
      }
      if (action === 'loadPreparedMonthly') {
        const { unpackMonthly } = await import('./prepared-data.js');
        const { indexMonthly } = await import('./monthly.js');
        const { createAnalysisService } = await import('./analysis-service.js');
        analysisService = null; monthlyModel = indexMonthly(unpackMonthly(pack));
        analysisService = createAnalysisService(monthlyModel, payload.records);
        self.postMessage({ id, result: { ...analysisService.summary, ...cacheInfo } }); return;
      }
      if (pack.role !== 'incoming') throw new Error('Неверный пакет приёма.');
      self.postMessage({ id, result: { sheets: pack.sheets, ...cacheInfo } }); return;
    }
    if (action === 'checkIncoming') {
      ensureXLSX();
      const { inspectExcelWorkbook } = await import('./workbook-check.js');
      self.postMessage({ id, result: inspectExcelWorkbook(payload.buffer, XLSX) }); return;
    }
    if (action === 'loadMonthly' || action === 'demoMonthly') {
      if (action === 'loadMonthly') ensureXLSX();
      analysisService = null; monthlyModel = null;
      const { readMonthlyWorkbook, indexMonthly } = await import('./monthly.js');
      const { createAnalysisService } = await import('./analysis-service.js');
      const parsed = action === 'demoMonthly' ? payload.parsed : readMonthlyWorkbook(payload.buffer, XLSX);
      payload.buffer = null;
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
    if (action === 'releaseSource') { sourceSheets = []; self.postMessage({ id, result: true }); return; }
    if (action === 'analysisRecords') { const { analysisRecords } = await core; self.postMessage({ id, result: analysisRecords(index?.records || []) }); return; }
    const { parseMatrix, buildIndex, search, detectLayout, restoreNumericIdentifiers, listTPs, metersByTP, listNotes, listMapNotes, notificationRecord } = await core;
    if (action === 'clear') { sourceSheets = []; sheets = []; index = null; self.postMessage({ id, result: true }); return; }
    if (action === 'load' || action === 'demo') {
      sourceSheets = []; sheets = []; index = null;
      if (action === 'demo') sourceSheets = payload.sheets;
      else {
        ensureXLSX();
        const book = XLSX.read(payload.buffer, { type: 'array', dense: true, cellText: true, cellDates: false, cellHTML: false, cellFormula: false, cellNF: true, sheetRows: 100002 });
        payload.buffer = null;
        for (const name of book.SheetNames) {
          const ws = book.Sheets[name];
          if (!ws['!ref']) continue;
          const range = XLSX.utils.decode_range(ws['!ref']);
          if (range.e.r > 100000 || range.e.c > 255 || ws['!fullref']) throw new Error('Реестр слишком большой: максимум 100 000 строк и 256 столбцов на лист.');
          const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
          try { restoreNumericIdentifiers(matrix, ws, detectLayout(matrix, ws['!merges'] || [])); }
          catch (error) { if (/Excel мог округлить/.test(error.message)) throw error; }
          sourceSheets.push({ matrix, sheet: name, file: payload.file, merges: ws['!merges'] || [] });
          delete book.Sheets[name];
        }
      }
    }
    if (action === 'load' || action === 'demo' || action === 'remap') {
      if (!sourceSheets.length) throw new Error('Для нового сопоставления столбцов перечитайте реестр.');
      const skipped = [];
      sheets = []; index = null;
      for (const source of sourceSheets) {
        try {
          const parsed = parseMatrix(source.matrix, { ...source, overrides: payload.overrides?.[source.sheet] || null });
          if (!parsed.records.length) { skipped.push({ sheet: source.sheet, error: 'Нет строк с номером ПУ или ЛС.' }); continue; }
          sheets.push(parsed);
        } catch (error) { skipped.push({ sheet: source.sheet, error: error.message }); }
      }
      if (!sheets.length) throw new Error(skipped[0]?.error || 'В файле нет доступных строк реестра.');
      index = buildIndex(sheets);
      if (action === 'demo') sourceSheets = [];
      self.postMessage({ id, result: { count: index.records.length, notesCount: index.notes.length, hasNotesColumn: index.hasNotesColumn, skipped, sheets: sheets.map(({ sheet, layout, sample }) => ({ sheet, layout, sample })) } });
    } else if (action === 'search') {
      if (!index) throw new Error('Сначала откройте реестр.');
      self.postMessage({ id, result: search(index, payload) });
    } else if (action === 'mapNotes') {
      self.postMessage({ id,result:listMapNotes(index) });
    } else if (action === 'notificationRecord') {
      if (!index) throw new Error('Сначала откройте реестр.');
      self.postMessage({id,result:notificationRecord(index,payload.fields)});
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
