const { app } = require('@azure/functions');
const { getContainer } = require('../lib/cosmos');
const { fetchRowsModifiedSince, putRows } = require('../lib/smartsheet');
const { safeEqual } = require('../lib/secure');

const CONTAINER_ID = 'dispatch';
const CURSOR_DOC_ID = 'report-match-state';

// The "Job ID" hidden field on the Daily Project Report form carries this
// job's Crew Calendar row id (as "ss-<rowid>", kept textual so the ~16-digit
// id isn't mangled). We strip the prefix and use the digits as the row id to
// write back to the calendar.
const JOB_ID_COLUMN_TITLE = 'Job ID';
const RPT_RECEIVED_COLUMN_TITLE = "Proj Rpt Rec'd";
const REPORT_PROJECT_TITLE = 'Project Name';
const REPORT_DATE_TITLE = 'Service Date';
const CAL_PROJECT_TITLE = 'Project';
const CAL_DATE_TITLE = 'Date';

const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const dayOf = (v) => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; };

// Which Crew Calendar row each report should tick. reports: [{jobRowId,
// project, date}]; calRows: [{id, project, date}]. Returns {ids:Set, moved,
// byName}.
//  - The Job ID's row, when its date matches the report's Service Date (the
//    normal case) or the report has no date.
//  - When the dates differ -- the tech opened the Daily report link from
//    ANOTHER day's job of the same project (seen 11/2026: a T-Mobile 11/9
//    report carried the 11/2 job's id, so 11/9 kept getting overdue emails) --
//    the same-named project's row on the Service Date instead, if there is
//    exactly one. Otherwise the Job ID's row as before (e.g. an extra day with
//    no calendar row of its own).
//  - No Job ID (filed from the bare form link, e.g. the reminder email): the
//    one row with that exact project name on that Service Date, if exactly one.
function resolveTargets(reports, calRows) {
  const byId = new Map(calRows.map((r) => [r.id, r]));
  const byNameDay = new Map();
  calRows.forEach((r) => {
    if (!r.date || !r.project) return;
    const k = normName(r.project) + '|' + r.date;
    byNameDay.set(k, (byNameDay.get(k) || []).concat(r));
  });
  const sameDay = (project, date) => {
    const hits = (project && date) ? (byNameDay.get(normName(project) + '|' + date) || []) : [];
    return hits.length === 1 ? hits[0] : null;
  };
  const ids = new Set();
  let moved = 0, byName = 0;
  reports.forEach((rep) => {
    if (rep.jobRowId) {
      const cal = byId.get(rep.jobRowId);
      if (cal && rep.date && cal.date && cal.date !== rep.date) {
        const right = sameDay(cal.project || rep.project, rep.date) || sameDay(rep.project, rep.date);
        if (right) { ids.add(right.id); moved++; return; }
      }
      ids.add(rep.jobRowId);
      return;
    }
    const hit = sameDay(rep.project, rep.date);
    if (hit) { ids.add(hit.id); byName++; }
  });
  return { ids, moved, byName };
}

function getReportSheetId() {
  const id = process.env.REPORT_SHEET_ID;
  if (!id) throw new Error('REPORT_SHEET_ID is not configured');
  return id;
}

function getCalendarSheetId() {
  const id = process.env.SMARTSHEET_SHEET_ID;
  if (!id) throw new Error('SMARTSHEET_SHEET_ID is not configured');
  return id;
}

// "ss-8449556404457348" (or "8449556404457348") -> "8449556404457348".
// Returns null for anything that isn't a plausible Smartsheet row id, so a
// blank/garbage Job ID cell is simply skipped. Kept as a STRING throughout —
// Smartsheet accepts a string row id in the PUT body (updateJobCrew relies on
// the same), which sidesteps any 2^53 precision loss on a 16-digit id.
function parseCalRowId(raw) {
  if (raw == null) return null;
  const digits = String(raw).trim().replace(/^ss-/i, '');
  return /^\d{6,}$/.test(digits) ? digits : null;
}

async function readCursor(container) {
  try {
    const { resource } = await container.item(CURSOR_DOC_ID, CURSOR_DOC_ID).read();
    return resource || null;
  } catch (e) {
    if (e.code === 404) return null;
    throw e;
  }
}

// Reads Daily Project Report rows submitted since the last run and ticks
// "Proj Rpt Rec'd" on the Crew Calendar row each one is for -- normally the
// row its hidden Job ID names, corrected to the right day when the report's
// Service Date says otherwise, and matched by exact project name + date when
// there's no Job ID (see resolveTargets). Only ever SETS the box true — it
// never unchecks, so manual ticks and history are preserved. Idempotent:
// re-ticking an already-checked row is a harmless no-op.
async function runReportMatch(context) {
  const container = getContainer(CONTAINER_ID);
  const cursor = await readCursor(container);
  const now = new Date().toISOString();

  // First run: don't backfill. Historical reports predate the Job ID field,
  // so there's nothing to match — just plant the cursor and start watching
  // from now on.
  if (!cursor || !cursor.lastModifiedSince) {
    await container.items.upsert({ id: CURSOR_DOC_ID, lastModifiedSince: now, lastCheckedAt: now });
    context.log('report-match: initialized cursor, no backfill.');
    return { initialized: true, checked: 0 };
  }

  const reportSheet = await fetchRowsModifiedSince(getReportSheetId(), cursor.lastModifiedSince);
  const jobIdCol = (reportSheet.columns || []).find((c) => c.title === JOB_ID_COLUMN_TITLE);
  if (!jobIdCol) {
    throw new Error(`Report sheet column "${JOB_ID_COLUMN_TITLE}" not found — add it to the form/sheet first`);
  }

  const newRows = reportSheet.rows || [];
  const colId = (title) => ((reportSheet.columns || []).find((c) => c.title === title) || {}).id;
  const repProjectCol = colId(REPORT_PROJECT_TITLE), repDateCol = colId(REPORT_DATE_TITLE);
  const cellOf = (row, id) => (id == null ? null : (row.cells || []).find((c) => c.columnId === id));
  const textOf = (cell) => (cell ? String(cell.value != null ? cell.value : (cell.displayValue || '')).trim() : '');
  const reports = newRows.map((row) => {
    const cell = cellOf(row, jobIdCol.id);
    return {
      jobRowId: parseCalRowId(cell && (cell.value != null ? cell.value : cell.displayValue)),
      project: textOf(cellOf(row, repProjectCol)),
      date: dayOf(textOf(cellOf(row, repDateCol))),
    };
  }).filter((r) => r.jobRowId || (r.project && r.date));

  let checked = 0;
  let failed = 0;
  let moved = 0;
  let byName = 0;
  if (reports.length) {
    const calId = getCalendarSheetId();
    // Whole calendar (columns + rows): needed to check each report's date
    // against its job's date. Only read when new reports came in.
    const cal = await fetchRowsModifiedSince(calId);
    const columns = cal.columns || [];
    const rptCol = columns.find((c) => c.title === RPT_RECEIVED_COLUMN_TITLE);
    if (!rptCol) {
      throw new Error(`Calendar column "${RPT_RECEIVED_COLUMN_TITLE}" not found — sheet layout may have changed`);
    }
    const calProjectId = (columns.find((c) => c.title === CAL_PROJECT_TITLE) || {}).id;
    const calDateId = (columns.find((c) => c.title === CAL_DATE_TITLE) || {}).id;
    const calRows = (cal.rows || []).map((r) => ({
      id: String(r.id),
      project: textOf(cellOf(r, calProjectId)),
      date: dayOf(textOf(cellOf(r, calDateId))),
    }));
    const target = resolveTargets(reports, calRows);
    moved = target.moved; byName = target.byName;
    const wantedIds = target.ids;
    const body = Array.from(wantedIds).map((id) => ({ id, cells: [{ columnId: rptCol.id, value: true }] }));
    // allowPartialSuccess so one stale Job ID (a since-deleted calendar row)
    // doesn't reject every other tick in the batch.
    const result = await putRows(calId, body, { allowPartialSuccess: true });
    checked = (result.result || []).length;
    failed = (result.failedItems || []).length;
  }

  await container.items.upsert({
    id: CURSOR_DOC_ID,
    lastModifiedSince: now,
    lastCheckedAt: now,
    lastCheckedCount: checked,
  });

  context.log(`report-match: ${newRows.length} new report row(s), checked ${checked}, failed ${failed}, moved to the service date ${moved}, matched by name ${byName}.`);
  return { newReportRows: newRows.length, checked, failed, moved, byName };
}

// HTTP-triggered (same reason as smartsheetSync — SWA managed Functions don't
// run Timer triggers) and called on the same GitHub Actions cron, gated by
// the shared SYNC_SECRET.
app.http('reportMatch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'report-match',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || !safeEqual(provided, expected)) {
      return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    }

    try {
      const result = await runReportMatch(context);
      return { jsonBody: result };
    } catch (e) {
      context.error('report-match failed:', e);
      return { status: 500, jsonBody: { error: 'report-match failed' } };
    }
  },
});

module.exports = { runReportMatch, resolveTargets };
