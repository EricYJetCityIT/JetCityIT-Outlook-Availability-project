const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { fetchSheet, resolveColumns, updateJobStatus } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { audit } = require('../lib/audit');

// Sets a job's Status in Smartsheet from the app's detail popup — currently the
// Cancel/Restore button (status 'Cancelled' to cancel, '' to restore). Editors
// only. Fourth write carve-out alongside jobCrew.js, jobCreate.js, jobNotes.js.
// Allowed values mirror the sheet's Status picklist; '' clears it.
const ALLOWED = new Set(['', 'Not Started', 'In Progress', 'Complete', 'Cancelled', 'Postponed']);

app.http('jobStatus', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs/{jobId}/status',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);

      const rowId = String(request.params.jobId || '').replace(/^ss-/, '');
      if (!/^\d{6,}$/.test(rowId)) {
        return { status: 400, jsonBody: { error: 'Invalid job id' } };
      }
      const body = await request.json().catch(() => ({}));
      const status = String(body.status == null ? '' : body.status).trim();
      if (!ALLOWED.has(status)) {
        return { status: 400, jsonBody: { error: 'Invalid status' } };
      }

      const sheet = await fetchSheet();
      const { COLUMNS } = resolveColumns(sheet);
      await updateJobStatus(rowId, COLUMNS.status.id, status);

      audit(context, user, 'dispatch.job.status', { jobId: rowId, status: status || '(cleared)' });

      const result = await runSync(context, true);
      return { jsonBody: { ...result, status, saved: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
