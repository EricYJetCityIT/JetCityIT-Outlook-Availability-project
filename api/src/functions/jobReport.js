const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { fetchSheet, resolveColumns, updateReportReceived } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { audit } = require('../lib/audit');

// Manually check/uncheck a job's "Proj Rpt Rec'd" box from the Project-reports
// popup's "Mark report complete" button. Editors only. Complements the existing
// auto-check (reportMatch.js), which ticks it when a Daily Report is filed via
// the app — this lets a manager mark it done by hand. Fifth write carve-out.
app.http('jobReport', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs/{jobId}/report-received',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);

      const rowId = String(request.params.jobId || '').replace(/^ss-/, '');
      if (!/^\d{6,}$/.test(rowId)) {
        return { status: 400, jsonBody: { error: 'Invalid job id' } };
      }
      const body = await request.json().catch(() => ({}));
      const received = body.received === true || body.received === 'true' || body.received === 1;

      const sheet = await fetchSheet();
      const { COLUMNS } = resolveColumns(sheet);
      if (!COLUMNS.reportReceived) {
        return { status: 400, jsonBody: { error: '"Proj Rpt Rec\'d" column not found on the sheet' } };
      }
      await updateReportReceived(rowId, COLUMNS.reportReceived.id, received);

      audit(context, user, 'dispatch.job.reportReceived', { jobId: rowId, received });

      const result = await runSync(context, true);
      return { jsonBody: { ...result, received, saved: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
