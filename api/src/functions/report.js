const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { fetchReportByJobId } = require('../lib/smartsheet');

// Returns the submitted Daily Project Report for one job (matched by the hidden
// "Job ID" the app's report button stamps), so the Manager "Project reports"
// view can show what a crew filed. Read-only; any signed-in @jetcityit.com user
// may call it (same bar as /api/dispatch), but the UI only surfaces it in the
// editor-gated Manager tab.
function getReportSheetId() {
  const id = process.env.REPORT_SHEET_ID;
  if (!id) throw new Error('REPORT_SHEET_ID is not configured');
  return id;
}

app.http('report', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'report',
  handler: async (request, context) => {
    try {
      await requireUser(request);
      const jobId = (new URL(request.url).searchParams.get('jobId') || '').trim();
      if (!/^ss-\d{6,}$/.test(jobId)) {
        return { status: 400, jsonBody: { error: 'Invalid or missing jobId' } };
      }
      const result = await fetchReportByJobId(getReportSheetId(), jobId);
      return { jsonBody: result };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
