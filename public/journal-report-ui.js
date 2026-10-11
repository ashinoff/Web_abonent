// Reuse the current RES's analysis worker and report protocol. No source data
// leaves the device; availability follows the existing selected-RES controls.
export function initJournalReportUI({ request, isReady, getSettings }) {
  const button = document.getElementById('journal-export'), previous = document.getElementById('anomaly-export');
  const dialog = document.getElementById('journal-report-dialog');
  if (!button || !previous || !dialog) return { reset() {} };
  const status = document.getElementById('journal-report-status'), progress = document.getElementById('journal-report-progress'), parts = document.getElementById('journal-report-parts');
  let version = 0, busy = false, session = null;
  function sync() {
    const loaded = ['instant', 'events'].some(role => document.querySelector(`[data-source-card="${role}"]`)?.dataset.state === 'ready');
    const enabled = isReady() && !previous.disabled && loaded;
    const disabled = busy || !enabled;
    if (button.disabled !== disabled) button.disabled = disabled;
    button.dataset.state = busy || previous.dataset.state === 'checking' ? 'checking' : enabled ? 'on' : previous.dataset.state === 'idle' ? 'idle' : 'off';
    button.title = busy ? 'Готовим отчёт по журналам…' : enabled ? 'Выгрузить ПУ с флагами журналов 31 и 46' : 'Выберите РЭС, загрузите реестр, потребление и журнал 31 или 46';
    button.setAttribute('aria-label', 'Excel-отчёт по журналам 31/46: ' + button.title);
  }
  const observer = new previous.ownerDocument.defaultView.MutationObserver(sync);
  observer.observe(previous, { attributes: true, attributeFilter: ['disabled', 'data-state'] });
  for (const role of ['instant', 'events']) {
    const card = document.querySelector(`[data-source-card="${role}"]`);
    if (card) observer.observe(card, { attributes: true, attributeFilter: ['data-state'] });
  }
  function onProgress(value) {
    const phase = value.phase === 'analysis' ? 'Проверяем ПУ с признаками журналов' : value.phase === 'parts' ? 'Распределяем ПУ по файлам' : 'Готовим Excel';
    status.textContent = `${phase} · ${value.done} / ${value.total}`;
    progress.hidden = false; progress.value = value.total ? Math.round(value.done * 100 / value.total) : 0;
  }
  async function download(index) {
    const current = session, n = version;
    if (!current || busy) return;
    busy = true; sync(); parts.querySelectorAll('button').forEach(item => { item.disabled = true; });
    try {
      const { buffer } = await request('exportAnomalyPart', { token: current.token, index }, [], value => { if (n === version) onProgress(value); });
      if (n !== version || current !== session || !dialog.open) return;
      const href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const link = document.createElement('a'), suffix = current.parts.length > 1 ? `_часть_${String(index + 1).padStart(3, '0')}_из_${current.parts.length}` : '';
      link.href = href; link.download = current.filename + suffix + '.xlsx'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      status.textContent = `Часть ${index + 1} из ${current.parts.length} готова к сохранению.`;
      parts.querySelector(`[data-journal-part="${index}"]`).textContent = 'Скачать ещё раз';
    } catch (error) { if (n === version) status.textContent = error.message; }
    finally { if (n === version) { busy = false; progress.hidden = true; parts.querySelectorAll('button').forEach(item => { item.disabled = false; }); sync(); } }
  }
  button.addEventListener('click', async () => {
    if (button.disabled || busy) return;
    const n = ++version, name = document.getElementById('res-label').textContent;
    busy = true; session = null; sync(); parts.replaceChildren(); document.getElementById('journal-report-subtitle').textContent = name;
    onProgress({ phase: 'analysis', done: 0, total: 0 }); dialog.showModal();
    try {
      const generatedAt = new Date().toISOString();
      const result = await request('exportAnomalies', { kind: 'journals', settings: getSettings(), context: { res: { name }, generatedAt } }, [], value => { if (n === version) onProgress(value); });
      if (n !== version || !dialog.open) return;
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(generatedAt));
      session = { ...result, filename: `Флаги_31_46_${name.replace(/[\\/:*?"<>|]/g, '_')}_${day}` };
      for (const part of result.parts) {
        const row = document.createElement('div'), copy = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('span'), save = document.createElement('button');
        row.className = 'report-part'; title.textContent = `Часть ${part.index + 1} из ${result.parts.length}`; detail.textContent = `ПУ с признаками: ${part.count}`;
        copy.append(title, document.createElement('br'), detail); save.type = 'button'; save.className = 'secondary'; save.dataset.journalPart = part.index; save.textContent = 'Скачать Excel'; row.append(copy, save); parts.append(row);
      }
      status.textContent = result.count ? `ПУ с признаками: ${result.count}. Файлов: ${result.parts.length}.` : 'В загруженных журналах ПУ с флагами не найдено.';
      busy = false;
      if (result.count && result.parts.length === 1) await download(0);
    } catch (error) { if (n === version) status.textContent = error.message; }
    finally { if (n === version) { busy = false; progress.hidden = true; sync(); } }
  });
  parts.addEventListener('click', event => { const target = event.target.closest('[data-journal-part]'); if (target) void download(Number(target.dataset.journalPart)); });
  dialog.addEventListener('close', () => {
    const clear = !!session || busy; version++; session = null; busy = false; progress.hidden = true; sync();
    if (clear) void request('clearAnomalyReport').catch(() => {});
  });
  sync();
  return { reset() { version++; session = null; busy = false; if (dialog.open) dialog.close(); parts.replaceChildren(); progress.hidden = true; sync(); } };
}
