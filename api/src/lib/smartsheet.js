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

// Maps the sheet's columns/rows onto the app's {workers, jobs} schema
// (see JCITDispatch in index.html for the exact shape this must match).
// Rows without a Project name or Date are treated as blank/placeholder
// rows and skipped. The worker roster comes from the union of the "JCIT
// Lead" and "Technicians" columns' contact options, not from scanning row
// data — that list is the sheet's own authoritative "who can be assigned"
// roster and stays correct automatically as people are added/removed there.
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

  const jobs = [];
  sheet.rows.forEach((row) => {
    const project = cellText(cellFor(row, COLUMNS.project));
    const date = cellText(cellFor(row, COLUMNS.date));
    if (!project || !date) return;

    const status = cellText(cellFor(row, COLUMNS.status));
    const crewSizeRaw = cellText(cellFor(row, COLUMNS.crewSize));
    const crewSize = crewSizeRaw ? parseInt(crewSizeRaw, 10) : null;

    jobs.push({
      id: 'ss-' + row.id,
      date,
      project,
      address: cellText(cellFor(row, COLUMNS.address)),
      startTime: cellText(cellFor(row, COLUMNS.startTime)),
      duration: cellText(cellFor(row, COLUMNS.duration)),
      client: cellMultiValues(cellFor(row, COLUMNS.client)).join(', '),
      status: STATUS_VALUES.has(status) ? status : '',
      lead: cellMultiValues(cellFor(row, COLUMNS.lead)),
      technicians: cellMultiValues(cellFor(row, COLUMNS.technicians)),
      crewSize: crewSize && crewSize > 0 ? crewSize : null,
      poc: cellMultiValues(cellFor(row, COLUMNS.poc)).join('; '),
      notes: cellText(cellFor(row, COLUMNS.notes)),
    });
  });

  const workerNames = new Set();
  (COLUMNS.lead.contactOptions || []).forEach((c) => c.name && workerNames.add(c.name));
  (COLUMNS.technicians.contactOptions || []).forEach((c) => c.name && workerNames.add(c.name));
  const workers = Array.from(workerNames)
    .sort()
    .map((name) => ({ name, active: true }));

  return { workers, jobs };
}

module.exports = { fetchSheet, transformSheetToDispatch };
