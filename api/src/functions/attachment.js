const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { fetchAttachment } = require('../lib/smartsheet');

// Hands the browser a fresh, short-lived download URL for one Smartsheet
// attachment. The attachment ids come from the synced dispatch doc (see
// smartsheet.js — each job carries an `attachments` list of {id, name}).
//
// Read model matches the rest of job detail: any signed-in @jetcityit.com
// user may open an attachment, same as they can already see a job's address,
// POC, and notes. The Smartsheet API token never leaves the server — the
// client only ever receives the temporary URL, which it opens directly.
app.http('attachment', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'attachment/{id}',
  handler: async (request, context) => {
    try {
      await requireUser(request);

      const id = request.params.id;
      if (!id) return { status: 400, jsonBody: { error: 'Missing attachment id' } };

      let att;
      try {
        att = await fetchAttachment(id);
      } catch (e) {
        // A bad/stale attachment id surfaces as a Smartsheet 404 — report it
        // as not-found rather than a generic 500.
        if (/\b404\b/.test(String(e && e.message))) {
          return { status: 404, jsonBody: { error: 'Attachment not found' } };
        }
        throw e;
      }

      if (!att || !att.url) return { status: 404, jsonBody: { error: 'Attachment not found' } };
      return { jsonBody: { url: att.url, name: att.name || null, mimeType: att.mimeType || null } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
