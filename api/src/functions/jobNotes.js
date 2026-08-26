const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { fetchSheet, resolveColumns, updateJobNotes } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { audit } = require('../lib/audit');

// Two-way "Work Order Notes" editing from the app's job detail popup. Writes
// the note back to the same "Work Order Notes" cell the board already reads,
// so editing in the app and editing in Smartsheet stay in sync. Editors only
// (same bar as reassigning crew / creating a job) — the third deliberate
// write carve-out alongside jobCrew.js and jobCreate.js.
const MAX_NOTES = 4000; // Smartsheet cell text cap is ~4k; reject longer to fail loudly

app.http('jobNotes', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs/{jobId}/notes',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);

      const rowId = String(request.params.jobId || '').replace(/^ss-/, '');
      if (!/^\d{6,}$/.test(rowId)) {
        return { status: 400, jsonBody: { error: 'Invalid job id' } };
      }
      const body = await request.json().catch(() => ({}));
      const notes = String(body.notes == null ? '' : body.notes);
      if (notes.length > MAX_NOTES) {
        return { status: 400, jsonBody: { error: `Notes too long (max ${MAX_NOTES} characters)` } };
      }

      const sheet = await fetchSheet();
      const { COLUMNS } = resolveColumns(sheet);
      await updateJobNotes(rowId, COLUMNS.notes.id, notes);

      audit(context, user, 'dispatch.job.notes', { jobId: rowId, len: notes.length });

      // Re-sync immediately so the board reflects the new note right away.
      const result = await runSync(context, true);
      return { jsonBody: { ...result, saved: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
