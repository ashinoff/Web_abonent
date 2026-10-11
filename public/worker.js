/* Prepared server packages skip SheetJS entirely; local Excel stays supported. */
const core = import('./core.js');
let sourceSheets = [], sheets = [], index = null, analysisService = null, monthlyModel = null;
let xlsxLoaded = false;
let journalPacks = { instant: null, events: null }, monthlyRecords = [];
let journalGeneration = 0;
const journalControllers = new Map();
let reportSequence = 0, reportPlan = null;
async function rebuildAnalysis() {
  if (!monthlyModel) return;
  const { createAnalysisService } = await import('./analysis-service.js');
  reportSequence++; reportPlan = null;
  analysisService = createAnalysisService(monthlyModel, monthlyRecords, journalPacks);
}
function journalSummary(pack) {
  return { role: pack.role, stats: pack.stats, warnings: pack.warnings || [], meterCount: pack.meters?.length ?? pack.stats?.meters ?? new Set(pack.groups?.map(group => group.serial) || pack.rows?.map(row => row[0])).size, reportPeriod: pack.reportPeriod, coefficientMode: pack.coefficientMode };
}
function ensureXLSX() { if (!xlsxLoaded) { importScripts('./vendor/xlsx.full.min.js'); xlsxLoaded = true; } }
self.onmessage = async ({ data }) => {
  const { id, action, payload } = data;
  try {
    if (action === 'cancelJournalLoads') {
      journalGeneration++;
      for (const controller of journalControllers.values()) controller.abort();
      for (const role of payload.roles || []) if (['instant', 'events'].includes(role)) journalPacks[role] = null;
      await rebuildAnalysis(); self.postMessage({ id, result: true }); return;
    }
    if (action === 'loadPreparedJournal' || action === 'loadJournal') {
      if (!['instant', 'events'].includes(payload.role)) throw new Error('Неизвестный журнал.');
      let pack, cacheInfo = {};
      const generation = journalGeneration, controller = new AbortController();
      journalControllers.set(id, controller);
      try {
      if (action === 'loadPreparedJournal') {
        const { fetchPrepared } = await import('./prepared-cache.js?v=19');
        ({ data: pack, ...cacheInfo } = await fetchPrepared({ ...payload, signal: controller.signal }));
      } else {
        ensureXLSX();
        const { readJournalWorkbook } = await import('./journals.js');
        pack = readJournalWorkbook(payload.buffer, XLSX, payload.role);
        payload.buffer = null;
      }
      controller.signal.throwIfAborted();
      if (generation !== journalGeneration) throw new Error('Чтение журнала отменено.');
      if (pack?.format !== 1 || pack.role !== payload.role) throw new Error('Неверный пакет журнала.');
      if (payload.role === 'events') {
        const { normalizeEventPack } = await import('./journals.js');
        pack = normalizeEventPack(pack);
      }
      journalPacks[payload.role] = pack;
      await rebuildAnalysis();
      self.postMessage({ id, result: { ...journalSummary(pack), ...cacheInfo } }); return;
      } finally { journalControllers.delete(id); }
    }
    if (action === 'clearAnalysisJournal') {
      if (['instant', 'events'].includes(payload.role)) journalPacks[payload.role] = null;
      await rebuildAnalysis(); self.postMessage({ id, result: true }); return;
    }
    if (action === 'exportAnomalies') {
      if (!analysisService) throw new Error('Файл потребления не загружен.');
      ensureXLSX();
      const { planAnomalyWorkbooks } = await import('./anomaly-report.js');
      const service = analysisService, token = ++reportSequence; reportPlan = null;
      const options = { onProgress: progress => self.postMessage({ id, progress }), assertCurrent: () => {
        if (token !== reportSequence || service !== analysisService) throw new Error('Формирование отчёта отменено. Потребление остаётся загруженным.');
      } };
      const report = await service.reportAsync(payload.settings, options);
      const plan = await planAnomalyWorkbooks(report, payload.context, options);
      options.assertCurrent(); reportPlan = { plan, token, service };
      self.postMessage({ id, result: { token, count: plan.count, parts: plan.parts.map((part, index) => ({ index, count: part.count })) } }); return;
    }
    if (action === 'clearAnomalyReport') { reportSequence++; reportPlan = null; self.postMessage({ id, result: true }); return; }
    if (action === 'exportAnomalyPart') {
      if (!reportPlan || reportPlan.token !== payload.token || reportPlan.service !== analysisService) throw new Error('Данные отчёта изменились. Сформируйте отчёт заново.');
      ensureXLSX();
      const currentPlan = reportPlan;
      const { buildAnomalyWorkbookPart } = await import('./anomaly-report.js');
      if (reportPlan !== currentPlan) throw new Error('Формирование отчёта отменено.');
      const output = buildAnomalyWorkbookPart(currentPlan.plan, payload.index, XLSX, progress => self.postMessage({ id, progress }));
      const buffer = output instanceof ArrayBuffer ? output : output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
      self.postMessage({ id, result: { buffer } }, [buffer]); return;
    }
    if (['loadPreparedRegistry','loadPreparedMonthly','checkPreparedIncoming'].includes(action)) {
      const { fetchPrepared } = await import('./prepared-cache.js?v=19');
      const { data: pack, ...cacheInfo } = await fetchPrepared(payload);
      if (action === 'loadPreparedRegistry') {
        const { unpackRegistry } = await import('./prepared-data.js');
        const { buildIndex } = await core;
        sourceSheets = []; sheets = unpackRegistry(pack); index = buildIndex(sheets);
        self.postMessage({ id, result: { count: index.records.length, notesCount: index.notes.length, hasNotesColumn: index.hasNotesColumn,
          skipped: pack.skipped || [], sheets: sheets.map(({ sheet, layout, sample }) => ({ sheet, layout, sample })), ...cacheInfo } }); return;
      }
      if (action === 'loadPreparedMonthly') {
        reportSequence++; reportPlan = null;
        const { unpackMonthly } = await import('./prepared-data.js');
        const { indexMonthly } = await import('./monthly.js');
        const { createAnalysisService } = await import('./analysis-service.js');
        analysisService = null; monthlyModel = indexMonthly(unpackMonthly(pack));
        monthlyRecords = payload.records || [];
        analysisService = createAnalysisService(monthlyModel, monthlyRecords, journalPacks);
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
      reportSequence++; reportPlan = null;
      if (action === 'loadMonthly') ensureXLSX();
      analysisService = null; monthlyModel = null;
      const { readMonthlyWorkbook, indexMonthly } = await import('./monthly.js');
      const { createAnalysisService } = await import('./analysis-service.js');
      const parsed = action === 'demoMonthly' ? payload.parsed : readMonthlyWorkbook(payload.buffer, XLSX);
      payload.buffer = null;
      monthlyModel = indexMonthly(parsed);
      monthlyRecords = payload.records || [];
      analysisService = createAnalysisService(monthlyModel, monthlyRecords, journalPacks);
      self.postMessage({ id, result: analysisService.summary }); return;
    }
    if (action === 'updateAnalysisRegistry') {
      monthlyRecords = payload.records || [];
      await rebuildAnalysis();
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
  } catch (error) { self.postMessage({ id, error: error.message || 'Не удалось прочитать реестр.',status:error.status,code:error.code }); }
};
