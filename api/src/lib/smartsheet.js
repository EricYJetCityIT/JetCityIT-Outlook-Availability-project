const SMARTSHEET_API_BASE = 'https://api.smartsheet.com/2.0';
const STATUS_VALUES = new Set(['In Progress', 'Complete', 'Cancelled', 'Postponed']);

function getSheetId() {
  const id = process.env.SMARTSHEET_SHEET_ID;
  if (!id) throw new Error('SMARTSHEET_SHEET_ID is not configured');
  return id;
}

function getToken() {
  const token = process.env.SMARTSHEET_API_TOKEN;
  if (!token) throw new Error('SMARTSHEET_API_TOKEN is not configured');
  return token;
}

// Fetches the full "JCIT 2026 Crew Calendar" sheet, including the
// structured objectValue on multi-value cells (contact/picklist columns)
// so names and picklist entries can be read reliably instead of splitting
// displayValue strings on commas.
async function fetchSheet() {
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${getSheetId()}?include=objectValue,attachments,format`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Fetches a single attachment's metadata, which is the only place Smartsheet
// exposes a download `url` — and only as a short-lived temporary link (the
// sheet-level include=attachments returns id/name/mimeType but no url). The
// /api/attachment endpoint calls this on demand so the browser gets a fresh
// link each click and the API token never leaves the server.
async function fetchAttachment(attachmentId) {
  const res = await fetch(
    `${SMARTSHEET_API_BASE}/sheets/${getSheetId()}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${getToken()}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet attachment error ${res.status}: ${text}`);
  }
  return res.json();
}

// Fetches just the column definitions for an arbitrary sheet (used to look
// up a column id by title without pulling every row). Returns { columns }
// to match the shape fetchSheet/resolveColumns expect.
async function fetchSheetColumns(sheetId) {
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${sheetId}/columns?includeAll=true`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet columns error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { columns: data.data || [] };
}

// Fetches an arbitrary sheet but only the rows modified at/after sinceISO
// (Smartsheet's rowsModifiedSince filter). Used by the report matcher to
// read just the newly-submitted Daily Project Report rows instead of the
// whole (~1,900 row) sheet each run. Returns the full sheet JSON (columns +
// the filtered rows). Omitting sinceISO returns all rows.
async function fetchRowsModifiedSince(sheetId, sinceISO) {
  const q = sinceISO ? `?rowsModifiedSince=${encodeURIComponent(sinceISO)}` : '';
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${sheetId}${q}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Low-level PUT /rows for an arbitrary sheet. `rows` is the Smartsheet row
// array (each `{ id, cells: [...] }`). allowPartialSuccess makes Smartsheet
// apply the rows it can and report the rest in failedItems instead of
// rejecting the whole batch — important for the matcher, where one stale
// row id (a deleted job) shouldn't block every other tick.
async function putRows(sheetId, rows, { allowPartialSuccess = false } = {}) {
  const q = allowPartialSuccess ? '?allowPartialSuccess=true' : '';
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${sheetId}/rows${q}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet row update error ${res.status}: ${text}`);
  }
  return res.json();
}

// Multi-value cells (MULTI_CONTACT_LIST, MULTI_PICKLIST) carry their values
// in objectValue.values, either as plain strings (picklist) or {name,email}
// objects (contact). Falls back to splitting displayValue for older
// responses that lack objectValue.
function cellMultiValues(cell) {
  if (cell && cell.objectValue && Array.isArray(cell.objectValue.values)) {
    return cell.objectValue.values
      .map((v) => (typeof v === 'string' ? v : v.name || v.email))
      .filter(Boolean);
  }
  if (cell && cell.displayValue) {
    return cell.displayValue.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function cellText(cell) {
  if (!cell) return '';
  if (cell.displayValue != null) return String(cell.displayValue).trim();
  if (cell.value != null) return String(cell.value).trim();
  return '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Smartsheet doesn't reject free text typed into a contact-type cell — it
// just stores it as an ad-hoc {name: "<whatever was typed>"} contact object
// with no email, indistinguishable in shape from a real directory pick.
// Real names in this roster are consistently short ("First L" or "First
// Last"); a scheduling note or placeholder like "Optional - Open Event" is
// much longer/wordier or sentence-like, so reject on that basis instead of
// trusting any non-empty v.name.
function isPlausibleName(s) {
  if (!s) return false;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 30) return false;
  if (/[.]/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 3) return false;
  return true;
}

// The "JCIT Lead"/"Technicians" columns are meant to only ever hold real
// people picked from the directory, but in practice a few rows have stray
// free text typed into them instead (e.g. a scheduling note, or a
// placeholder like "Optional - Open Event") and a few resolve to only a
// bare email with no name attached to that particular cell entry (even
// though the same email has a real name elsewhere via contactOptions).
// This resolves emails to their real name via emailToName and drops
// anything that isn't a real contact (a bare object value, an implausible
// name, or an unresolvable email) rather than accepting arbitrary strings.
function techNamesFromCell(cell, emailToName) {
  const names = [];
  const addResolved = (raw) => {
    const key = String(raw).toLowerCase();
    if (emailToName.has(key)) names.push(emailToName.get(key));
  };
  if (cell && cell.objectValue && Array.isArray(cell.objectValue.values)) {
    cell.objectValue.values.forEach((v) => {
      if (typeof v === 'string') {
        if (EMAIL_RE.test(v)) addResolved(v);
        return; // a bare non-email string here is free-text noise, not a name
      }
      if (v.name && isPlausibleName(v.name)) { names.push(v.name); return; }
      if (v.email) { addResolved(v.email); return; }
    });
  } else if (cell && cell.displayValue) {
    cell.displayValue.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      if (EMAIL_RE.test(s)) addResolved(s);
      else if (isPlausibleName(s)) names.push(s); // no objectValue to check against — best effort
    });
  }
  return names;
}

// Resolves the sheet's columns by title (throwing if the layout changed)
// and builds an email->name lookup from the "JCIT Lead"/"Technicians"
// columns' contact options. Shared by both reading (transformSheetToDispatch)
// and writing (updateJobCrew) so the two stay consistent.
function resolveColumns(sheet) {
  const colByTitle = {};
  sheet.columns.forEach((c) => {
    colByTitle[c.title] = c;
  });
  const requireColumn = (title) => {
    const c = colByTitle[title];
    if (!c) throw new Error(`Smartsheet column "${title}" not found — sheet layout may have changed`);
    return c;
  };

  const COLUMNS = {
    date: requireColumn('Date'),
    project: requireColumn('Project'),
    address: requireColumn('Address'),
    duration: requireColumn('Est Duration (hrs)'),
    startTime: requireColumn('Start Time'),
    lead: requireColumn('JCIT Lead'),
    technicians: requireColumn('Technicians'),
    poc: requireColumn('POC'),
    notes: requireColumn('Work Order Notes'),
    client: requireColumn('Client'),
    crewSize: requireColumn('Crew Size'),
    status: requireColumn('Status'),
    // Optional (not requireColumn): the "Proj Rpt Rec'd" checkbox drives the
    // Project-reports view's red/green. Absent → every job reads as "no report".
    reportReceived: colByTitle["Proj Rpt Rec'd"] || null,
  };

  const emailToName = new Map();
  (COLUMNS.lead.contactOptions || []).forEach((c) => c.email && c.name && emailToName.set(c.email.toLowerCase(), c.name));
  (COLUMNS.technicians.contactOptions || []).forEach((c) => c.email && c.name && emailToName.set(c.email.toLowerCase(), c.name));

  return { COLUMNS, emailToName };
}

// Pushes a crew assignment change for one job back into its Smartsheet row.
// Only touches the "JCIT Lead"/"Technicians" cells — everything else about
// the job (address, time, notes, etc.) stays Smartsheet-managed. Contacts
// with no resolvable email are silently dropped (can't write a name-only
// contact back reliably); this is a deliberate limitation, not a bug.
//
// Two gotchas found by testing against the real sheet, both fixed here:
// 1. Sending a CONTACT with only `email` (no `name`) let Smartsheet
//    substitute that email's own directory display name instead of the
//    abbreviated name ("Jason M") this sheet actually uses — so the name
//    is always sent explicitly alongside the email, never omitted.
// 2. Sending `objectValue: {values: []}` to clear a cell was rejected by
//    Smartsheet — clearing a cell requires `value: null` instead.
async function updateJobCrew(rowId, leadColumnId, technicianColumnId, leadNames, technicianNames, nameToEmail) {
  const toContacts = (names) =>
    names
      .map((n) => ({ name: n, email: nameToEmail.get(n) }))
      .filter((c) => c.email)
      .map((c) => ({ objectType: 'CONTACT', email: c.email, name: c.name }));

  const toCell = (columnId, names) => {
    const contacts = toContacts(names);
    return contacts.length
      ? { columnId, objectValue: { objectType: 'MULTI_CONTACT', values: contacts } }
      : { columnId, value: null };
  };

  const body = [
    {
      id: rowId,
      cells: [toCell(leadColumnId, leadNames), toCell(technicianColumnId, technicianNames)],
    },
  ];

  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${getSheetId()}/rows`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet row update error ${res.status}: ${text}`);
  }
  return res.json();
}

// Maps the sheet's columns/rows onto the app's {workers, jobs} schema
// (see JCITDispatch in index.html for the exact shape this must match).
// Rows without a Project name or Date are treated as blank/placeholder
// rows and skipped. The worker roster is the union of every name actually
// assigned as a lead/technician on a real job, plus the "JCIT Lead" and
// "Technicians" columns' contact options as a supplement. contactOptions
// alone isn't reliable — it's Smartsheet's contextual "suggested contacts"
// list for the calling account, not a fixed complete picklist, and it was
// found to silently omit real technicians who don't happen to be in that
// account's suggestion list.
function transformSheetToDispatch(sheet) {
  const { COLUMNS, emailToName } = resolveColumns(sheet);
  const cellFor = (row, column) => row.cells.find((c) => c.columnId === column.id);

  const workerNames = new Set();
  (COLUMNS.lead.contactOptions || []).forEach((c) => c.name && workerNames.add(c.name));
  (COLUMNS.technicians.contactOptions || []).forEach((c) => c.name && workerNames.add(c.name));

  const jobs = [];
  sheet.rows.forEach((row) => {
    const project = cellText(cellFor(row, COLUMNS.project));
    const date = cellText(cellFor(row, COLUMNS.date));
    if (!project || !date) return;

    const address = cellText(cellFor(row, COLUMNS.address));
    const startTime = cellText(cellFor(row, COLUMNS.startTime));
    // Rows with neither an address nor a start time aren't real jobs — the
    // sheet has at least one non-job banner row (e.g. a confidentiality
    // notice) that only fills in Project/Date/POC to look non-blank.
    if (!address && !startTime) return;

    // Row attachments (populated by include=attachments on fetchSheet). Only
    // id/name/mimeType are kept — the actual download url is fetched on demand
    // per click (fetchAttachment) since Smartsheet's are short-lived.
    const attachments = (row.attachments || [])
      .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType || '', type: a.attachmentType || '' }))
      .filter((a) => a.id && a.name);

    const status = cellText(cellFor(row, COLUMNS.status));
    const crewSizeRaw = cellText(cellFor(row, COLUMNS.crewSize));
    const crewSize = crewSizeRaw ? parseInt(crewSizeRaw, 10) : null;
    const lead = techNamesFromCell(cellFor(row, COLUMNS.lead), emailToName);
    const technicians = techNamesFromCell(cellFor(row, COLUMNS.technicians), emailToName);
    lead.forEach((n) => workerNames.add(n));
    technicians.forEach((n) => workerNames.add(n));

    // A job struck through in Smartsheet (line through the whole row) means it's
    // cancelled. Smartsheet's cell `format` descriptor is a comma-separated
    // string of format indices; index 5 is the strikethrough flag (1 = on),
    // confirmed against the real cancelled rows. Check the Project cell, which
    // gets struck when the whole row is.
    const projFmt = (cellFor(row, COLUMNS.project) || {}).format || '';
    const cancelled = projFmt.split(',')[5] === '1';

    // "Proj Rpt Rec'd" checkbox: a checked box has cell.value === true; an
    // unchecked one usually has no cell entry at all, so absent === false.
    const rptCell = COLUMNS.reportReceived ? cellFor(row, COLUMNS.reportReceived) : null;
    const reportReceived = !!(rptCell && (rptCell.value === true || rptCell.value === 'true'));

    jobs.push({
      id: 'ss-' + row.id,
      date,
      project,
      address,
      startTime,
      duration: cellText(cellFor(row, COLUMNS.duration)),
      client: cellMultiValues(cellFor(row, COLUMNS.client)).join(', '),
      status: STATUS_VALUES.has(status) ? status : '',
      lead,
      technicians,
      crewSize: crewSize && crewSize > 0 ? crewSize : null,
      poc: cellMultiValues(cellFor(row, COLUMNS.poc)).join('; '),
      notes: cellText(cellFor(row, COLUMNS.notes)),
      attachments,
      cancelled,
      reportReceived,
    });
  });

  const workers = Array.from(workerNames)
    .sort()
    .map((name) => ({ name, active: true }));

  return { workers, jobs };
}

// Fetches the submitted Daily Project Report row(s) for one job from the report
// sheet, matched on the hidden "Job ID" cell (the "ss-<rowid>" the app button
// stamps). Two light calls: a sheet search to find candidate row ids, then a
// rowIds-filtered read for their full cells. Returns the latest matching row as
// an ordered {label,value} field list (empty cells and the Job ID column
// dropped). { found:false } when no report carries this job's id (e.g. it was
// filed from the bare form, or none exists yet). jobId is "ss-<rowid>".
async function fetchReportByJobId(reportSheetId, jobId) {
  const term = String(jobId);
  const headers = { Authorization: `Bearer ${getToken()}` };

  const sres = await fetch(`${SMARTSHEET_API_BASE}/search/sheets/${reportSheetId}?query=${encodeURIComponent(term)}`, { headers });
  if (!sres.ok) {
    const t = await sres.text().catch(() => '');
    throw new Error(`Smartsheet search error ${sres.status}: ${t}`);
  }
  const sjson = await sres.json();
  const rowIds = [...new Set((sjson.results || [])
    .filter((r) => r.objectType === 'row' && r.objectId != null)
    .map((r) => String(r.objectId)))];
  if (!rowIds.length) return { found: false };

  const rres = await fetch(`${SMARTSHEET_API_BASE}/sheets/${reportSheetId}?rowIds=${rowIds.join(',')}&include=objectValue`, { headers });
  if (!rres.ok) {
    const t = await rres.text().catch(() => '');
    throw new Error(`Smartsheet rows error ${rres.status}: ${t}`);
  }
  const sheet = await rres.json();
  const cols = sheet.columns || [];
  const jobIdCol = cols.find((c) => c.title === 'Job ID');

  // Keep only rows whose Job ID cell exactly equals the job's id (search can
  // also hit the substring inside a longer note); newest (by createdAt) first.
  const matches = (sheet.rows || []).filter((row) => {
    if (!jobIdCol) return true;
    const cell = (row.cells || []).find((c) => c.columnId === jobIdCol.id);
    const v = cell ? (cell.value != null ? cell.value : cell.displayValue || '') : '';
    return String(v).trim() === term;
  });
  if (!matches.length) return { found: false };
  matches.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const row = matches[0];

  const orderedCols = cols.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const fields = [];
  orderedCols.forEach((c) => {
    if (c.title === 'Job ID') return; // internal linking field, not report content
    const cell = (row.cells || []).find((x) => x.columnId === c.id);
    if (!cell) return;
    let val;
    if (cell.objectValue && Array.isArray(cell.objectValue.values)) val = cellMultiValues(cell).join(', ');
    else if (c.type === 'CHECKBOX') val = (cell.value === true || cell.value === 'true') ? 'Yes' : '';
    else val = cellText(cell);
    if (val == null || String(val).trim() === '') return;
    fields.push({ label: c.title, value: String(val) });
  });

  return { found: true, rowId: String(row.id), createdAt: row.createdAt || null, matchCount: matches.length, fields };
}

module.exports = {
  fetchSheet,
  fetchAttachment,
  fetchSheetColumns,
  fetchRowsModifiedSince,
  putRows,
  transformSheetToDispatch,
  resolveColumns,
  updateJobCrew,
  fetchReportByJobId,
};
