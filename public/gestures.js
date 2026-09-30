// The direction locks after a small intentional movement. Scrolling from the
// middle of a document never becomes a downward dismissal.
export function swipeDirection({ dx, dy, atTop, fromHeader, canGoBack }) {
  if (dy > 12 && dy > Math.abs(dx) * 1.35 && (atTop || fromHeader)) return 'down';
  if (dx > 12 && dx > Math.abs(dy) * 1.35 && canGoBack) return 'right';
  return null;
}
export function completedSwipe(state) {
  const direction = state.direction || swipeDirection(state);
  return direction === 'down' && state.dy >= 80 || direction === 'right' && state.dx >= 90 ? direction : null;
}
export function attachDialogSwipe(dialog, { close, back, canGoBack, prepareBack }) {
  const surface = document.createElement('div');
  surface.className = 'dialog-surface';
  surface.append(...dialog.childNodes); dialog.append(surface);
  let start = null, suppressClickUntil = 0, frame = 0, position = 0;
  let animation = null, cleanupPreview = null, settling = false, generation = 0;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function clearVisuals() {
    cancelAnimationFrame(frame); frame = 0;
    animation?.cancel(); animation = null;
    surface.style.transform = '';
    dialog.style.removeProperty('--swipe-progress');
    dialog.classList.remove('swiping', 'swipe-settling');
    cleanupPreview?.(); cleanupPreview = null;
    position = 0;
  }
  function reset() { generation++; start = null; settling = false; clearVisuals(); }
  function applyPosition() {
    frame = 0;
    if (!start?.direction) return;
    surface.style.transform = start.direction === 'down' ? `translate3d(0,${position}px,0)` : `translate3d(${position}px,0,0)`;
    const size = start.direction === 'down' ? surface.clientHeight : surface.clientWidth;
    dialog.style.setProperty('--swipe-progress', String(Math.min(position / Math.max(size, 1), 1)));
  }
  function begin(event, x, y) {
    if (settling || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    clearVisuals();
    const body = event.target.closest('.dialog-body');
    start = { x, y, atTop: !body || body.scrollTop <= 1, fromHeader: Boolean(event.target.closest('.dialog-header')), canGoBack: canGoBack(), direction: null };
  }
  function state(x, y) { return { ...start, dx: x - start.x, dy: y - start.y }; }
  function move(event, x, y) {
    if (!start || settling) return;
    const s = state(x, y);
    if (!start.direction) {
      start.direction = swipeDirection(s);
      if (!start.direction) return;
      if (start.direction === 'right') cleanupPreview = prepareBack?.() || null;
      dialog.classList.add('swiping');
    }
    if (event.cancelable) event.preventDefault();
    // Follow the finger one to one, including when it moves back toward the origin.
    position = Math.max(0, start.direction === 'down' ? s.dy : s.dx);
    if (!frame) frame = requestAnimationFrame(applyPosition);
  }
  async function settle(direction) {
    if (settling) return;
    if (direction === 'right' && !canGoBack()) direction = null;
    if (!start && !direction) return;
    const axis = start?.direction || direction;
    if (direction === 'right' && !cleanupPreview) cleanupPreview = prepareBack?.() || null;
    cancelAnimationFrame(frame); frame = 0;
    if (start?.direction) applyPosition();
    start = null; settling = true; suppressClickUntil = performance.now() + 650;
    const token = ++generation;
    dialog.classList.remove('swiping'); dialog.classList.add('swipe-settling');
    const from = axis === 'down' ? `translate3d(0,${position}px,0)` : `translate3d(${position}px,0,0)`;
    const size = axis === 'down' ? surface.clientHeight : surface.clientWidth;
    const target = direction ? size + 30 : 0;
    const to = axis === 'down' ? `translate3d(0,${target}px,0)` : `translate3d(${target}px,0,0)`;
    dialog.style.setProperty('--swipe-progress', direction ? '1' : '0');
    if (!reducedMotion()) {
      animation = surface.animate([{ transform: from }, { transform: to }], { duration: direction ? 260 : 300, easing: 'cubic-bezier(.22,.75,.2,1)', fill: 'forwards' });
      try { await animation.finished; } catch { return; }
    }
    if (token !== generation || !dialog.open) return;
    if (direction === 'down') close();
    else if (direction === 'right') back();
    reset();
  }
  function end(x, y) {
    if (!start || settling) return;
    if (!start.direction) { start = null; return; }
    settle(completedSwipe(state(x, y)));
  }
  function cancelGesture() { if (start?.direction) settle(null); else start = null; }
  dialog.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { cancelGesture(); return; }
    begin(e, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  dialog.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) { cancelGesture(); return; }
    move(e, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  dialog.addEventListener('touchend', e => { if (e.changedTouches[0]) end(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: true });
  dialog.addEventListener('touchcancel', cancelGesture);
  dialog.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) begin(e, e.clientX, e.clientY); });
  window.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && e.buttons === 1) move(e, e.clientX, e.clientY); });
  window.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') end(e.clientX, e.clientY); });
  dialog.addEventListener('pointercancel', cancelGesture);
  dialog.addEventListener('close', reset);
  dialog.addEventListener('click', e => { if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  return { goBack: () => settle('right'), dismiss: () => settle('down') };
}
