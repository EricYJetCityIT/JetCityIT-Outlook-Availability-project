const { app } = require('@azure/functions');
const { getContainer } = require('../lib/cosmos');
const { fetchRowsModifiedSince, fetchSheetColumns, putRows } = require('../lib/smartsheet');

const CONTAINER_ID = 'dispatch';
const CURSOR_DOC_ID = 'report-match-state';

// The "Job ID" hidden field on the Daily Project Report form carries this
// job's Crew Calendar row id (as "ss-<rowid>", kept textual so the ~16-digit
// id isn't mangled). We strip the prefix and use the digits as the row id to
// write back to the calendar.
const JOB_ID_COLUMN_TITLE = 'Job ID';
const RPT_RECEIVED_COLUMN_TITLE = "Proj Rpt Rec'd";

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
// "Proj Rpt Rec'd" on the exact Crew Calendar row each one names via its
// hidden Job ID. Only ever SETS the box true — it never unchecks, so manual
// ticks and history are preserved. Idempotent: re-ticking an already-checked
// row is a harmless no-op, and reports with no Job ID (filed from the bare
// form link) are skipped by design.
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
  const wantedIds = new Set();
  for (const row of newRows) {
    const cell = (row.cells || []).find((c) => c.columnId === jobIdCol.id);
    const rowId = parseCalRowId(cell && (cell.value != null ? cell.value : cell.displayValue));
    if (rowId) wantedIds.add(rowId);
  }

  let checked = 0;
  let failed = 0;
  if (wantedIds.size) {
    const calId = getCalendarSheetId();
    const { columns } = await fetchSheetColumns(calId);
    const rptCol = columns.find((c) => c.title === RPT_RECEIVED_COLUMN_TITLE);
    if (!rptCol) {
      throw new Error(`Calendar column "${RPT_RECEIVED_COLUMN_TITLE}" not found — sheet layout may have changed`);
    }
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

  context.log(`report-match: ${newRows.length} new report row(s), checked ${checked}, failed ${failed}.`);
  return { newReportRows: newRows.length, checked, failed };
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
    if (!expected || provided !== expected) {
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

module.exports = { runReportMatch };
