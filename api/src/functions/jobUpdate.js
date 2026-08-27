const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { updateJobFields, deleteJobRow } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { audit } = require('../lib/audit');

// In-app "Edit job" (PUT) — updates an existing job row's editable fields
// (project, client, status, address, date, time, duration, crew size, POC,
// notes) in the "JCIT 2026 Crew Calendar" Smartsheet, then re-syncs. Also
// handles "Delete job" (DELETE) — permanently removes the row. Both editors
// only; crew is left untouched (assigned via the separate Assign crew flow).
app.http('jobUpdate', {
  methods: ['PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs/{jobId}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);

      const rowId = String(request.params.jobId || '').replace(/^ss-/, '');
      if (!/^\d{6,}$/.test(rowId)) {
        return { status: 400, jsonBody: { error: 'Invalid job id' } };
      }

      if (request.method === 'DELETE') {
        await deleteJobRow(rowId);
        audit(context, user, 'dispatch.job.delete', { jobId: rowId });
        const result = await runSync(context, true);
        return { jsonBody: { ...result, deleted: true } };
      }

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
        // Same guard as jobCreate: transformSheetToDispatch drops a row with
        // neither field as a non-job calendar note, so it would vanish from the
        // board. Reject rather than silently hide it.
        return { status: 400, jsonBody: { error: 'Address or start time is required so this job stays on the board.' } };
      }

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
        status: String(body.status || '').trim(),
      };

      await updateJobFields(rowId, fields);
      audit(context, user, 'dispatch.job.update', { jobId: rowId, project });

      const result = await runSync(context, true);
      return { jsonBody: { ...result, updated: true } };
    } catch (e) {
      // Auth/rate-limit errors carry a .status — keep their normal handling.
      if (e && e.status) return authErrorResponse(e, context);
      // Otherwise surface the real underlying error (e.g. the Smartsheet API
      // message) so the UI shows what actually failed, not a generic 500.
      context.error('jobUpdate failed:', e);
      return { status: 500, jsonBody: { error: String((e && e.message) || e).slice(0, 400) } };
    }
  },
});
