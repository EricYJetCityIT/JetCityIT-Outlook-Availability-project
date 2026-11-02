const { app } = require('@azure/functions');
const { requireUser, requireFinance, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { audit } = require('../lib/audit');

// Financial tab (FINANCE_UPNS group only, read and write).
//
// Profit per job and per client = revenue (units x unit price, plus hourly
// items) - labor cost (hours x cost rate by ROLE: lead / tech / PM).
//
//   * Jobs: the 2026 Crew Calendar (Cosmos `state` doc, synced from Smartsheet).
//   * Actual hours: the job's Daily Project Report ("Total Hours", "Crew
//     Size"), matched by the hidden Job ID when the report has one, otherwise
//     by service date + project name (older reports predate the Job ID).
//   * Units: confirmed per job by Finance in the tab (the report's free-text
//     "Device QTY Details" is shown next to the form as the source).
//   * Prices and cost rates: entered by Finance and stored in Cosmos -- NEVER
//     in this file (the repo is public).
//
// Cosmos docs in the shared `dispatch` container:
//   finance:settings   role cost rates, price list, per-client price overrides
//   finjob:<jobId>     confirmed units / extra hours / shift premium for a job
const CONTAINER_ID = 'dispatch';
const SETTINGS_ID = 'finance:settings';
const JOB_PREFIX = 'finjob:';
// Decisions on "possible extra billing" flags (shift premium, call-out
// minimum, delays/added scope, missing report), per job:
//   finflag:<jobId>  { flags: { <kind>: { status: 'tobill'|'billed'|'ignore', note, by, at } } }
const FLAG_PREFIX = 'finflag:';
const FLAG_KINDS = ['shift', 'minimum', 'delay', 'report'];
const FLAG_STATUSES = ['tobill', 'billed', 'ignore', ''];

// The rate-sheet line items (labels only; prices live in Cosmos).
const ITEMS = [
  { key: 'dr', label: 'Standard system disconnect/reconnect', unit: 'ea' },
  { key: 'reconnect', label: 'Standard system reconnect only', unit: 'ea' },
  { key: 'partial', label: 'Partial system / disconnect only', unit: 'ea' },
  { key: 'deploy', label: 'New system deployment', unit: 'ea' },
  { key: 'server', label: 'Server unrack and rerack', unit: 'ea' },
  { key: 'phone', label: 'Phone disconnect/reconnect', unit: 'ea' },
  { key: 'printer', label: 'Printer/scanner disconnect/reconnect', unit: 'ea' },
  { key: 'printerDisc', label: 'Printer/scanner disconnect only', unit: 'ea' },
  { key: 'device', label: 'Additional devices', unit: 'ea' },
  { key: 'arm', label: 'Mount monitor on arm', unit: 'ea' },
  { key: 'unbox', label: 'Unboxing (PCs, monitors, arms)', unit: 'ea' },
  { key: 'unpack', label: 'Unpackaging (peripherals, surge strips)', unit: 'ea' },
  { key: 'support', label: 'Move support / on-call tech support', unit: 'hr' },
  { key: 'pm', label: 'Project management', unit: 'hr' },
];
const ITEM_KEYS = new Set(ITEMS.map((i) => i.key));
const ROLES = ['lead', 'tech', 'pm'];

function getReportSheetId() {
  const id = process.env.REPORT_SHEET_ID;
  if (!id) throw new Error('REPORT_SHEET_ID is not configured');
  return id;
}
function getToken() {
  const t = process.env.SMARTSHEET_API_TOKEN;
  if (!t) throw new Error('SMARTSHEET_API_TOKEN is not configured');
  return t;
}
function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ').trim().slice(0, max);
}
function money(v) { // a non-negative amount, 2 decimals, or null when blank
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(Math.min(n, 1e7) * 100) / 100 : null;
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(n, 1e6) * 100) / 100 : 0;
}
async function readDoc(container, id) {
  try { const { resource } = await container.item(id, id).read(); return resource || null; }
  catch (e) { if (e.code === 404) return null; throw e; }
}

function defaultSettings() {
  return {
    id: SETTINGS_ID, type: 'financeSettings',
    roleRates: { lead: null, tech: null, pm: null },
    prices: Object.fromEntries(ITEMS.map((i) => [i.key, null])),
    shiftPremiumPct: null,
    minCallHours: 4,
    minPerTech: false, // false = the call-out minimum is per visit; true = per tech on the crew
    clientPrices: {},
    // Materials catalog: [{ key, name, keywords, cost, price }] -- cost (and an
    // optional billed price) PER JOB when used; null = the tab seeds names only.
    materials: null,
    overtimePct: null,   // extra % on a role's hourly cost for hours over otWeeklyHours (null = off)
    otWeeklyHours: 40,   // per person per week (Mon-Sun)
    updatedAt: null, updatedBy: null,
  };
}
const MAT_KEY_RE = /^[a-z0-9-]{1,30}$/;
function sanitizeSettings(body, user) {
  const s = defaultSettings();
  const rr = (body && body.roleRates) || {};
  ROLES.forEach((r) => { s.roleRates[r] = money(rr[r]); });
  const pr = (body && body.prices) || {};
  ITEMS.forEach((i) => { s.prices[i.key] = money(pr[i.key]); });
  const pct = Number(body && body.shiftPremiumPct);
  s.shiftPremiumPct = Number.isFinite(pct) && pct >= 0 && pct <= 200 ? pct : null;
  const mh = Number(body && body.minCallHours);
  s.minCallHours = Number.isFinite(mh) && mh >= 0 && mh <= 24 ? mh : 4;
  s.minPerTech = !!(body && body.minPerTech);
  const cp = (body && body.clientPrices) || {};
  Object.keys(cp).slice(0, 300).forEach((client) => {
    const name = clean(client, 200); if (!name) return;
    const o = {};
    Object.keys(cp[client] || {}).forEach((k) => { if (ITEM_KEYS.has(k)) { const m = money(cp[client][k]); if (m != null) o[k] = m; } });
    if (Object.keys(o).length) s.clientPrices[name] = o;
  });
  if (Array.isArray(body && body.materials)) {
    const seen = new Set();
    s.materials = body.materials.slice(0, 40).map((m) => {
      const key = clean(m && m.key, 30).toLowerCase();
      if (!MAT_KEY_RE.test(key) || seen.has(key)) return null; seen.add(key);
      return { key, name: clean(m.name, 60) || key, keywords: clean(m.keywords, 200), cost: money(m.cost), price: money(m.price) };
    }).filter(Boolean);
  }
  const otp = Number(body && body.overtimePct);
  s.overtimePct = body && body.overtimePct !== '' && body.overtimePct != null && Number.isFinite(otp) && otp >= 0 && otp <= 300 ? otp : null;
  const oth = Number(body && body.otWeeklyHours);
  s.otWeeklyHours = Number.isFinite(oth) && oth >= 1 && oth <= 80 ? oth : 40;
  s.updatedAt = new Date().toISOString(); s.updatedBy = user.upn;
  return s;
}

// ── Daily Project Report rows (only the columns the money view needs) ──────
const REPORT_COLS = ['Project Name', 'Service Date', 'Project Start', 'Project Finish', 'Duration', 'Crew Size', 'Total Hours', 'Device QTY Details',
  'CO Impact', 'Work Details/Record Labor/Issues Resolved', 'Added Scope/Project Delays/Issues', 'Status', 'Job ID', 'Lead', 'JCIT Provided Parts/Materials Used'];
async function fetchReportRows(fromIso, toIso) {
  const sheetId = getReportSheetId(), headers = { Authorization: `Bearer ${getToken()}` };
  const cres = await fetch(`https://api.smartsheet.com/2.0/sheets/${sheetId}/columns?includeAll=true`, { headers });
  if (!cres.ok) throw new Error(`Smartsheet columns error ${cres.status}`);
  const cols = ((await cres.json()).data || []).filter((c) => REPORT_COLS.includes(c.title));
  const byId = new Map(cols.map((c) => [c.id, c.title]));
  const res = await fetch(`https://api.smartsheet.com/2.0/sheets/${sheetId}?columnIds=${cols.map((c) => c.id).join(',')}&include=objectValue`, { headers });
  if (!res.ok) throw new Error(`Smartsheet report sheet error ${res.status}`);
  const sheet = await res.json();
  const out = [];
  (sheet.rows || []).forEach((row) => {
    const r = { rowId: String(row.id) };
    (row.cells || []).forEach((c) => {
      const t = byId.get(c.columnId); if (!t) return;
      let v = c.displayValue != null ? c.displayValue : c.value;
      if (c.objectValue && Array.isArray(c.objectValue.values)) v = c.objectValue.values.map((x) => x.name || x.email || x).join(', ');
      r[t] = v == null ? '' : String(v).trim();
    });
    const date = String(r['Service Date'] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < fromIso || date > toIso) return;
    out.push({
      rowId: r.rowId, date, project: r['Project Name'] || '', jobId: (r['Job ID'] || '').trim(),
      crewSize: parseFloat(r['Crew Size']) || null, totalHours: parseFloat(r['Total Hours']) || null,
      deviceQty: r['Device QTY Details'] || '', coImpact: r['CO Impact'] || '', status: r.Status || '',
      work: r['Work Details/Record Labor/Issues Resolved'] || '', scope: r['Added Scope/Project Delays/Issues'] || '',
      lead: r.Lead || '',
      start: r['Project Start'] || '', finish: r['Project Finish'] || '', duration: parseFloat(r.Duration) || null,
      materials: r['JCIT Provided Parts/Materials Used'] || '',
    });
  });
  return out;
}

// Reports filed from the bare form link have no Job ID; match them to the
// calendar job on the same date with the most similar project name.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function nameScore(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.9;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  let inter = 0; A.forEach((t) => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}
function attachReports(jobs, reports) {
  const byJob = new Map(jobs.map((j) => [j.id, j]));
  const byDate = new Map();
  jobs.forEach((j) => { if (!byDate.has(j.date)) byDate.set(j.date, []); byDate.get(j.date).push(j); });
  reports.forEach((rep) => {
    let job = rep.jobId && byJob.get(rep.jobId), how = job ? 'jobId' : '';
    if (!job) {
      let best = null, bestScore = 0;
      (byDate.get(rep.date) || []).forEach((j) => { const s = nameScore(rep.project, j.project); if (s > bestScore) { best = j; bestScore = s; } });
      if (best && bestScore >= 0.5) { job = best; how = bestScore >= 0.9 ? 'name' : 'fuzzy'; }
    }
    if (!job) return;
    (job.reports = job.reports || []).push({ ...rep, matchedBy: how });
  });
}

function jobSummary(j) {
  return {
    id: j.id, date: j.date, project: j.project || '', client: j.client || '', status: j.status || '',
    lead: j.lead || [], technicians: j.technicians || [], crewSize: j.crewSize || null, duration: j.duration || '',
    startTime: j.startTime || '', reports: j.reports || [],
  };
}

// GET  /api/finance/settings
// PUT  /api/finance/settings   JSON { roleRates, prices, shiftPremiumPct, minCallHours, clientPrices }
app.http('financeSettings', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'finance/settings',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireFinance(user);
      const container = getContainer(CONTAINER_ID);
      if (request.method === 'GET') {
        const s = (await readDoc(container, SETTINGS_ID)) || defaultSettings();
        return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { settings: s, items: ITEMS } };
      }
      const s = sanitizeSettings(await request.json().catch(() => ({})), user);
      await container.items.upsert(s);
      audit(context, user, 'finance.settings.update', {});
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { settings: s, items: ITEMS } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// GET /api/finance/jobs?from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> { jobs: [ {calendar job, reports:[...], saved:{units,...}|null} ], clients, items }
// Calendar jobs in [from, to] joined to their Daily Reports, confirmed units and
// extra-billing decisions -- exactly what the tab works from (shared by the
// jobs route and the monthly summary email).
async function loadFinanceJobs(container, from, to) {
  const state = (await readDoc(container, 'state')) || { jobs: [] };
  const jobs = (state.jobs || [])
    .filter((j) => j.date && j.date >= from && j.date <= to && !j.cancelled && j.status !== 'Cancelled')
    .map((j) => ({ ...j }));
  const [reports, savedRes, flagRes] = await Promise.all([
    fetchReportRows(from, to),
    container.items.query({ query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p)', parameters: [{ name: '@p', value: JOB_PREFIX }] }).fetchAll(),
    container.items.query({ query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p)', parameters: [{ name: '@p', value: FLAG_PREFIX }] }).fetchAll(),
  ]);
  attachReports(jobs, reports);
  const saved = new Map(savedRes.resources.map((d) => [d.jobId, d]));
  const flags = new Map(flagRes.resources.map((d) => [d.jobId, d.flags || {}]));
  return {
    clients: state.clientOptions || [],
    jobs: jobs.sort((a, b) => String(a.date).localeCompare(String(b.date))).map((j) => {
      const s = saved.get(j.id);
      return { ...jobSummary(j), flags: flags.get(j.id) || {}, saved: s ? { units: s.units || {}, hours: s.hours || {}, shift: !!s.shift, materials: s.materials || null, note: s.note || '', updatedAt: s.updatedAt, updatedBy: s.updatedBy } : null };
    }),
  };
}

app.http('financeJobs', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'finance/jobs',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireFinance(user);
      const q = new URL(request.url).searchParams;
      const iso = (v, d) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : d);
      const today = new Date().toISOString().slice(0, 10);
      const from = iso(q.get('from'), today.slice(0, 8) + '01'), to = iso(q.get('to'), today);
      const container = getContainer(CONTAINER_ID);
      const data = await loadFinanceJobs(container, from, to);
      audit(context, user, 'finance.jobs.read', { from, to, count: data.jobs.length });
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { from, to, items: ITEMS, clients: data.clients, jobs: data.jobs } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// PUT /api/finance/flags/{jobId}  JSON { kind, status, note } -- record a decision on one
// "possible extra billing" flag (status '' clears it back to undecided).
app.http('financeFlag', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'finance/flags/{id}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireFinance(user);
      const jobId = String(request.params.id || '');
      if (!/^ss-\d{6,}$/.test(jobId)) return { status: 400, jsonBody: { error: 'Bad job id' } };
      const body = await request.json().catch(() => ({}));
      if (!FLAG_KINDS.includes(body.kind)) return { status: 400, jsonBody: { error: 'Unknown flag' } };
      const status = FLAG_STATUSES.includes(body.status) ? body.status : '';
      const container = getContainer(CONTAINER_ID);
      const id = FLAG_PREFIX + jobId;
      const doc = (await readDoc(container, id)) || { id, type: 'financeFlags', jobId, flags: {} };
      if (status) doc.flags[body.kind] = { status, note: clean(body.note, 500), by: user.upn, at: new Date().toISOString() };
      else delete doc.flags[body.kind];
      doc.updatedAt = new Date().toISOString();
      await container.items.upsert(doc);
      audit(context, user, 'finance.flag.update', { jobId, kind: body.kind, status });
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { flags: doc.flags } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// PUT /api/finance/jobs/{id}   JSON { units:{key:qty}, hours:{lead,tech,pm}, shift, note }  (confirm a job's units)
// DELETE /api/finance/jobs/{id}                                                          (back to unconfirmed)
app.http('financeJob', {
  methods: ['PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'finance/jobs/{id}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireFinance(user);
      const jobId = String(request.params.id || '');
      if (!/^ss-\d{6,}$/.test(jobId)) return { status: 400, jsonBody: { error: 'Bad job id' } };
      const container = getContainer(CONTAINER_ID);
      const id = JOB_PREFIX + jobId;
      if (request.method === 'DELETE') {
        try { await container.item(id, id).delete(); } catch (e) { if (e.code !== 404) throw e; }
        audit(context, user, 'finance.job.clear', { jobId });
        return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { ok: true } };
      }
      const body = await request.json().catch(() => ({}));
      const units = {};
      Object.keys(body.units || {}).forEach((k) => { if (ITEM_KEYS.has(k)) { const n = qty(body.units[k]); if (n) units[k] = n; } });
      // Optional hour overrides (when the report's hours are missing or wrong).
      const hours = {};
      ROLES.forEach((r) => { const v = body.hours && body.hours[r]; if (v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0) hours[r] = Math.round(Math.min(Number(v), 10000) * 100) / 100; });
      // Materials used on the job: { catalogKey: qty } (qty = how many "jobs' worth").
      let materials = null;
      if (body.materials && typeof body.materials === 'object') {
        materials = {};
        Object.keys(body.materials).slice(0, 40).forEach((k) => { const key = String(k).toLowerCase(); if (MAT_KEY_RE.test(key)) { const n = qty(body.materials[k]); if (n) materials[key] = n; } });
      }
      const doc = {
        id, type: 'financeJob', jobId, units, hours, shift: !!body.shift, materials, note: clean(body.note, 1000),
        updatedAt: new Date().toISOString(), updatedBy: user.upn,
      };
      await container.items.upsert(doc);
      audit(context, user, 'finance.job.update', { jobId });
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { saved: { units: doc.units, hours: doc.hours, shift: doc.shift, materials: doc.materials, note: doc.note, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// ── Monthly summary email ───────────────────────────────────────────────────
// Last month's numbers, computed with the SAME math as the tab
// (lib/financeCalc.js is a verbatim copy of the tab's calc block), sent to the
// Financial group. Each recipient gets it FROM their own mailbox TO themselves
// with no Sent Items copy, so the figures don't land in anyone else's mailbox;
// set the FINANCE_MAIL_FROM app setting to send from one shared mailbox instead.
//   POST /api/finance/monthly-summary   X-Sync-Secret; ?month=YYYY-MM (default: last month); ?dry=1
//                                       -> everyone in FINANCE_UPNS (GitHub Actions cron, 1st of the month)
//   POST /api/finance/summary-email     signed-in Financial user; JSON { month } -> just the caller
const { createFinanceCalc } = require('../lib/financeCalc');
const { sendMail } = require('../lib/graph');
const { safeEqual } = require('../lib/secure');
const APP_URL = 'https://crew-calendar.jetcityit.com/';

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}
function prevMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }
function pacificToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); } // YYYY-MM-DD

function summarizeMonth(calc, jobs) {
  const t = { rev: 0, cost: 0, hours: 0, jobs: jobs.length, confirmed: 0, flags: 0, flagAmt: 0 };
  const byClient = new Map();
  jobs.forEach((j) => {
    const c = calc.finCalc(j), fl = calc.finFlagsFor(j, c);
    t.rev += c.revenue; t.cost += c.cost; t.hours += c.hours; if (c.unitsSrc === 'confirmed') t.confirmed++;
    fl.forEach((f) => { if (!f.status) { t.flags++; t.flagAmt += f.amount || 0; } });
    const k = j.client || '(no client)', a = byClient.get(k) || { name: k, rev: 0, cost: 0, hours: 0, jobs: 0 };
    a.rev += c.revenue; a.cost += c.cost; a.hours += c.hours; a.jobs++; byClient.set(k, a);
  });
  const clients = [...byClient.values()].map((a) => ({ ...a, margin: a.rev - a.cost, pct: a.rev > 0 ? (a.rev - a.cost) / a.rev : null }));
  return { ...t, margin: t.rev - t.cost, pct: t.rev > 0 ? (t.rev - t.cost) / t.rev : null, perHour: t.hours > 0 ? t.rev / t.hours : null, clients };
}

async function buildMonthlySummary(container, ym) {
  const settings = (await readDoc(container, SETTINGS_ID)) || defaultSettings();
  const calc = createFinanceCalc(settings, ITEMS);
  const prev = prevMonth(ym), cur = monthBounds(ym), pb = monthBounds(prev);
  // One report-sheet read covers both months, padded to whole Mon-Sun weeks so
  // weekly overtime is counted the same way the tab counts it.
  const pad = (iso, toEnd) => { const d = new Date(iso + 'T00:00:00Z'), dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() + (toEnd ? 6 - dow : -dow)); return d.toISOString().slice(0, 10); };
  const data = await loadFinanceJobs(container, pad(pb.from, false), pad(cur.to, true));
  calc.finApplyOvertime(data.jobs);
  data.jobs = data.jobs.filter((j) => j.date >= pb.from && j.date <= cur.to);
  const s = summarizeMonth(calc, data.jobs.filter((j) => j.date >= cur.from));
  const p = summarizeMonth(calc, data.jobs.filter((j) => j.date <= pb.to));
  const M = calc.finMoney, E = calc.jsEsc, pct = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v * 100) + '%');
  const label = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const delta = (a, b) => (b ? ` <span style="color:#6b7280">(${a >= b ? '▲' : '▼'} ${M(Math.abs(a - b))} vs last month)</span>` : '');
  const ranked = s.clients.filter((c) => c.rev > 0).sort((a, b) => b.margin - a.margin);
  const row = (c) => `<tr><td style="padding:4px 10px 4px 0">${E(c.name)}</td><td style="padding:4px 10px">${M(c.rev)}</td><td style="padding:4px 10px">${M(c.margin)}</td><td style="padding:4px 10px">${pct(c.pct)}</td></tr>`;
  const head = '<tr style="color:#6b7280"><td style="padding:4px 10px 4px 0">Client</td><td style="padding:4px 10px">Revenue</td><td style="padding:4px 10px">Margin</td><td style="padding:4px 10px">%</td></tr>';
  const ready = settings.roleRates && (settings.roleRates.lead != null || settings.roleRates.tech != null);
  const line = (l, v) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280">${l}</td><td>${v}</td></tr>`;
  const html = '<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f1724;max-width:620px">' +
    `<h2 style="margin:0 0 4px">Financial summary — ${E(label)}</h2>` +
    `<div style="color:#6b7280;margin-bottom:14px">Jet City IT crew calendar · ${s.jobs} jobs · ${s.confirmed} with confirmed units</div>` +
    (ready ? '' : '<p style="background:#FEF3C7;padding:8px 10px;border-radius:6px">Cost rates or prices are not set yet in the Financial tab, so the numbers below are incomplete.</p>') +
    '<table style="border-collapse:collapse;margin-bottom:14px">' +
    line('Revenue', `<b>${M(s.rev)}</b>${delta(s.rev, p.rev)}`) +
    line('Cost (labor, overtime, materials)', `<b>${M(s.cost)}</b>`) +
    line('Margin', `<b>${M(s.margin)}</b> · ${pct(s.pct)}${delta(s.margin, p.margin)}`) +
    line('Revenue per labor hour', `<b>${M(s.perHour)}</b>`) +
    line('Possible extra billing', `<b>${s.flags}</b> item${s.flags === 1 ? '' : 's'} need a decision${s.flagAmt ? ` (≈ ${M(s.flagAmt)})` : ''}`) +
    '</table>' +
    (ranked.length && ranked.length <= 6 ? `<div style="font-weight:600;margin:8px 0 4px">Clients by margin</div><table style="border-collapse:collapse;font-size:13px">${head}${ranked.map(row).join('')}</table>` : '') +
    (ranked.length > 6 ? `<div style="font-weight:600;margin:8px 0 4px">Most profitable clients</div><table style="border-collapse:collapse;font-size:13px">${head}${ranked.slice(0, 3).map(row).join('')}</table>` +
      `<div style="font-weight:600;margin:12px 0 4px">Least profitable clients</div><table style="border-collapse:collapse;font-size:13px">${head}${ranked.slice(-3).reverse().map(row).join('')}</table>` : '') +
    `<p style="margin-top:16px;color:#6b7280;font-size:12.5px">Numbers include jobs whose units are only suggested from the Daily Reports until they are confirmed. Open the <a href="${APP_URL}">Financial tab</a> for details. Sent to the Financial group only.</p></div>`;
  return { label, subject: `Financial summary — ${label}`, html, summary: { rev: s.rev, cost: s.cost, margin: s.margin, jobs: s.jobs, confirmed: s.confirmed, flags: s.flags, prevRev: p.rev } };
}
const financeRecipients = () => (process.env.FINANCE_UPNS || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => /@/.test(x));
async function sendSummary(to, built) {
  const from = process.env.FINANCE_MAIL_FROM || to;
  await sendMail({ from, to, subject: built.subject, html: built.html, saveToSentItems: false });
}

app.http('financeMonthlySummary', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'finance/monthly-summary',
  handler: async (request, context) => {
    try {
      const expected = process.env.SYNC_SECRET, provided = request.headers.get('x-sync-secret') || '';
      if (!expected || !safeEqual(provided, expected)) return { status: 401, jsonBody: { error: 'Unauthorized' } };
      const q = new URL(request.url).searchParams;
      const ym = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : prevMonth(pacificToday().slice(0, 7));
      const container = getContainer(CONTAINER_ID);
      const built = await buildMonthlySummary(container, ym);
      const to = financeRecipients();
      if (q.get('dry') === '1') return { jsonBody: { dryRun: true, month: ym, wouldSendTo: to.length, jobs: built.summary.jobs } };
      let sent = 0, failed = 0;
      for (const r of to) { try { await sendSummary(r, built); sent++; } catch (e) { failed++; try { context.error(e); } catch (_) { /* ignore */ } } }
      audit(context, { upn: 'scheduler' }, 'finance.summary.send', { month: ym, sent, failed });
      return { jsonBody: { month: ym, sent, failed } };
    } catch (e) {
      try { context.error(e); } catch (_) { /* ignore */ }
      return { status: 500, jsonBody: { error: 'Summary failed' } };
    }
  },
});

app.http('financeSummaryEmail', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'finance/summary-email',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireFinance(user);
      const body = await request.json().catch(() => ({}));
      const ym = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : prevMonth(pacificToday().slice(0, 7));
      const built = await buildMonthlySummary(getContainer(CONTAINER_ID), ym);
      try { await sendSummary(user.upn, built); } catch (e) {
        try { context.error(e); } catch (_) { /* ignore */ }
        return { status: 502, jsonBody: { error: 'The email could not be sent from your mailbox. A shared sender can be set with the FINANCE_MAIL_FROM app setting.' } };
      }
      audit(context, user, 'finance.summary.self', { month: ym });
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { ok: true, month: ym, to: user.upn } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
