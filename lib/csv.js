
// CSV parsing + validation -> batch plan
// Used by the popup (window.SchedCSV) and by node tests (module.exports).
(function (root) {
  'use strict';

  // Exact header names accepted (compared after lowercasing and collapsing
  // punctuation/spaces). No partial matching, so "Classroom" never matches "Class".
  const COLUMNS = {
    batch: ['batch name', 'batch'],
    library: ['library name', 'library'],
    className: ['class name', 'class', 'lecture name'],
    date: ['date', 'class date'],
    time: ['time', 'class time', 'start time'],
    email: ['instructor email', 'instructor', 'primary instructor email', 'primary instructor', 'email'],
    classroom: ['classroom name', 'classroom', 'class room', 'room'],
  };

  const LABELS = {
    batch: 'Batch Name', library: 'Library Name', className: 'Class Name', date: 'Date',
    time: 'Time', email: 'Instructor Email', classroom: 'Classroom',
  };

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const normHeader = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

  // RFC 4180 parser: quoted fields, escaped "" quotes, commas/newlines inside quotes, CRLF.
  function parseCSV(text) {
    text = String(text ?? '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // "15/11/26", "15/11/2026", "15-11-2026", "15.11.26" (DD/MM/YY)
  function parseDate(s) {
    const m = clean(s).match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
    if (!m) return null;
    const d = +m[1];
    const mo = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { y, m: mo, d };
  }

  // "5:00 PM", "05:00 pm", "5:00PM", or 24h "17:00" -> minutes since midnight
  function parseTime(s) {
    const t = clean(s);
    let m = t.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
    if (m) {
      let h = +m[1];
      const min = +m[2];
      if (h < 1 || h > 12 || min > 59) return null;
      const pm = m[3].toLowerCase() === 'p';
      if (h === 12) h = 0;
      return (pm ? h + 12 : h) * 60 + min;
    }
    m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = +m[1];
      const min = +m[2];
      if (h > 23 || min > 59) return null;
      return h * 60 + min;
    }
    return null;
  }

  // 1020 -> "05:00 PM" (the format the Scaler time dropdown uses)
  function formatTime(minutes) {
    const h24 = Math.floor(minutes / 60);
    const min = minutes % 60;
    const ap = h24 >= 12 ? 'PM' : 'AM';
    let h = h24 % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')} ${ap}`;
  }

  // {y:2026,m:11,d:15} -> "15 Nov 2026" (the format the Scaler date field shows)
  function formatDate(date) {
    return `${date.d} ${MONTHS_SHORT[date.m - 1]} ${date.y}`;
  }

  function resolveHeaders(headerRow) {
    const map = {};
    const normalized = headerRow.map(normHeader);
    const missing = [];
    for (const [key, aliases] of Object.entries(COLUMNS)) {
      let idx = -1;
      for (const alias of aliases) {
        idx = normalized.indexOf(alias);
        if (idx !== -1) break;
      }
      if (idx === -1) missing.push(LABELS[key]);
      else map[key] = idx;
    }
    return { map, missing };
  }

  /**
   * Build the batch plan from CSV text.
   * Rows with a Batch Name start a new batch; rows below with an empty Batch Name
   * belong to that batch. Fully empty rows are ignored.
   * Returns { batches, errors, warnings, totalClasses }.
   */
  function buildPlan(text, today = new Date()) {
    const errors = [];
    const warnings = [];
    const rows = parseCSV(text);
    const firstIdx = rows.findIndex(r => r.some(c => clean(c)));
    if (firstIdx === -1) return { batches: [], errors: ['The CSV is empty.'], warnings, totalClasses: 0 };

    const { map, missing } = resolveHeaders(rows[firstIdx]);
    if (missing.length) {
      return {
        batches: [],
        errors: [`Missing column(s): ${missing.join(', ')}. Expected headers: ${Object.values(LABELS).join(', ')}.`],
        warnings,
        totalClasses: 0,
      };
    }

    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const batches = [];
    const seenBatches = new Map();
    let current = null;

    for (let i = firstIdx + 1; i < rows.length; i++) {
      const line = i + 1; // spreadsheet row number
      const r = rows[i];
      if (!r.some(c => clean(c))) continue;
      const get = key => clean(r[map[key]]);

      const batchName = get('batch');
      const libraryName = get('library');

      if (batchName) {
        const key = batchName.toLowerCase();
        if (seenBatches.has(key)) {
          errors.push(`Row ${line}: batch "${batchName}" already started at row ${seenBatches.get(key)}. Keep each batch in one block.`);
        }
        seenBatches.set(key, line);
        if (!libraryName) errors.push(`Row ${line}: Library Name is empty for batch "${batchName}".`);
        current = { name: batchName, library: libraryName, line, classes: [] };
        batches.push(current);
      } else {
        if (!current) {
          errors.push(`Row ${line}: no Batch Name above this row.`);
          continue;
        }
        if (libraryName && libraryName.toLowerCase() !== current.library.toLowerCase()) {
          errors.push(`Row ${line}: Library "${libraryName}" differs from "${current.library}" set for batch "${current.name}" at row ${current.line}.`);
        }
      }

      const className = get('className');
      const dateRaw = get('date');
      const timeRaw = get('time');
      const email = get('email');
      const classroom = get('classroom');

      if (!className) {
        if (dateRaw || timeRaw || email || classroom) errors.push(`Row ${line}: Class Name is empty.`);
        continue;
      }

      const where = `Row ${line} (${current.name} → ${className})`;
      const date = parseDate(dateRaw);
      const time = parseTime(timeRaw);

      if (!dateRaw) errors.push(`${where}: Date is empty.`);
      else if (!date) errors.push(`${where}: Date "${dateRaw}" is not DD/MM/YY.`);
      else if (new Date(date.y, date.m - 1, date.d) < todayStart) errors.push(`${where}: Date ${formatDate(date)} is in the past.`);

      if (!timeRaw) errors.push(`${where}: Time is empty.`);
      else if (time === null) errors.push(`${where}: Time "${timeRaw}" is not like 5:00 PM.`);
      else if (time % 5 !== 0) errors.push(`${where}: Time "${timeRaw}" must be on a 5-minute step (the time dropdown only has :00, :05, :10 …).`);

      if (!email) errors.push(`${where}: Instructor Email is empty.`);
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`${where}: Instructor Email "${email}" is not a valid email.`);

      if (!classroom) errors.push(`${where}: Classroom is empty.`);

      if (current.classes.some(c => c.name === className)) {
        errors.push(`${where}: class appears twice in this batch.`);
      }

      current.classes.push({
        name: className,
        line,
        date,
        dateText: date ? formatDate(date) : dateRaw,
        time,
        timeText: time !== null ? formatTime(time) : timeRaw,
        email,
        classroom,
      });
    }

    for (const b of batches) {
      if (!b.classes.length) errors.push(`Row ${b.line}: batch "${b.name}" has no classes.`);
    }
    if (!batches.length && !errors.length) errors.push('No batches found under the header row.');

    const totalClasses = batches.reduce((n, b) => n + b.classes.length, 0);
    return { batches, errors, warnings, totalClasses };
  }

  const TEMPLATE = [
    'Batch Name,Library Name,Class Name,Date,Time,Instructor Email,Classroom',
    'SST IPS 2030 Batch A,SST Introduction to Problem Solving,Class One,15/11/26,5:00 PM,instructor@scaler.com,"1F, Classroom A"',
    ',,Class Two,17/11/26,5:00 PM,instructor@scaler.com,"1F, Classroom A"',
    'SST IPS 2030 Batch B,SST Introduction to Problem Solving,Class One,16/11/26,10:00 AM,instructor@scaler.com,"1F, Classroom B"',
    '',
  ].join('\n');

  const api = { parseCSV, parseDate, parseTime, formatTime, formatDate, buildPlan, TEMPLATE, MONTHS_SHORT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchedCSV = api;
})(typeof self !== 'undefined' ? self : this);
