(() => {
  'use strict';
  if (window.__sstSchedulerLoaded) return;
  window.__sstSchedulerLoaded = true;

  const PAGE_URL = 'https://www.scaler.com/scm/classes/schedule-classes';
  const K = {
    run: 'schedRun',        
    logs: 'schedLogs',      
    stop: 'schedStop',    
    lock: 'schedLock',       
    history: 'schedHistory',
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // "November 2026", "November2026", "Nov 2026", "November, 2026"
  const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*(\d{4})$/i;
  const MONTH_ONLY_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
  const WEEKDAY_RE = /^(su|mo|tu|we|th|fr|sa|sun|mon|tue|wed|thu|fri|sat)$/i;
  const monthIndex = abbr => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(abbr.toLowerCase()) + 1;
  const DATE_TEXT_RE = /^\d{1,2} [A-Z][a-z]{2} \d{4}$/;
  const TIME_TEXT_RE = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;
  const ERROR_RE = /error|fail|already|clash|conflict|unable|not available|unavailable|invalid|overlap|exists|cannot|can't|not allowed/i;
  const TAB_ID = Math.random().toString(36).slice(2);

  //Storage + logging

  const store = {
    get: keys => new Promise(r => chrome.storage.local.get(keys, r)),
    set: obj => new Promise(r => chrome.storage.local.set(obj, r)),
    remove: keys => new Promise(r => chrome.storage.local.remove(keys, r)),
  };

  let stopRequested = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[K.stop]) stopRequested = !!changes[K.stop].newValue;
  });

  let logChain = Promise.resolve();
  function log(msg, type = 'info') {
    console.log(`[SST Scheduler] ${msg}`);
    logChain = logChain.then(async () => {
      const d = await store.get(K.logs);
      const logs = d[K.logs] || [];
      logs.push({ t: Date.now(), type, msg });
      if (logs.length > 3000) logs.splice(0, logs.length - 3000);
      await store.set({ [K.logs]: logs });
    }).catch(() => {});
    return logChain;
  }

  // Generic helpers 

  class StopError extends Error {}
  // In a background tab Chrome throttles setTimeout (1/sec, then 1/min after ~5 min).
  // There, wait on the extension's service worker instead, which is not throttled.
  let lastBeat = 0;
  function sleep(ms) {
    if (heartbeatOn && Date.now() - lastBeat > 3000) {
      lastBeat = Date.now();
      store.set({ [K.lock]: { owner: TAB_ID, ts: lastBeat } });
    }
    if (!document.hidden) return new Promise(r => setTimeout(r, ms));
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        chrome.runtime.sendMessage({ action: 'tick', ms }, () => { void chrome.runtime.lastError; finish(); });
      } catch (e) { /* extension reloaded */ }
      setTimeout(finish, ms + 50); // safety net
    });
  }
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const loose = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9@]+/g, ' ').trim();

  function checkStop() {
    if (stopRequested) throw new StopError('Stopped by user.');
  }

  async function waitFor(fn, timeout = 10000, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      checkStop();
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
  }

  function triggerClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Deepest elements whose full text satisfies `match`.
  function findTextEls(root, match, { visibleOnly = true } = {}) {
    const out = [];
    for (const el of (root || document).querySelectorAll('*')) {
      if (el.closest('script,style,noscript')) continue;
      const t = clean(el.textContent);
      if (!t || !match(t)) continue;
      if (Array.from(el.children).some(c => match(clean(c.textContent)))) continue;
      if (visibleOnly && !isVisible(el)) continue;
      out.push(el);
    }
    return out;
  }

  const byText = (root, text) => findTextEls(root, t => t === text);
  const byLooseText = (root, text) => findTextEls(root, t => loose(t) === loose(text));

  // Finds a clickable element by its visible label, whatever it is built from.
  // Exact text compare (case-insensitive), so "Confirm Schedule" never matches "Confirm & Schedule".
  function findButton(label, root = document) {
    const want = clean(label).toLowerCase();
    const same = el => clean(el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase() === want;
    const direct = Array.from(root.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'))
      .filter(isVisible)
      .find(same);
    if (direct) return direct;
    const textEl = findTextEls(root, t => t.toLowerCase() === want).find(el => !el.closest('[contenteditable="true"]'));
    if (!textEl) return null;
    return textEl.closest('button, [role="button"], a')
      || nearestAncestor(textEl, a => {
        const cs = getComputedStyle(a);
        return cs.cursor === 'pointer' || /btn|button/i.test(String(a.className));
      }, 4)
      || textEl;
  }

  function nearestAncestor(el, pred, maxDepth = 12) {
    let cur = el;
    for (let i = 0; i < maxDepth && cur && cur !== document.body; i++) {
      if (pred(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  const CHECKBOX_SEL = 'input[type="checkbox"], [role="checkbox"]';
  const TEXT_INPUT_SEL = 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])';

  function isChecked(cb) {
    return cb.matches('input') ? cb.checked : cb.getAttribute('aria-checked') === 'true';
  }

  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
  }

  async function setChecked(cb, want, label) {
    if (isChecked(cb) === want) return;
    if (isDisabled(cb)) throw new Error(`Checkbox "${label}" is disabled.`);
    const targets = [cb, cb.closest('label'), cb.parentElement].filter(Boolean);
    for (const t of targets) {
      if (t === cb) cb.click(); else triggerClick(t);
      if (await waitFor(() => isChecked(cb) === want, 1500)) return;
    }
    throw new Error(`Could not ${want ? 'tick' : 'untick'} "${label}".`);
  }

 

  // From any element inside a select (e.g. its placeholder), find the select.
  function selectFrom(el) {
    const holder = nearestAncestor(el, a => a.querySelector(TEXT_INPUT_SEL), 6);
    if (!holder) return null;
    const input = holder.querySelector(TEXT_INPUT_SEL);
    const container = input.closest('[class*="container"]') || holder;
    const control = container.querySelector('[class*="control"]') || holder;
    return { container, control, input };
  }

  function findSelectByPlaceholder(root, placeholder) {
    const el = byText(root, placeholder)[0]
      || Array.from(root.querySelectorAll(`input[placeholder="${placeholder}"]`)).find(isVisible);
    return el ? selectFrom(el) : null;
  }

  function selectedText(sel) {
    // Text shown in the control, minus what is being typed.
    return clean(sel.container.textContent);
  }

  // Class-based option lookup (react-select and similar libraries).
  function menuOptions(sel) {
    const OPT = '[role="option"], [id*="-option-"], [class*="-option"], [class*="__option"], [class*="_option"], [class*="Option"]';
    const scopes = [];
    const ownMenu = sel?.container.querySelector('[class*="menu"]');
    if (ownMenu) scopes.push(ownMenu);
    scopes.push(document);
    for (const scope of scopes) {
      let opts = Array.from(scope.querySelectorAll(OPT)).filter(isVisible);
      opts = opts.filter(o => !opts.some(p => p !== o && p.contains(o)));
      opts = opts.filter(o => {
        const t = loose(o.textContent);
        return t && t.length < 200 && !/^(loading|no options|no option|type at ?least|no results)/.test(t);
      });
      if (opts.length) return opts;
    }
    return [];
  }

  // Class-independent lookup: text elements in the dropdown area just below the field,
  // that are on top (not covered by the menu) and are not another field's current value.
  function areaTextEls(sel, pred) {
    const r = sel.control.getBoundingClientRect();
    return findTextEls(document, pred)
      .filter(el => {
        if (sel.control.contains(el) || sel.input === el) return false;
        const e = el.getBoundingClientRect();
        if (e.top < r.bottom - 6 || e.top > r.bottom + 560) return false;
        if (e.right < r.left - 40 || e.left > r.right + 300) return false;
        if (nearestAncestor(el, a => a.querySelector(TEXT_INPUT_SEL), 2)) return false;
        const cx = Math.min(Math.max(e.left + Math.min(8, e.width / 2), 0), innerWidth - 1);
        const cy = e.top + e.height / 2;
        if (cy >= 0 && cy < innerHeight) {
          const top = document.elementFromPoint(cx, cy);
          if (top && !(el.contains(top) || top.contains(el))) return false;
        }
        return true;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  // matcher = { el: option element -> bool, text: text -> bool }
  function findOption(sel, matcher) {
    const hit = menuOptions(sel).find(matcher.el);
    if (hit) return hit;
    return areaTextEls(sel, matcher.text)[0] || null;
  }

  function seenOptions(sel) {
    const fromClasses = menuOptions(sel).map(o => clean(o.textContent));
    const fromArea = areaTextEls(sel, t => t.length < 120).map(e => clean(e.textContent));
    return Array.from(new Set(fromClasses.concat(fromArea))).slice(0, 10);
  }

  function menuIsLoading() {
    return findTextEls(document, t => /^loading/i.test(t)).length > 0;
  }

  // Works even when the browser window is not focused (you are in another window/app):
  // there, a click does not fire focus events, so we send them ourselves.
  async function openSelect(sel) {
    sel.container.scrollIntoView({ block: 'center' });
    await sleep(100);
    triggerClick(sel.control);
    sel.input.focus();
    if (!document.hasFocus()) {
      sel.input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      sel.input.dispatchEvent(new FocusEvent('focus'));
    }
    await sleep(250);
    if (!seenOptions(sel).length && !menuIsLoading()) {
      sel.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true }));
      await sleep(200);
    }
  }

  function closeMenus(sel) {
    sel?.input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    sel?.input?.blur();
  }

  async function pickOption(option) {
    option.scrollIntoView({ block: 'nearest' });
    await sleep(80);
    triggerClick(option);
    await sleep(300);
  }

  // Types like a person: one character at a time with key events.
  async function typeSlowly(input, text) {
    input.focus();
    setNativeValue(input, '');
    let value = '';
    for (const ch of text) {
      value += ch;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      const proto = HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(35);
    }
  }

  // Type each query in turn; wait for a matching option; click it.
  function pressEnter(input) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // verify(): returns true once the right value shows in the field (used for the Enter fallback).
  // enterGuard(): extra condition that must hold before Enter is pressed.
  async function typeAndPick(sel, queries, matcher, timeout = 12000, verify = null, enterGuard = null) {
    let seen = [];
    for (const query of [].concat(queries)) {
      for (const slow of [false, true]) {
        await openSelect(sel);
        if (slow) await typeSlowly(sel.input, query); else setNativeValue(sel.input, query);
        const option = await waitFor(() => {
          if (menuIsLoading()) return null;
          const s = seenOptions(sel);
          if (s.length) seen = s;
          return findOption(sel, matcher);
        }, slow ? timeout : Math.min(timeout, 7000), 200);
        if (option) {
          await pickOption(option);
          if (!verify || await waitFor(verify, 2500)) return { ok: true, seen, query };
          log('Clicking the option did not select it; trying Enter…', 'warn');
          await openSelect(sel);
          setNativeValue(sel.input, query);
          await waitFor(() => !menuIsLoading() && findOption(sel, matcher), 6000);
        }
        // Fallback: Enter picks the highlighted (first) result. Only with the full name/email
        // (queries[0]), and only accepted if verify() confirms the right value got selected.
        if (verify && query === [].concat(queries)[0] && (!enterGuard || enterGuard())) {
          sel.input.focus();
          pressEnter(sel.input);
          if (await waitFor(verify, 2500)) {
            log(`Selected with Enter: "${query}"`, 'info');
            return { ok: true, seen, query };
          }
        }
        // If the dropdown showed real results for this query, retyping it slowly won't help.
        if (seen.some(t => !/type at ?least|no options|no results/i.test(t))) break;
      }
      setNativeValue(sel.input, '');
    }
    return { ok: false, seen };
  }

  // True if the option (or any element inside it) reads exactly `text` (loosely).
  // Handles options like "SST IPS 2030 Batch D  [Secondary]".
  function optionIs(option, text) {
    const want = loose(text);
    if (loose(option.textContent) === want) return true;
    return Array.from(option.querySelectorAll('*')).some(el => loose(el.textContent) === want);
  }

  const exactMatcher = text => ({ el: o => optionIs(o, text), text: t => loose(t) === loose(text) });

  // "SST IPS 2030 Batch A" -> ["SST IPS 2030 Batch A", "SST IPS 2030", "SST"]
  function searchQueries(name) {
    const words = clean(name).split(' ');
    return [clean(name), words.slice(0, 3).join(' '), words[0]]
      .filter((q, i, a) => q.length >= 3 && a.indexOf(q) === i);
  }



  function findOpenCalendar() {
    // 1) A header like "November 2026" above a grid of days.
    for (const head of findTextEls(document, t => MONTH_RE.test(t))) {
      let root = head.parentElement;
      for (let i = 0; i < 6 && root; i++, root = root.parentElement) {
        if (dayCells(root).length >= 28) {
          const [, mon, year] = clean(head.textContent).match(MONTH_RE);
          return { root, head, month: monthIndex(mon.slice(0, 3)), year: +year };
        }
      }
    }
  
    for (const wd of findTextEls(document, t => WEEKDAY_RE.test(t))) {
      let root = wd.parentElement;
      for (let i = 0; i < 7 && root; i++, root = root.parentElement) {
        if (dayCells(root).length < 28) continue;
        const leafs = Array.from(root.querySelectorAll('*')).filter(e => isVisible(e) && e.children.length === 0);
        const values = Array.from(root.querySelectorAll('select, input')).map(e => (e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : e.value) || '');
        const texts = leafs.map(e => clean(e.textContent)).concat(values.map(clean));
        const monText = texts.find(t => MONTH_ONLY_RE.test(t));
        const yearText = texts.find(t => /^\d{4}$/.test(t));
        if (monText && yearText) {
          const head = leafs.find(e => clean(e.textContent) === monText) || wd;
          return { root, head, month: monthIndex(monText.slice(0, 3)), year: +yearText };
        }
      }
    }
    return null;
  }

  function describeCalendarState(field) {
    const f = field ? `${field.tagName.toLowerCase()}${field.type ? `[type=${field.type}]` : ''}${field.readOnly ? '[readonly]' : ''} placeholder="${field.placeholder || ''}" class="${String(field.className).slice(0, 60)}"` : 'none';
    const months = findTextEls(document, t => MONTH_RE.test(t) || MONTH_ONLY_RE.test(t)).slice(0, 4).map(e => clean(e.textContent));
    const weekdays = findTextEls(document, t => WEEKDAY_RE.test(t)).length;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="calendar" i], [class*="picker" i], [class*="popover" i]')).filter(isVisible).slice(0, 3).map(e => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)}`);
    return `Field: ${f}. Month texts on page: ${months.join(', ') || 'none'}. Weekday labels: ${weekdays}. Popups: ${dialogs.join(', ') || 'none'}.`;
  }

  function dayCells(root) {
    return Array.from(root.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && /^\d{1,2}$/.test(clean(el.textContent)) && isVisible(el));
  }

  function dayLooksDisabled(el) {
    let cur = el;
    for (let i = 0; i < 3 && cur; i++, cur = cur.parentElement) {
      if (isDisabled(cur)) return true;
      if (/disabled|outside|other-month|othermonth/i.test(String(cur.className))) return true;
      if (getComputedStyle(cur).pointerEvents === 'none') return true;
    }
    return false;
  }

  function calendarNav(cal) {
    const headRect = cal.head.getBoundingClientRect();
    const days = new Set(dayCells(cal.root));
    const cands = Array.from(cal.root.querySelectorAll('button, [role="button"], svg'))
      .filter(isVisible)
      .filter(el => !days.has(el) && !el.contains(cal.head) && !cal.head.contains(el))
      .map(el => (el.tagName.toLowerCase() === 'svg' ? (el.closest('button,[role="button"]') || el.parentElement) : el))
      .filter((el, i, arr) => el && arr.indexOf(el) === i)
      .filter(el => !/^\d{1,2}$/.test(clean(el.textContent)))
      .filter(el => Math.abs(el.getBoundingClientRect().top - headRect.top) < 40);
    cands.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const byLabel = re => Array.from(cal.root.querySelectorAll('button, [role="button"]')).find(b => re.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`));
    return {
      prev: byLabel(/prev|previous|back/i) || cands[0] || null,
      next: byLabel(/next|forward/i) || cands[cands.length - 1] || null,
    };
  }

  async function goToMonth(target) {
    for (let step = 0; step < 36; step++) {
      const cal = findOpenCalendar();
      if (!cal) throw new Error('Calendar closed unexpectedly.');
      const diff = (target.y * 12 + target.m) - (cal.year * 12 + cal.month);
      if (diff === 0) return cal;
      const { prev, next } = calendarNav(cal);
      const btn = diff > 0 ? next : prev;
      if (!btn) throw new Error('Could not find the calendar month arrows.');
      const before = clean(cal.head.textContent);
      triggerClick(btn);
      if (!(await waitFor(() => { const c = findOpenCalendar(); return c && clean(c.head.textContent) !== before; }, 2000))) {
        btn.click();
        await waitFor(() => { const c = findOpenCalendar(); return c && clean(c.head.textContent) !== before; }, 2000);
      }
    }
    throw new Error(`Could not navigate the calendar to ${MONTHS[target.m - 1]} ${target.y}.`);
  }

  function dayCandidates(cal, day) {
    const all = dayCells(cal.root).filter(el => clean(el.textContent) === String(day));
    // If a grid shows trailing/leading days of other months, early days are first, late days last.
    const ordered = day <= 14 ? all : all.slice().reverse();
    return ordered.map(el => el.closest('button,[role="button"],[role="gridcell"],td') || el);
  }

  // Opens a calendar: focus the field (many pickers open on focus), then click each target.
  async function openCalendar(openTargets) {
    const targets = openTargets.filter((t, i, a) => t && a.indexOf(t) === i);
    for (const t of targets) {
      t.scrollIntoView({ block: 'center' });
      if (t.matches('input')) {
        t.focus();
        t.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        t.dispatchEvent(new FocusEvent('focus'));
        const cal = await waitFor(() => findOpenCalendar(), 700);
        if (cal) return cal;
      }
      triggerClick(t);
      let cal = await waitFor(() => findOpenCalendar(), 1200);
      if (cal) return cal;
      if (t.matches('input')) {
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
        cal = await waitFor(() => findOpenCalendar(), 700);
        if (cal) return cal;
      }
    }
    return null;
  }

  // Parts of a date field worth clicking: the field, its calendar icon, and its box.
  function dateFieldTargets(field) {
    const box = nearestAncestor(field, a => a !== field && a.querySelector('svg, img, button, i'), 4);
    const icon = box && Array.from(box.querySelectorAll('svg, img, button, i')).filter(isVisible).pop();
    const iconClickable = icon && (icon.closest('button, [role="button"]') || icon.parentElement);
    return [field, iconClickable, icon, box, field.parentElement];
  }


  async function waitForPage() {
    const ok = await waitFor(() => findSelectByPlaceholder(document, 'Select Batch/es') || byText(document, 'Batch and Library')[0], 30000);
    if (!ok) throw new Error('Schedule Classes page did not load (no "Select Batch/es" field). Are you logged in?');
    await sleep(500);
  }

  function batchAndLibrarySelects() {
    const label = byText(document, 'Batch and Library')[0];
    if (!label) return [];
    const section = nearestAncestor(label, a => a.querySelectorAll(TEXT_INPUT_SEL).length >= 2, 6);
    if (!section) return [];
    return Array.from(section.querySelectorAll(TEXT_INPUT_SEL)).slice(0, 2).map(selectFrom);
  }

  async function selectBatch(name) {
    const sel = findSelectByPlaceholder(document, 'Select Batch/es') || batchAndLibrarySelects()[0];
    if (!sel) throw new Error('Could not find the "Select Batch/es" dropdown.');
    const want = loose(name);
    // Chip reads the batch name, possibly followed by a remove "×".
    const batchChosen = () => findTextEls(sel.container, t => {
      const l = loose(t);
      return l === want || (l.startsWith(`${want} `) && l.length <= want.length + 3);
    }).length > 0;
    const res = await typeAndPick(sel, [clean(name)].concat(searchQueries(name)), exactMatcher(name), 15000, batchChosen);
    if (!res.ok) {
      throw new Error(`Batch "${name}" not found in the batch dropdown. ${res.seen.length ? `Dropdown showed: ${res.seen.join(' | ')}` : 'The dropdown showed nothing after typing.'}`);
    }
    const ok = await waitFor(batchChosen, 4000);
    closeMenus(sel);
    if (!ok) throw new Error(`Batch "${name}" was clicked but did not show as selected.`);
    log(`✓ Batch: ${name}`, 'success');
  }

  async function selectLibrary(name) {
    const sel = findSelectByPlaceholder(document, 'Select A Library') || batchAndLibrarySelects()[1];
    if (!sel) throw new Error('Could not find the "Select A Library" dropdown.');
    const libChosen = () => loose(sel.container.textContent).includes(loose(name));
    const res = await typeAndPick(sel, searchQueries(name), exactMatcher(name), 15000, libChosen);
    if (!res.ok) {
      throw new Error(`Library "${name}" not found. ${res.seen.length ? `Dropdown showed: ${res.seen.join(' | ')}` : 'The dropdown showed nothing after typing.'}`);
    }
    if (!(await waitFor(() => loose(selectedText(sel)).includes(loose(name)), 4000))) {
      throw new Error(`Library "${name}" was clicked but did not show as selected.`);
    }
    closeMenus(sel);
    log(`✓ Library: ${name}`, 'success');
  }

  async function waitForLectures() {
    const ok = await waitFor(() => byText(document, 'Select All')[0], 20000);
    if (!ok) throw new Error('The Lectures table did not load after choosing the library.');
    await sleep(600);
  }

  async function tickOffline() {
    const label = byText(document, 'Schedule as offline classes')[0];
    if (!label) throw new Error('Could not find "Schedule as offline classes".');
    const holder = nearestAncestor(label, a => a.querySelectorAll(CHECKBOX_SEL).length >= 1, 4);
    const cb = holder?.querySelector(CHECKBOX_SEL);
    if (!cb) throw new Error('Could not find the "Schedule as offline classes" checkbox.');
    await setChecked(cb, true, 'Schedule as offline classes');
    await sleep(500);
    log('✓ Offline classes ticked', 'success');
  }

  // "Same for all" would copy one row's instructor to every row. Turn it off.
  // The checkbox sits just right of (or just below) its label; pick the closest one by position.
  function checkboxNear(label) {
    const r = label.getBoundingClientRect();
    let best = null;
    let bestDist = Infinity;
    for (const cb of document.querySelectorAll(CHECKBOX_SEL)) {
      const target = isVisible(cb) ? cb : cb.parentElement;
      if (!target || !isVisible(target)) continue;
      const c = target.getBoundingClientRect();
      const dx = c.left - r.right;
      const dy = Math.abs((c.top + c.height / 2) - (r.top + r.height / 2));
      if (dy < 14 && dx > -6 && dx < 60) {
        const dist = dx + dy;
        if (dist < bestDist) { best = cb; bestDist = dist; }
      }
    }
    return best;
  }

  async function untickSameForAll() {
    for (const el of byLooseText(document, 'Same for all')) {
      const cb = checkboxNear(el);
      if (cb && isChecked(cb)) {
        await setChecked(cb, false, 'Same for all');
        log('↺ Unticked a "Same for all" box', 'info');
      }
    }
  }

  function isInsideModal(el) {
    return !!el.closest('[role="dialog"], [class*="modal" i], [class*="Modal"]');
  }

  // The lectures-table row for a class, matched on exact (case-sensitive) name.
  function findTableRow(name) {
    const hits = byText(document, clean(name)).filter(el => !isInsideModal(el));
    const rows = hits
      .map(el => nearestAncestor(el, a => a.querySelector(CHECKBOX_SEL) && a.querySelector(TEXT_INPUT_SEL), 8))
      .filter((r, i, arr) => r && arr.indexOf(r) === i);
    if (rows.length > 1) throw new Error(`Class "${name}" appears ${rows.length} times in the table; cannot tell which one to use.`);
    return rows[0] || null;
  }

  function allTableClassNames() {
    const selectAll = byText(document, 'Select All')[0];
    const table = selectAll && nearestAncestor(selectAll, a => a.querySelectorAll(CHECKBOX_SEL).length > 4, 8);
    if (!table) return [];
    const names = [];
    for (const cb of table.querySelectorAll(CHECKBOX_SEL)) {
      const row = nearestAncestor(cb, a => a.querySelector(TEXT_INPUT_SEL), 6);
      const first = row && Array.from(row.querySelectorAll('*')).find(el => el.children.length === 0 && clean(el.textContent));
      if (first) names.push(clean(first.textContent));
    }
    return names.filter(n => n && n !== 'Select All' && n !== 'Same for all');
  }

  function rowSelect(row, placeholder, fallbackIndex) {
    const byPh = findSelectByPlaceholder(row, placeholder);
    if (byPh) return byPh;
    const inputs = Array.from(row.querySelectorAll(TEXT_INPUT_SEL));
    const input = fallbackIndex < 0 ? inputs[inputs.length + fallbackIndex] : inputs[fallbackIndex];
    return input ? selectFrom(input) : null;
  }

  function emailsInDropdown(sel) {
    const texts = menuOptions(sel).map(o => o.textContent).concat(areaTextEls(sel, t => t.includes('@')).map(e => e.textContent));
    const found = texts.join(' ').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
    return Array.from(new Set(found));
  }

  function instructorShown(row) {
    const sel = row && rowSelect(row, 'Primary Instructor', 0);
    const t = sel ? clean(sel.control.textContent) : '';
    return t === 'Primary Instructor' ? '' : t;
  }

  // Picks the instructor whose EMAIL matches the CSV (names can be duplicated).
  async function setInstructor(row, cls) {
    const sel = rowSelect(row, 'Primary Instructor', 0);
    if (!sel) throw new Error(`"${cls.name}": Primary Instructor field not found.`);
    const email = cls.email.toLowerCase();
    const local = email.split('@')[0];
    const queries = [email, local, local.replace(/[._-]+/g, ' ')].filter((q, i, arr) => arr.indexOf(q) === i);
    // Option must contain the exact email (not just the name).
    const matcher = {
      el: o => (o.textContent.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []).includes(email),
      text: t => (t.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []).includes(email),
    };
    const before = instructorShown(row);
    const chosen = () => { const now = instructorShown(row); return !!now && (now !== before || !before); };
    // Enter only if the dropdown lists exactly one person and it is this email.
    const onlyThisEmail = () => { const e = emailsInDropdown(sel); return e.length === 1 && e[0] === email; };
    const res = await typeAndPick(sel, queries, matcher, 8000, chosen, onlyThisEmail);
    if (res.ok) {
      const shown = instructorShown(row);
      if (!shown) throw new Error(`"${cls.name}": instructor ${cls.email} was clicked but not set.`);
      return shown;
    }
    closeMenus(sel);
    throw new Error(`"${cls.name}": instructor ${cls.email} not found. ${res.seen.length ? `Dropdown showed: ${res.seen.join(' | ')}` : 'The dropdown showed nothing after typing.'}`);
  }

  // The "Same for all" checkbox that sits in the Primary Instructor column.
  function instructorSameForAll(sampleRow) {
    const sel = rowSelect(sampleRow, 'Primary Instructor', 0);
    if (!sel) return null;
    const colLeft = sel.control.getBoundingClientRect().left;
    let best = null;
    let bestDx = Infinity;
    for (const label of byLooseText(document, 'Same for all')) {
      const cb = checkboxNear(label);
      if (!cb) continue;
      const dx = Math.abs(label.getBoundingClientRect().left - colLeft);
      if (dx < bestDx) { best = cb; bestDx = dx; }
    }
    return bestDx < 150 ? best : null;
  }

  async function setClassroom(row, cls) {
    const sel = rowSelect(row, 'Classroom', -1);
    if (!sel) throw new Error(`"${cls.name}": Classroom field not found. Is "Schedule as offline classes" ticked?`);
    const matcher = exactMatcher(cls.classroom);

    // 1) open and look through the full list
    await openSelect(sel);
    let seen = [];
    let option = await waitFor(() => {
      const s = seenOptions(sel);
      if (s.length) seen = s;
      return findOption(sel, matcher);
    }, 4000, 200);

    // 2) type to filter (if the dropdown is searchable)
    if (!option && !sel.input.readOnly) {
      setNativeValue(sel.input, cls.classroom);
      option = await waitFor(() => {
        const s = seenOptions(sel);
        if (s.length) seen = s;
        return findOption(sel, matcher);
      }, 6000, 200);
    }

    if (!option) {
      closeMenus(sel);
      throw new Error(`"${cls.name}": classroom "${cls.classroom}" not in the list.${seen.length ? ` Dropdown showed: ${seen.join(' | ')}` : ''}`);
    }
    await pickOption(option);
    if (!(await waitFor(() => loose(selectedText(sel)).includes(loose(cls.classroom)), 3000))) {
      throw new Error(`"${cls.name}": classroom "${cls.classroom}" was clicked but not set.`);
    }
  }

  async function fillTable(classes) {
    // Pre-flight: every class must exist exactly once and be selectable.
    const missing = [];
    const rows = new Map();
    for (const cls of classes) {
      checkStop();
      const row = findTableRow(cls.name);
      if (!row) { missing.push(cls.name); continue; }
      const cb = row.querySelector(CHECKBOX_SEL);
      if (isDisabled(cb)) throw new Error(`"${cls.name}" is already scheduled for this batch (its checkbox is disabled).`);
      if (isChecked(cb)) throw new Error(`"${cls.name}" is already ticked on a fresh page — it may already be scheduled. Stopping.`);
      rows.set(cls.name, row);
    }
    if (missing.length) {
      const available = allTableClassNames();
      throw new Error(
        `Not in this library's table (name must match exactly, or the class is already scheduled): ${missing.map(m => `"${m}"`).join(', ')}.`
        + (available.length ? ` Table has: ${available.join(' | ')}` : '')
      );
    }

    // 1) Tick every class.
    for (const cls of classes) {
      checkStop();
      const row = findTableRow(cls.name) || rows.get(cls.name);
      row.scrollIntoView({ block: 'center' });
      await setChecked(row.querySelector(CHECKBOX_SEL), true, cls.name);
      await sleep(150);
    }
    log(`✓ Ticked ${classes.length} class(es)`, 'success');

    // 2) Instructors: set the most common one once, copy with "Same for all", then set the rest.
    const counts = new Map();
    for (const c of classes) counts.set(c.email.toLowerCase(), (counts.get(c.email.toLowerCase()) || 0) + 1);
    const mainEmail = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    const mainGroup = classes.filter(c => c.email.toLowerCase() === mainEmail);
    const others = classes.filter(c => c.email.toLowerCase() !== mainEmail);

    const first = mainGroup[0];
    const mainName = await setInstructor(findTableRow(first.name), first);
    first.instructorName = mainName;
    log(`✓ Instructor ${mainName} (${first.email}) set on "${first.name}"`, 'success');

    let copied = false;
    if (mainGroup.length > 1) {
      const sameCb = instructorSameForAll(findTableRow(first.name));
      if (sameCb) {
        await setChecked(sameCb, true, 'Same for all (Primary Instructor)');
        copied = !!(await waitFor(() => mainGroup.every(c => instructorShown(findTableRow(c.name)) === mainName), 5000));
        if (copied) log(`✓ "Same for all" copied ${mainName} to ${mainGroup.length} classes`, 'success');
        else log('"Same for all" did not copy to every class; setting them one by one', 'warn');
        if (others.length) {
          await setChecked(sameCb, false, 'Same for all (Primary Instructor)');
          await sleep(500);
          if (copied && !mainGroup.every(c => instructorShown(findTableRow(c.name)) === mainName)) {
            copied = false;
            log('Unticking "Same for all" cleared the copies; setting them one by one', 'warn');
          }
        }
      } else {
        log('Could not find "Same for all" under Primary Instructor; setting instructors one by one', 'warn');
      }
    }

    for (const cls of classes) {
      checkStop();
      if (cls === first) continue;
      if (copied && mainGroup.includes(cls)) { cls.instructorName = mainName; continue; }
      const name = await setInstructor(findTableRow(cls.name), cls);
      cls.instructorName = name;
      log(`✓ Instructor ${name} (${cls.email}) set on "${cls.name}"`, 'success');
    }

    // 3) Classrooms, one per class.
    for (const cls of classes) {
      checkStop();
      const row = findTableRow(cls.name);
      row.scrollIntoView({ block: 'center' });
      await setClassroom(row, cls);
      log(`✓ ${cls.name} — ${cls.instructorName}, ${cls.classroom}`, 'success');
    }

    // Re-verify (catches re-renders or "same for all" overwriting values).
    for (const cls of classes) {
      const row = findTableRow(cls.name);
      if (!row || !isChecked(row.querySelector(CHECKBOX_SEL))) throw new Error(`"${cls.name}" got unticked after filling.`);
      if (!loose(row.textContent).includes(loose(cls.classroom))) throw new Error(`"${cls.name}" lost its classroom after filling.`);
      const shown = instructorShown(row);
      if (shown !== cls.instructorName) {
        throw new Error(`"${cls.name}": instructor shows "${shown || 'empty'}" (expected ${cls.instructorName}, ${cls.email}).`);
      }
    }
  }

  async function chooseScheduleAndStartDate() {
    // The pattern and start date only exist to open the preview; real dates are set there.
    const sel = findSelectByPlaceholder(document, 'Select a schedule');
    if (!sel) throw new Error('Could not find the "Select a schedule" dropdown.');
    await openSelect(sel);
    const SCHED_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*\d{1,2}:\d{2}/;
    const first = await waitFor(() => findOption(sel, { el: o => SCHED_RE.test(clean(o.textContent)), text: t => SCHED_RE.test(t) }), 8000);
    if (!first) throw new Error('The schedule dropdown has no options.');
    await pickOption(first);
    closeMenus(sel);

    const dateField = byText(document, 'Select a date')[0]
      || Array.from(document.querySelectorAll('input[placeholder*="date" i]')).find(el => isVisible(el) && !isInsideModal(el));
    if (!dateField) throw new Error('Could not find the start-date field ("Select a date").');
    if (dateField.matches('input[type="date"]')) {
      const d = new Date(Date.now() + 86400000);
      setNativeValue(dateField, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      dateField.dispatchEvent(new Event('change', { bubbles: true }));
      log('✓ Schedule pattern + start date set (native date input)', 'info');
      return;
    }
    const box = null;
    const cal = await openCalendar(dateFieldTargets(dateField));
    if (!cal) throw new Error(`The start-date calendar did not open. ${describeCalendarState(dateField)}`);

    const isSet = () => !byText(document, 'Select a date').length
      && !Array.from(document.querySelectorAll('input[placeholder*="date" i]')).some(i => isVisible(i) && !i.value && !isInsideModal(i));
    for (let month = 0; month < 3; month++) {
      const c = findOpenCalendar();
      if (!c) break;
      const days = dayCells(c.root).map(el => el.closest('button,[role="button"],[role="gridcell"],td') || el);
      for (const d of days.filter(d => !dayLooksDisabled(d)).concat(days.filter(dayLooksDisabled)).slice(0, 15)) {
        triggerClick(d);
        if (await waitFor(isSet, 800)) {
          log('✓ Schedule pattern + start date picked (dates are overridden in the preview)', 'info');
          await sleep(300);
          return;
        }
        if (!findOpenCalendar()) await openCalendar(dateFieldTargets(dateField));
      }
      const { next } = calendarNav(c);
      if (next) { triggerClick(next); await sleep(400); }
    }
    throw new Error('Could not pick a start date.');
  }

  async function openPreview() {
    const btn = findButton('Confirm Schedule');
    if (!btn) throw new Error('Could not find the "Confirm Schedule" button.');
    if (isDisabled(btn)) throw new Error('"Confirm Schedule" is disabled — a required field is missing.');
    btn.scrollIntoView({ block: 'center' });
    triggerClick(btn);
    const confirm = await waitFor(() => findButton('Confirm & Schedule'), 15000);
    if (!confirm) {
      const msg = readToasts();
      throw new Error(`The preview did not open after "Confirm Schedule".${msg ? ` Page says: ${msg}` : ''}`);
    }
    const modal = currentModal();
    if (!modal) throw new Error('Preview opened but its table was not found.');
    return modal;
  }

  // Re-found every time: React may re-render the modal after each change.
  function currentModal() {
    const confirm = findButton('Confirm & Schedule');
    return confirm ? nearestAncestor(confirm, a => /Proposed Date/i.test(a.textContent), 12) : null;
  }

  function modalRow(modal, name) {
    const hits = byText(modal, clean(name));
    for (const el of hits) {
      const row = nearestAncestor(el, a => {
        const els = Array.from(a.querySelectorAll('*'));
        const hasDate = els.some(e => DATE_TEXT_RE.test(clean(e.textContent)) && e.children.length === 0)
          || Array.from(a.querySelectorAll('input')).some(i => DATE_TEXT_RE.test(clean(i.value)));
        const hasTime = els.some(e => TIME_TEXT_RE.test(clean(e.textContent)) && e.children.length === 0);
        return hasDate && hasTime;
      }, 8);
      if (row && row !== modal) return row;
    }
    return null;
  }

  function rowDateEl(row) {
    return findTextEls(row, t => DATE_TEXT_RE.test(t))[0]
      || Array.from(row.querySelectorAll('input')).find(i => DATE_TEXT_RE.test(clean(i.value)) || /date/i.test(i.placeholder || ''));
  }

  function rowShows(row, text) {
    const values = Array.from(row.querySelectorAll('input')).map(i => i.value).join(' ');
    return clean(`${row.textContent} ${values}`).includes(text);
  }

  async function setModalDate(modal, cls) {
    modal = currentModal() || modal;
    const row = modalRow(modal, cls.name);
    if (rowShows(row, cls.dateText)) return;
    const dateEl = rowDateEl(row);
    if (!dateEl) throw new Error(`Preview: no date field for "${cls.name}".`);
    const cal = await openCalendar(dateFieldTargets(dateEl));
    if (!cal) throw new Error(`Preview: calendar did not open for "${cls.name}". ${describeCalendarState(dateEl)}`);
    await goToMonth(cls.date);
    for (const day of dayCandidates(findOpenCalendar(), cls.date.d)) {
      triggerClick(day);
      const r = await waitFor(() => { const m = currentModal(); const rr = m && modalRow(m, cls.name); return rr && rowShows(rr, cls.dateText); }, 1500);
      if (r) return;
    }
    throw new Error(`Preview: could not set date ${cls.dateText} for "${cls.name}" (the day may be disabled in the calendar).`);
  }

  function parseTimeText(t) {
    const m = clean(t).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let h = +m[1] % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return h * 60 + +m[2];
  }

  async function setModalTime(modal, cls) {
    modal = currentModal() || modal;
    const row = modalRow(modal, cls.name);
    const timeEl = findTextEls(row, t => TIME_TEXT_RE.test(t))[0];
    if (!timeEl) throw new Error(`Preview: no time field for "${cls.name}".`);
    if (parseTimeText(timeEl.textContent) === cls.time) return;

    const sel = selectFrom(timeEl) || { container: timeEl.parentElement, control: timeEl.parentElement, input: null };
    if (sel.input) {
      await openSelect(sel);
    } else {
      sel.container.scrollIntoView({ block: 'center' });
      triggerClick(sel.control);
      await sleep(300);
    }

    const timeMatcher = { el: o => parseTimeText(o.textContent) === cls.time, text: t => parseTimeText(t) === cls.time };
    const findTime = () => findOption(sel, timeMatcher);
    let option = await waitFor(findTime, 1500);

    if (!option && sel.input && !sel.input.readOnly) {
      setNativeValue(sel.input, cls.timeText);
      option = await waitFor(findTime, 2500);
    }

    if (!option) {
      // Virtualised list: scroll through it.
      const anyOpt = menuOptions(sel)[0] || areaTextEls(sel, t => TIME_TEXT_RE.test(t))[0];
      const list = anyOpt && nearestAncestor(anyOpt, a => a.scrollHeight > a.clientHeight + 5, 5);
      if (list) {
        list.scrollTop = 0;
        for (let i = 0; i < 120 && !option; i++) {
          option = findTime();
          if (option) break;
          list.scrollTop += Math.max(60, list.clientHeight * 0.8);
          await sleep(80);
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 2) {
            option = findTime();
            break;
          }
        }
      }
    }

    if (!option) throw new Error(`Preview: time ${cls.timeText} not in the dropdown for "${cls.name}".`);
    await pickOption(option);
    const ok = await waitFor(() => {
      const m = currentModal();
      const rr = m && modalRow(m, cls.name);
      const te = rr && findTextEls(rr, t => TIME_TEXT_RE.test(t))[0];
      return te && parseTimeText(te.textContent) === cls.time;
    }, 3000);
    if (!ok) throw new Error(`Preview: time ${cls.timeText} was clicked but not set for "${cls.name}".`);
  }

  async function fillPreview(modal, classes) {
    const missing = classes.filter(c => !modalRow(modal, c.name)).map(c => c.name);
    if (missing.length) throw new Error(`Preview is missing: ${missing.join(', ')}.`);
    const dateCount = findTextEls(modal, t => DATE_TEXT_RE.test(t)).length;
    if (dateCount > classes.length) {
      throw new Error(`Preview has ${dateCount} classes but the CSV has ${classes.length} for this batch. Stopping so nothing extra is scheduled.`);
    }
    for (const cls of classes) {
      checkStop();
      await setModalDate(modal, cls);
      await setModalTime(modal, cls);
      log(`✓ ${cls.name} → ${cls.dateText}, ${cls.timeText}`, 'success');
    }
    // Final check of every row before submitting.
    modal = currentModal() || modal;
    for (const cls of classes) {
      const row = modalRow(modal, cls.name);
      const te = row && findTextEls(row, t => TIME_TEXT_RE.test(t))[0];
      if (!row || !rowShows(row, cls.dateText) || !te || parseTimeText(te.textContent) !== cls.time) {
        throw new Error(`Preview check failed for "${cls.name}" — expected ${cls.dateText} ${cls.timeText}.`);
      }
      if (cls.instructorName && !rowShows(row, cls.instructorName)) {
        throw new Error(`Preview shows the wrong instructor for "${cls.name}" (expected ${cls.instructorName}).`);
      }
      if (!loose(row.textContent).includes(loose(cls.classroom))) {
        throw new Error(`Preview shows the wrong classroom for "${cls.name}" (expected ${cls.classroom}).`);
      }
    }
  }

  function readToasts() {
    const els = document.querySelectorAll('[role="alert"], [role="status"], [class*="toast" i], [class*="snackbar" i], [class*="notification" i], [class*="notistack" i]');
    const texts = Array.from(els).filter(isVisible).map(e => clean(e.textContent)).filter(Boolean);
    return Array.from(new Set(texts)).join(' | ');
  }

  async function submitPreview() {
    const btn = findButton('Confirm & Schedule');
    if (!btn) throw new Error('"Confirm & Schedule" button disappeared.');
    if (isDisabled(btn)) throw new Error('"Confirm & Schedule" is disabled.');
    const before = readToasts();
    triggerClick(btn);

    const outcome = await waitFor(() => {
      const t = readToasts();
      if (t && t !== before) return { toast: t };
      if (!findButton('Confirm & Schedule')) return { closed: true };
      return null;
    }, 45000, 250);
    await sleep(1500);
    const toast = readToasts();

    if (!outcome) throw new Error('No response 45s after "Confirm & Schedule". Check View Schedule before re-running this batch.');
    if (toast && ERROR_RE.test(toast)) throw new Error(`Scaler rejected the schedule: ${toast}`);
    if (findButton('Confirm & Schedule')) {
      throw new Error(`Preview is still open after submitting.${toast ? ` Page says: ${toast}` : ''} Check the page.`);
    }
    return toast;
  }

  let heartbeat = null;
  let heartbeatOn = false;

  function keepTabLoaded(keep) {
    try { chrome.runtime.sendMessage({ action: 'keepTab', keep }, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
  }

  async function claimLock() {
    const d = await store.get(K.lock);
    const lock = d[K.lock];
    if (lock && lock.owner !== TAB_ID && Date.now() - lock.ts < 12000) return false;
    await store.set({ [K.lock]: { owner: TAB_ID, ts: Date.now() } });
    heartbeatOn = true;
    heartbeat = setInterval(() => store.set({ [K.lock]: { owner: TAB_ID, ts: Date.now() } }), 4000);
    keepTabLoaded(true);
    return true;
  }

  async function releaseLock() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    heartbeatOn = false;
    await store.remove(K.lock);
  }

  async function saveRun(run) {
    await store.set({ [K.run]: run });
  }

  async function finishRun(run, status, message) {
    run.status = status;
    run.phase = 'idle';
    run.endedAt = Date.now();
    run.message = message || '';
    await saveRun(run);
    await logChain;
    const d = await store.get([K.history, K.logs]);
    const history = d[K.history] || [];
    history.unshift({
      id: run.id,
      fileName: run.fileName,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      status,
      message: run.message,
      results: run.results,
      logs: d[K.logs] || [],
    });
    await store.set({ [K.history]: history.slice(0, 20), [K.stop]: false });
    keepTabLoaded(false);
    await releaseLock();
  }

  async function processCurrentBatch(run) {
    const i = run.index;
    const batch = run.batches[i];
    const version = chrome.runtime?.getManifest?.().version;
    log(`━━ Batch ${i + 1}/${run.batches.length}: ${batch.name} (${batch.classes.length} classes)${version ? ` · extension v${version}` : ''}`, 'info');

    run.phase = 'filling';
    run.results[i] = { batch: batch.name, library: batch.library, classes: batch.classes.length, status: 'running', message: '' };
    await saveRun(run);

    await waitForPage();
    await selectBatch(batch.name);
    await selectLibrary(batch.library);
    await waitForLectures();
    await tickOffline();
    await untickSameForAll();
    await fillTable(batch.classes);
    await chooseScheduleAndStartDate();
    const modal = await openPreview();
    log('Preview opened, setting dates and times…', 'info');
    await fillPreview(modal, batch.classes);

    if (run.dryRun) {
      run.results[i] = { ...run.results[i], status: 'dry-run', message: 'Filled, not submitted' };
      await saveRun(run);
      log('🧪 Dry run: everything is filled. Not clicking "Confirm & Schedule". Check the preview on the page.', 'warn');
      await finishRun(run, 'dry-run', `Dry run stopped at batch "${batch.name}" with the preview filled.`);
      return 'stop';
    }

    run.phase = 'submitting';
    await saveRun(run);
    checkStop();
    log('Submitting "Confirm & Schedule"…', 'info');
    const toast = await submitPreview();

    run.results[i] = { ...run.results[i], status: 'success', message: toast || 'Scheduled' };
    run.phase = 'navigating';
    run.index = i + 1;
    await saveRun(run);
    log(`✅ Batch "${batch.name}" scheduled.${toast ? ` (${toast})` : ''}`, 'success');
    return 'next';
  }

  async function main() {
    const d = await store.get([K.run, K.stop]);
    const run = d[K.run];
    stopRequested = !!d[K.stop];
    if (!run || run.status !== 'running') return;
    if (!(await claimLock())) {
      console.log('[SST Scheduler] Another tab is running the schedule; this tab stays idle.');
      return;
    }

    if (run.phase === 'submitting') {
      const b = run.batches[run.index];
      run.results[run.index] = { ...(run.results[run.index] || {}), batch: b.name, status: 'unknown', message: 'Page reloaded during submit' };
      log(`❌ The page reloaded while batch "${b.name}" was being submitted. Check View Schedule to see whether it went through, then start again from the right batch.`, 'error');
      await finishRun(run, 'failed', `Unclear whether batch "${b.name}" was scheduled.`);
      return;
    }

    if (run.index >= run.batches.length) {
      log(`🎉 All ${run.batches.length} batches done.`, 'success');
      await finishRun(run, 'success', 'All batches scheduled.');
      return;
    }

    try {
      checkStop();
      const next = await processCurrentBatch(run);
      if (next !== 'next') return;
      if (run.index >= run.batches.length) {
        log(`🎉 All ${run.batches.length} batches scheduled.`, 'success');
        await finishRun(run, 'success', 'All batches scheduled.');
        return;
      }
      await logChain;
      await releaseLock();
      await sleep(1200);
      checkStop();
      window.location.href = PAGE_URL;
    } catch (err) {
      const b = run.batches[run.index];
      const stopped = err instanceof StopError;
      if (run.index < run.batches.length) {
        run.results[run.index] = { ...(run.results[run.index] || {}), batch: b.name, library: b.library, classes: b.classes.length, status: stopped ? 'stopped' : 'failed', message: err.message };
      }
      if (stopped) {
        log(`⏹ Stopped by you at batch "${b?.name}". Nothing was submitted for it.`, 'warn');
        await finishRun(run, 'stopped', `Stopped at batch "${b?.name}".`);
      } else {
        log(`❌ ${err.message}`, 'error');
        log(`Run stopped at batch ${run.index + 1} ("${b?.name}").${run.phase === 'submitting' ? ' It may have been submitted — check View Schedule.' : ' This batch was NOT submitted.'}`, 'error');
        await finishRun(run, 'failed', err.message);
      }
    }
  }

  // Popup → content: page snapshot for debugging selectors.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === 'snapshot') {
      sendResponse({ html: document.documentElement.outerHTML, url: location.href });
    }
    return false;
  });

  console.log('[SST Scheduler] content script loaded');
  main();
})();
