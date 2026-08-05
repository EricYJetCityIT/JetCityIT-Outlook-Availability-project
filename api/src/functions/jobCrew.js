const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { fetchSheet, resolveColumns, updateJobCrew } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');

// The one write path back into Smartsheet, deliberately narrow: only the
// lead/technician assignment on an existing job. Everything else about a
// job (address, time, notes, creating/deleting jobs) stays Smartsheet-only,
// per the user's choice to keep this a small carve-out rather than
// reopening full Dispatch editing on the site.
app.http('jobCrew', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs/{jobId}/crew',
  handler: async (request, context) => {
    try {
      await requireUser(request);

      const rowId = request.params.jobId.replace(/^ss-/, '');
      const body = await request.json();
      const leadNames = Array.isArray(body.lead) ? body.lead : [];
      const technicianNames = Array.isArray(body.technicians) ? body.technicians : [];

      const sheet = await fetchSheet();
      const { COLUMNS, emailToName } = resolveColumns(sheet);
      const nameToEmail = new Map();
      emailToName.forEach((name, email) => nameToEmail.set(name, email));

      await updateJobCrew(rowId, COLUMNS.lead.id, COLUMNS.technicians.id, leadNames, technicianNames, nameToEmail);

      // Re-sync immediately so the site reflects the change right away
      // instead of waiting for the next scheduled poll.
      const result = await runSync(context, true);
      return { jsonBody: result };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
