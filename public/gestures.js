// Down dismisses only from the header or the start of a scroll area.
// A scroll that starts further down must remain an ordinary scroll.
export function swipeDirection({ dx, dy, atTop, fromHeader, canGoBack }) {
  if (dy > 12 && dy > Math.abs(dx) * 1.35 && (atTop || fromHeader)) return 'down';
  if (dx > 12 && dx > Math.abs(dy) * 1.35 && canGoBack) return 'right';
  return null;
}
export function completedSwipe(state) {
  const direction = swipeDirection(state);
  return direction === 'down' && state.dy >= 80 || direction === 'right' && state.dx >= 90 ? direction : null;
}
export function attachDialogSwipe(dialog, { close, back, canGoBack }) {
  let start = null, suppressClickUntil = 0;
  function reset() { start = null; dialog.style.transform = ''; dialog.classList.remove('swiping'); }
  function begin(event, x, y) {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const body = event.target.closest('.dialog-body');
    start = { x, y, time: performance.now(), atTop: !body || body.scrollTop <= 1, fromHeader: Boolean(event.target.closest('.dialog-header')), canGoBack: canGoBack() };
  }
  function state(x, y) { return { ...start, dx: x - start.x, dy: y - start.y, duration: performance.now() - start.time }; }
  function move(event, x, y) {
    if (!start) return;
    const s = state(x, y), direction = swipeDirection(s);
    if (!direction) return;
    if (event.cancelable) event.preventDefault();
    start.dragged = true;
    dialog.classList.add('swiping');
    dialog.style.transform = direction === 'down' ? `translateY(${Math.min(s.dy * .45, 100)}px)` : `translateX(${Math.min(s.dx * .45, 110)}px)`;
  }
  function end(x, y) {
    if (!start) return;
    const direction = completedSwipe(state(x, y)), dragged = start.dragged;
    reset();
    if (dragged) suppressClickUntil = performance.now() + 500;
    if (direction === 'down') close();
    if (direction === 'right') back();
  }
  dialog.addEventListener('touchstart', e => { reset(); if (e.touches.length === 1) begin(e, e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  dialog.addEventListener('touchmove', e => { if (e.touches.length !== 1) { reset(); return; } move(e, e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  dialog.addEventListener('touchend', e => { if (e.changedTouches[0]) end(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: true });
  dialog.addEventListener('touchcancel', reset);
  dialog.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) begin(e, e.clientX, e.clientY); });
  dialog.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && e.buttons === 1) move(e, e.clientX, e.clientY); });
  window.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') end(e.clientX, e.clientY); });
  dialog.addEventListener('pointercancel', reset);
  dialog.addEventListener('close', reset);
  dialog.addEventListener('click', e => { if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
}
