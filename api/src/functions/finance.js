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
    updatedAt: null, updatedBy: null,
  };
}
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
  s.updatedAt = new Date().toISOString(); s.updatedBy = user.upn;
  return s;
}

// ── Daily Project Report rows (only the columns the money view needs) ──────
const REPORT_COLS = ['Project Name', 'Service Date', 'Project Start', 'Project Finish', 'Duration', 'Crew Size', 'Total Hours', 'Device QTY Details',
  'CO Impact', 'Work Details/Record Labor/Issues Resolved', 'Added Scope/Project Delays/Issues', 'Status', 'Job ID', 'Lead'];
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
      const state = (await readDoc(container, 'state')) || { jobs: [] };
      const jobs = (state.jobs || [])
        .filter((j) => j.date && j.date >= from && j.date <= to && !j.cancelled && j.status !== 'Cancelled')
        .map((j) => ({ ...j }));
      const [reports, savedRes, flagRes] = await Promise.all([
        fetchReportRows(from, to),
        container.items.query({
          query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p)',
          parameters: [{ name: '@p', value: JOB_PREFIX }],
        }).fetchAll(),
        container.items.query({
          query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p)',
          parameters: [{ name: '@p', value: FLAG_PREFIX }],
        }).fetchAll(),
      ]);
      attachReports(jobs, reports);
      const saved = new Map(savedRes.resources.map((d) => [d.jobId, d]));
      const flags = new Map(flagRes.resources.map((d) => [d.jobId, d.flags || {}]));
      audit(context, user, 'finance.jobs.read', { from, to, count: jobs.length });
      return {
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: {
          from, to, items: ITEMS, clients: state.clientOptions || [],
          jobs: jobs.sort((a, b) => String(a.date).localeCompare(String(b.date))).map((j) => {
            const s = saved.get(j.id);
            return { ...jobSummary(j), flags: flags.get(j.id) || {}, saved: s ? { units: s.units || {}, hours: s.hours || {}, shift: !!s.shift, note: s.note || '', updatedAt: s.updatedAt, updatedBy: s.updatedBy } : null };
          }),
        },
      };
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
      const doc = {
        id, type: 'financeJob', jobId, units, hours, shift: !!body.shift, note: clean(body.note, 1000),
        updatedAt: new Date().toISOString(), updatedBy: user.upn,
      };
      await container.items.upsert(doc);
      audit(context, user, 'finance.job.update', { jobId });
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { saved: { units: doc.units, hours: doc.hours, shift: doc.shift, note: doc.note, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
