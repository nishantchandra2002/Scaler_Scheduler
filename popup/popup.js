// Scaler Class Scheduler - popup
// Owns: CSV upload/validation, start/stop, rendering run state from storage.
// The content script owns the run once it starts.

'use strict';

const PAGE_URL = 'https://www.scaler.com/scm/classes/schedule-classes';
const K = { plan: 'schedPlan', run: 'schedRun', logs: 'schedLogs', stop: 'schedStop', lock: 'schedLock', history: 'schedHistory' };
const $ = id => document.getElementById(id);

const store = {
  get: keys => new Promise(r => chrome.storage.local.get(keys, r)),
  set: obj => new Promise(r => chrome.storage.local.set(obj, r)),
  remove: keys => new Promise(r => chrome.storage.local.remove(keys, r)),
};

let plan = null;   // { id, fileName, batches, errors, totalClasses }
let run = null;
let logs = [];

//Small DOM helper
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const fmtClock = t => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const fmtDateTime = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

function reportCSV(results) {
  const lines = [['Batch', 'Library', 'Classes', 'Status', 'Message'].map(csvCell).join(',')];
  for (const r of results || []) lines.push([r.batch, r.library, r.classes, r.status, r.message].map(csvCell).join(','));
  return lines.join('\n');
}

const logText = list => (list || []).map(l => `[${fmtClock(l.t)}] [${l.type.toUpperCase()}] ${l.msg}`).join('\n');

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
  if (tab.dataset.tab === 'history') renderHistory();
}));


const drop = $('drop');
const fileInput = $('file');
drop.addEventListener('click', () => { if (!isRunning()) fileInput.click(); });
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('over');
  if (!isRunning() && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const result = SchedCSV.buildPlan(reader.result, new Date());
    plan = { id: `plan_${Date.now()}`, fileName: file.name, ...result };
    await store.set({ [K.plan]: plan });
    render();
  };
  reader.readAsText(file);
}

$('templateBtn').addEventListener('click', () => download('class_schedule_template.csv', SchedCSV.TEMPLATE, 'text/csv'));


const isRunning = () => run && run.status === 'running';

$('startBtn').addEventListener('click', async () => {
  if (!plan || plan.errors.length || isRunning()) return;
  const startIdx = Number($('startFrom').value) || 0;
  const newRun = {
    id: `run_${Date.now()}`,
    planId: plan.id,
    fileName: plan.fileName,
    status: 'running',
    phase: 'start',
    index: startIdx,
    dryRun: $('dryRun').checked,
    startedAt: Date.now(),
    batches: plan.batches,
    results: plan.batches.map((b, i) => ({
      batch: b.name, library: b.library, classes: b.classes.length,
      status: i < startIdx ? 'skipped' : 'pending', message: '',
    })),
  };
  const firstLog = {
    t: Date.now(), type: 'info',
    msg: `▶ ${newRun.dryRun ? 'Dry run' : 'Run'} started: ${plan.batches.length - startIdx} batch(es) from "${plan.batches[startIdx].name}"`,
  };
  await store.remove(K.lock);
  await store.set({ [K.run]: newRun, [K.logs]: [firstLog], [K.stop]: false });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith(PAGE_URL)) await chrome.tabs.update(tab.id, { url: PAGE_URL });
  else await chrome.tabs.create({ url: PAGE_URL });
});

$('stopBtn').addEventListener('click', async () => {
  await store.set({ [K.stop]: true });
  // If no page is actively running it (tab closed, etc.), close the run here.
  setTimeout(async () => {
    const d = await store.get([K.run, K.lock, K.logs, K.history]);
    const r = d[K.run];
    const lock = d[K.lock];
    if (!r || r.status !== 'running') return;
    if (lock && Date.now() - lock.ts < 12000) return;
    r.status = 'stopped';
    r.endedAt = Date.now();
    r.message = 'Stopped (no active Scaler tab).';
    const runLogs = (d[K.logs] || []).concat({ t: Date.now(), type: 'warn', msg: '⏹ Stopped.' });
    const history = [{ id: r.id, fileName: r.fileName, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, message: r.message, results: r.results, logs: runLogs }]
      .concat(d[K.history] || []).slice(0, 20);
    await store.set({ [K.run]: r, [K.logs]: runLogs, [K.history]: history, [K.stop]: false });
  }, 2500);
});

$('logBtn').addEventListener('click', () => download(`scheduler_log_${Date.now()}.txt`, logText(logs)));
$('reportBtn').addEventListener('click', () => { if (run) download(`schedule_report_${run.id}.csv`, reportCSV(run.results), 'text/csv'); });

$('snapshotBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith(PAGE_URL)) {
    appendLocalLog('Open the Schedule Classes page (with the table or preview showing), then click this again.', 'warn');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { action: 'snapshot' }, res => {
    if (chrome.runtime.lastError || !res) {
      appendLocalLog('Could not read the page. Reload it and try again.', 'error');
      return;
    }
    download(`schedule_page_${Date.now()}.html`, res.html, 'text/html');
    appendLocalLog('Saved the page HTML to your downloads.', 'success');
  });
});

function appendLocalLog(msg, type) {
  const box = $('log');
  box.append(el('div', { class: type }, `[${fmtClock(Date.now())}] ${msg}`));
  box.scrollTop = box.scrollHeight;
}


function render() {
  const running = isRunning();
  const runForPlan = run && plan && run.planId === plan.id ? run : null;

  // CSV summary
  if (plan) {
    $('dropHint').textContent = running ? 'Run in progress' : 'Click or drop to replace the CSV';
    $('fileName').textContent = plan.fileName;
    $('stats').hidden = false;
    $('sBatches').textContent = plan.batches.length;
    $('sClasses').textContent = plan.totalClasses;
    $('sErrors').textContent = plan.errors.length;
    $('sErrBox').classList.toggle('err', plan.errors.length > 0);
    const errBox = $('errors');
    errBox.hidden = plan.errors.length === 0;
    errBox.replaceChildren(...plan.errors.map(e => el('div', {}, e)));
  }

  // Batch list
  const batchSection = $('batchSection');
  if (plan && plan.batches.length) {
    batchSection.hidden = false;
    $('batches').replaceChildren(...plan.batches.map((b, i) => {
      const status = runForPlan?.results?.[i]?.status || 'pending';
      const msg = runForPlan?.results?.[i]?.message || '';
      return el('div', { class: 'batch', title: msg },
        el('span', { class: 'n' }, String(i + 1)),
        el('div', { class: 'info' },
          el('div', { class: 'bn' }, b.name),
          el('div', { class: 'bl' }, `${b.library} · ${b.classes.length} class${b.classes.length === 1 ? '' : 'es'}`)),
        el('span', { class: `chip ${status}` }, status));
    }));
  } else {
    batchSection.hidden = true;
  }

  // Start-from options
  const startSel = $('startFrom');
  const prevVal = startSel.value;
  startSel.replaceChildren(...(plan?.batches || []).map((b, i) => el('option', { value: String(i) }, `${i + 1}. ${b.name}`)));
  if (prevVal && Number(prevVal) < (plan?.batches.length || 0)) startSel.value = prevVal;
  startSel.disabled = running;
  $('dryRun').disabled = running;

  // Buttons
  $('startBtn').hidden = running;
  $('stopBtn').hidden = !running;
  $('startBtn').disabled = !plan || plan.errors.length > 0 || plan.batches.length === 0;
  $('startBtn').textContent = plan && plan.errors.length ? 'Fix the problems above first' : 'Start scheduling';
  $('reportBtn').disabled = !run;

  // Progress
  if (run) {
    const todo = run.results.filter(r => r.status !== 'skipped').length;
    const done = run.results.filter(r => r.status === 'success').length;
    const pct = todo ? Math.round((done / todo) * 100) : 0;
    $('barFill').style.width = `${pct}%`;
    $('progPct').textContent = `${pct}%`;
    $('progText').textContent = running
      ? `Batch ${Math.min(run.index + 1, run.batches.length)} of ${run.batches.length} — ${run.batches[run.index]?.name || ''}`
      : `${done} of ${todo} batch(es) scheduled`;
    const banner = $('banner');
    banner.hidden = running || !run.status;
    banner.className = `banner ${run.status}`;
    banner.textContent = {
      success: `Done. ${run.message || ''}`,
      failed: `Stopped on an error: ${run.message || ''}`,
      stopped: run.message || 'Stopped.',
      'dry-run': run.message || 'Dry run finished.',
    }[run.status] || '';
  }

  renderLogs();
}

function renderLogs() {
  const box = $('log');
  if (!logs.length) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.replaceChildren(...logs.slice(-400).map(l => el('div', { class: l.type }, `[${fmtClock(l.t)}] ${l.msg}`)));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function renderHistory() {
  const d = await store.get(K.history);
  const history = d[K.history] || [];
  const list = $('history');
  if (!history.length) {
    list.replaceChildren(el('div', { class: 'empty' }, 'No past runs yet.'));
    return;
  }
  list.replaceChildren(...history.map(h => {
    const ok = (h.results || []).filter(r => r.status === 'success').length;
    const total = (h.results || []).filter(r => r.status !== 'skipped').length;
    return el('div', { class: 'hrow' },
      el('div', { class: 'top' },
        el('b', {}, h.fileName || 'Run'),
        el('span', { class: `chip ${h.status}` }, h.status)),
      el('div', { class: 'meta' }, `${fmtDateTime(h.startedAt)} · ${ok}/${total} batches scheduled`),
      h.message ? el('div', { class: 'meta' }, h.message) : null,
      el('div', { class: 'acts' },
        el('button', { class: 'link', onclick: () => download(`scheduler_log_${h.id}.txt`, logText(h.logs)) }, 'Log'),
        el('button', { class: 'link', onclick: () => download(`schedule_report_${h.id}.csv`, reportCSV(h.results), 'text/csv') }, 'Report CSV')));
  }));
}

$('clearHistBtn').addEventListener('click', async () => {
  await store.remove(K.history);
  renderHistory();
});

// ─── Live updates ──────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[K.run]) run = changes[K.run].newValue || null;
  if (changes[K.logs]) logs = changes[K.logs].newValue || [];
  if (changes[K.plan]) plan = changes[K.plan].newValue || null;
  if (changes[K.run] || changes[K.logs] || changes[K.plan]) render();
  if (changes[K.history] && $('panel-history').classList.contains('active')) renderHistory();
});

(async function init() {
  const d = await store.get([K.plan, K.run, K.logs]);
  plan = d[K.plan] || null;
  run = d[K.run] || null;
  logs = d[K.logs] || [];
  if (run && plan && run.planId === plan.id && !isRunning()) {
    // Default "start from" to the first batch that did not succeed.
    const next = run.results.findIndex(r => r.status !== 'success' && r.status !== 'skipped');
    if (next > 0) setTimeout(() => { $('startFrom').value = String(next); }, 0);
  }
  render();
})();
