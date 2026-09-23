const { randomUUID } = require('crypto');
const { getContainer } = require('./cosmos');

// Attribution/job-costing log for the Job Sheets tab. The app writes to
// Smartsheet as ONE shared admin token, so Smartsheet's own "modified by" /
// attachment "created by" is always "the app" -- never the actual tech. This
// stamps who+when at the app layer instead (Entra knows who), one doc per
// write, in the same `dispatch` Cosmos container every other feature uses
// (namespaced `jsact:<uuid>` so it never collides with jobs/plans/contacts).
// Purpose per Dylan: internal job-costing data (labor time + pace per tech,
// per item type), NOT client-facing -- so this is intentionally a write-only
// log for now; no reporting UI reads it yet.
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'jsact:';

function clean(s, max) {
  return String(s == null ? '' : s).slice(0, max);
}

// `capturedAt` is when the TECH performed the action, not when it reached the
// server -- for an offline-queued write those can differ by up to the outbox
// window (~30-60 min per Dylan), and job-costing needs the real moment, not
// sync latency. Callers pass it through from the client; `createdAt` here is
// always the server's own receive time, for the offline-vs-live gap itself.
// Never throws -- a logging failure must never break the actual Smartsheet
// write it's attached to; this is best-effort telemetry, not the source of
// truth (Smartsheet is).
async function logJobSheetActivity(entry, context) {
  try {
    const container = getContainer(CONTAINER_ID);
    const capturedAt = entry.capturedAt && !Number.isNaN(Date.parse(entry.capturedAt))
      ? new Date(entry.capturedAt).toISOString()
      : new Date().toISOString();
    const doc = {
      id: ID_PREFIX + randomUUID(),
      type: 'jobSheetActivity',
      sheetId: clean(entry.sheetId, 60),
      sheetName: clean(entry.sheetName, 200),
      rowId: clean(entry.rowId, 60),
      rowLabel: clean(entry.rowLabel, 200),
      columnId: clean(entry.columnId, 60),
      columnLabel: clean(entry.columnLabel, 120),
      action: entry.action === 'photo' ? 'photo' : 'cell',
      user: clean(entry.user, 200),
      userName: clean(entry.userName || entry.user, 200),
      capturedAt,
      createdAt: new Date().toISOString(),
    };
    await container.items.create(doc);
  } catch (e) {
    // Swallowed by design -- see comment above; still logged if a context
    // (Azure Functions InvocationContext) was passed, for debuggability.
    try { context && context.error('jobsheet activity log failed', e); } catch (_) { /* never break on logging the failure to log */ }
  }
}

module.exports = { logJobSheetActivity };
