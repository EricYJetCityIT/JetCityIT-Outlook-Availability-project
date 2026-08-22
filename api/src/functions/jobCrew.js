const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { fetchSheet, resolveColumns, updateJobCrew } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { listUsers, matchDirectoryUser } = require('../lib/graph');
const { audit } = require('../lib/audit');

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
      const user = await requireUser(request);
      requireEditor(user); // reassigning crew changes shared job data — editors only

      const rowId = request.params.jobId.replace(/^ss-/, '');
      const body = await request.json();
      const leadNames = Array.isArray(body.lead) ? body.lead : [];
      const technicianNames = Array.isArray(body.technicians) ? body.technicians : [];

      const sheet = await fetchSheet();
      const { COLUMNS, emailToName } = resolveColumns(sheet);
      const nameToEmail = new Map();
      emailToName.forEach((name, email) => nameToEmail.set(name, email));

      // Smartsheet's contactOptions is only its "suggested contacts", so it
      // misses people who are on the roster but not recently suggested (e.g.
      // Eve N, Luke Peterson). updateJobCrew would silently DROP any name it
      // can't map to an email, so fall back to the company directory for those
      // — otherwise "add crew" appears to not save. Names still unresolved
      // (no directory match) are returned so the UI can say so.
      const allNames = [...new Set([...leadNames, ...technicianNames])];
      const needDir = allNames.filter((n) => !nameToEmail.get(n));
      const unresolved = [];
      if (needDir.length) {
        let dir = [];
        try { dir = await listUsers(); } catch (e) { context.error('jobCrew directory lookup failed:', e); }
        needDir.forEach((n) => {
          const email = matchDirectoryUser(n, dir);
          if (email) nameToEmail.set(n, email);
          else unresolved.push(n);
        });
      }

      await updateJobCrew(rowId, COLUMNS.lead.id, COLUMNS.technicians.id, leadNames, technicianNames, nameToEmail);

      audit(context, user, 'dispatch.jobCrew.update', { jobId: rowId, lead: leadNames.length, technicians: technicianNames.length, unresolved: unresolved.length });

      // Re-sync immediately so the site reflects the change right away
      // instead of waiting for the next scheduled poll.
      const result = await runSync(context, true);
      return { jsonBody: { ...result, unresolved } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
