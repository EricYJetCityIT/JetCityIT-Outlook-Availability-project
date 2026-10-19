const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { sanitizeNames, writeInactiveNames, InactiveConflict } = require('../lib/crewInactive');
const { audit } = require('../lib/audit');

// PUT /api/dispatch/inactive-crew  { names: ["First L", ...], expect: "<version>" } --
// replaces the list of people hidden from Assign crew, the Individual availability view
// and the weekly availability reminder (see lib/crewInactive.js). `expect` is the list
// version the editor's screen was showing (GET /api/dispatch returns it as
// `inactiveVersion`); if someone saved since, this answers 409 instead of overwriting.
// Editors only: it changes what everyone sees. Nothing is deleted anywhere -- jobs keep
// their assignments, Smartsheet is untouched, and removing a name brings the person back.
app.http('crewInactive', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'dispatch/inactive-crew',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);
      const body = await request.json().catch(() => null);
      const names = body ? sanitizeNames(body.names) : null;
      if (!names || typeof body.expect !== 'string') return { status: 400, jsonBody: { error: 'Expected { names: [...], expect: "<version>" }' } };
      let doc;
      try {
        doc = await writeInactiveNames(names, user.upn || user.name || null, body.expect);
      } catch (e) {
        if (e instanceof InactiveConflict) return { status: 409, jsonBody: { error: 'Someone else changed the inactive list. It has been reloaded; check it and save again.' } };
        throw e;
      }
      audit(context, user, 'crew.inactive.set', { count: names.length });
      return { jsonBody: { ok: true, names: doc.names, version: doc.updatedAt } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
