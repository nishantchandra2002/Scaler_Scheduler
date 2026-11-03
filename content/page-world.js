// =============================================
// Scaler Class Scheduler - runs inside the page (MAIN world) at document_start.
// Lets the Scaler page keep working normally while its tab is in the background:
//  - The page always sees itself as visible (no "pause when hidden" logic).
//  - requestAnimationFrame, which Chrome stops in hidden tabs, gets a timer
//    fallback so dropdowns, calendars and modals still open and position.
// Only changes behaviour while the tab is actually hidden.
// =============================================
(() => {
  'use strict';
  if (window.__sstSchedulerPageWorld) return;
  window.__sstSchedulerPageWorld = true;

  const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const realHidden = () => (hiddenDesc && hiddenDesc.get ? hiddenDesc.get.call(document) : false);

  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(Document.prototype, 'webkitHidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
  } catch (e) { /* ignore */ }

  // Hide visibility / window-blur changes from the page's own listeners.
  document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
  window.addEventListener('blur', e => { if (e.target === window) e.stopImmediatePropagation(); }, true);

  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let nextId = 1;

  window.requestAnimationFrame = function (cb) {
    const id = nextId++;
    const entry = { done: false, raf: 0, timer: 0 };
    const run = t => {
      if (entry.done) return;
      entry.done = true;
      pending.delete(id);
      nativeCAF(entry.raf);
      clearTimeout(entry.timer);
      cb(t);
    };
    entry.raf = nativeRAF(run);
    // In a hidden tab rAF never fires; fall back to a timer.
    if (realHidden()) entry.timer = setTimeout(() => run(performance.now()), 16);
    pending.set(id, entry);
    return id;
  };

  window.cancelAnimationFrame = function (id) {
    const entry = pending.get(id);
    if (!entry) return;
    entry.done = true;
    nativeCAF(entry.raf);
    clearTimeout(entry.timer);
    pending.delete(id);
  };
})();
