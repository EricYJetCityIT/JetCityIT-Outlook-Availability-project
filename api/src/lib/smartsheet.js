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
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${getSheetId()}?include=objectValue`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Smartsheet API error ${res.status}: ${text}`);
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

// The "JCIT Lead"/"Technicians" columns are meant to only ever hold real
// people picked from the directory, but in practice a few rows have stray
// free text typed into them instead (e.g. a scheduling note, or a
// placeholder like "Optional - Open Event") and a few resolve to only a
// bare email with no name attached to that particular cell entry (even
// though the same email has a real name elsewhere via contactOptions).
// This resolves emails to their real name via emailToName and drops
// anything that isn't a real contact (a bare object value or matched
// email) rather than accepting arbitrary strings as if they were names.
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
      if (v.name) { names.push(v.name); return; }
      if (v.email) { addResolved(v.email); return; }
    });
  } else if (cell && cell.displayValue) {
    cell.displayValue.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
      if (EMAIL_RE.test(s)) addResolved(s);
      else names.push(s); // no objectValue to check against — best effort
    });
  }
  return names;
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
  };

  const cellFor = (row, column) => row.cells.find((c) => c.columnId === column.id);

  const emailToName = new Map();
  (COLUMNS.lead.contactOptions || []).forEach((c) => c.email && c.name && emailToName.set(c.email.toLowerCase(), c.name));
  (COLUMNS.technicians.contactOptions || []).forEach((c) => c.email && c.name && emailToName.set(c.email.toLowerCase(), c.name));

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

    const status = cellText(cellFor(row, COLUMNS.status));
    const crewSizeRaw = cellText(cellFor(row, COLUMNS.crewSize));
    const crewSize = crewSizeRaw ? parseInt(crewSizeRaw, 10) : null;
    const lead = techNamesFromCell(cellFor(row, COLUMNS.lead), emailToName);
    const technicians = techNamesFromCell(cellFor(row, COLUMNS.technicians), emailToName);
    lead.forEach((n) => workerNames.add(n));
    technicians.forEach((n) => workerNames.add(n));

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
    });
  });

  const workers = Array.from(workerNames)
    .sort()
    .map((name) => ({ name, active: true }));

  return { workers, jobs };
}

module.exports = { fetchSheet, transformSheetToDispatch };
