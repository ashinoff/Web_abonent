const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = n => new Intl.NumberFormat('ru-RU').format(n);

export function initNotesUI({ request, openDialog, openRecord }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#notes-dialog'), list = $('#notes-list'), filter = $('#notes-filter'), more = $('#notes-more');
  let summary = null, rows = [], version = 0, timer, loading = false;

  function update(data, busy = false) {
    summary = data;
    const count = data?.notesCount || 0, button = $('#notes-open'), badge = $('#notes-badge');
    button.disabled = !data || busy;
    button.setAttribute('aria-label', data ? `Примечания в реестре: ${number(count)}` : 'Примечания: сначала загрузите реестр');
    button.title = button.getAttribute('aria-label');
    badge.textContent = number(count); badge.hidden = !count;
  }
  function reset() {
    version++; clearTimeout(timer); loading = false; rows = []; summary = null;
    dialog.close(); list.replaceChildren(); filter.value = ''; update(null);
  }
  function render() {
    list.innerHTML = rows.map((r, i) => `<button type="button" class="meter-item note-item" data-note="${i}"><span class="meter-item-head"><span class="meter-number"><span class="number-label">Номер ПУ</span><strong>${esc(r.fields.meter || '—')}</strong></span><span class="meter-open-label">Открыть</span></span><span class="meter-details"><span><span class="number-label">Лицевой счёт</span><strong>${esc(r.fields.account || '—')}</strong></span><span><span class="number-label">Точка учёта</span><strong>${esc([r.fields.point || r.fields.pointNumber, r.fields.pointName].filter(Boolean).join(' · ') || '—')}</strong></span></span><span class="meter-subscriber">${esc(r.fields.name || 'Абонент')}</span><span class="note-location">${esc([r.fields.tp, r.address].filter(Boolean).join(' · '))}</span><span class="note-text"><span class="number-label">Примечание</span><span>${esc(r.note)}</span></span><span class="note-source">${esc(r.sheet)} · строка ${r.row}</span></button>`).join('');
  }
  async function load(append = false) {
    if (!summary || append && loading) return;
    clearTimeout(timer);
    const current = ++version; loading = true; more.disabled = true;
    $('#notes-message').hidden = true;
    if (!append) { rows = []; list.innerHTML = '<p class="loading-row">Читаем примечания…</p>'; more.hidden = true; $('#notes-body').scrollTop = 0; }
    try {
      const data = await request('notes', { query: filter.value.trim(), offset: append ? rows.length : 0, limit: 100 });
      if (current !== version || !dialog.open) return;
      rows = append ? [...rows, ...data.notes] : data.notes; render();
      $('#notes-meta').textContent = filter.value.trim() ? `Найдено: ${number(data.total)} · Всего примечаний: ${number(data.totalInRegistry)}` : `Примечаний в реестре: ${number(data.totalInRegistry)}`;
      more.hidden = rows.length >= data.total;
      if (!rows.length) list.innerHTML = `<p class="hint">${filter.value.trim() ? 'Совпадений нет. Измените запрос.' : summary.hasNotesColumn ? 'Заполненных примечаний в реестре нет.' : 'В реестре нет столбца «Примечание».'}</p>`;
    } catch (error) {
      if (current !== version) return;
      if (!append) list.replaceChildren();
      $('#notes-message').textContent = error.message; $('#notes-message').hidden = false;
    } finally { if (current === version) { loading = false; more.disabled = false; } }
  }
  $('#notes-open').addEventListener('click', () => {
    if (!summary) return;
    filter.value = ''; openDialog('notes-dialog'); load();
  });
  filter.addEventListener('input', () => { version++; clearTimeout(timer); more.disabled = true; timer = setTimeout(() => load(), 160); });
  more.addEventListener('click', () => load(true));
  list.addEventListener('click', e => {
    const button = e.target.closest('[data-note]');
    if (button) openRecord(rows[Number(button.dataset.note)].id, { parent: 'notes-dialog', variants: [] });
  });
  dialog.addEventListener('close', () => { version++; clearTimeout(timer); loading = false; });
  return { update, reset };
}
