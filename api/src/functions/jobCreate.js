const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { addJobRow } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { audit } = require('../lib/audit');

// In-app "Add job" — creates a new row in the "JCIT 2026 Crew Calendar"
// Smartsheet, then re-syncs so the board shows it immediately. Editors only
// (same bar as reassigning crew). This is the second deliberate write carve-out
// alongside jobCrew.js; everything else about a job (editing/deleting an
// existing one) still lives in Smartsheet. Crew is NOT set here — the new job
// is created unassigned and crew is added via the existing "Assign crew" flow.
const STATUS_VALUES = new Set(['In Progress', 'Complete', 'Cancelled', 'Postponed']);

app.http('jobCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user); // creating shared job data — editors only

      const body = await request.json().catch(() => ({}));
      const project = String(body.project || '').trim();
      const date = String(body.date || '').trim();
      if (!project) return { status: 400, jsonBody: { error: 'Project is required' } };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { status: 400, jsonBody: { error: 'A valid date (YYYY-MM-DD) is required' } };
      }
      const addressRaw = String(body.address || '').trim();
      const startTimeRaw = String(body.startTime || '').trim();
      if (!addressRaw && !startTimeRaw) {
        // transformSheetToDispatch (smartsheet.js) treats any row with neither
        // field as a non-job calendar note (holidays, reminders, quarter
        // headers already live in this sheet that way) and drops it from the
        // board — so a job created with both blank would write successfully
        // to Smartsheet and then silently never appear anywhere in the app.
        return { status: 400, jsonBody: { error: 'Address or start time is required so this job shows up on the board.' } };
      }
      const statusRaw = String(body.status || '').trim();
      const status = STATUS_VALUES.has(statusRaw) ? statusRaw : ''; // '' = "Scheduled" (blank in the sheet)

      const fields = {
        project,
        date,
        address: String(body.address || '').trim(),
        startTime: String(body.startTime || '').trim(),
        duration: String(body.duration || '').trim(),
        poc: String(body.poc || '').trim(),
        notes: String(body.notes || '').trim(),
        client: String(body.client || '').trim(),
        crewSize: body.crewSize,
        status,
      };

      const added = await addJobRow(fields);
      // Smartsheet's POST /rows returns { result: [{ id }] } — surface that new
      // row id so the client can attach any staged files to this job before it
      // re-pulls the board.
      const rowId = added && added.result && added.result[0] && added.result[0].id;
      audit(context, user, 'dispatch.job.create', { project, date });

      // Re-sync immediately so the new row shows on the board right away
      // instead of waiting for the next scheduled poll.
      const result = await runSync(context, true);
      return { jsonBody: { ...result, created: true, rowId: rowId ? String(rowId) : null } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
