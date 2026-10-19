const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { readInactive, applyInactive } = require('../lib/crewInactive');

const CONTAINER_ID = 'dispatch';
const DOC_ID = 'state';

// Mirrors the JCITDispatch module's load() — a single shared document
// holding the whole worker roster + job list. The Smartsheet sync
// (smartsheetSync.js, a timer trigger) is now the sole writer of this
// document, pulling from the "JCIT 2026 Crew Calendar" sheet — PUT is
// rejected so jobs/roster are only ever edited in Smartsheet, never here.
app.http('dispatch', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'dispatch',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      const container = getContainer(CONTAINER_ID);

      if (request.method === 'GET') {
        try {
          const { resource } = await container.item(DOC_ID, DOC_ID).read();
          // The inactive-crew list (see lib/crewInactive.js) is laid over the synced roster here,
          // so it takes effect immediately and survives every re-sync. If it can't be read the
          // board still loads (everyone shows), the failure is logged, and editors are told the
          // list is unavailable (inactiveError) so the Team screen can't mistake "unreadable" for
          // "empty" and save over the real list.
          let inactive = { names: [], version: '' }, inactiveError = false;
          try { inactive = await readInactive(container); } catch (e) { inactiveError = true; context.error('inactive crew list unreadable', e); }
          const extra = user.isEditor ? { inactiveNames: inactiveError ? [] : inactive.names, inactiveVersion: inactive.version, inactiveError } : { inactiveNames: [] };
          return {
            jsonBody: resource
              ? { workers: applyInactive(resource.workers, inactive.names), ...extra, jobs: resource.jobs, clientOptions: resource.clientOptions || [], updatedAt: resource.updatedAt || null, source: resource.source || null }
              : { workers: [], ...extra, jobs: [], clientOptions: [], updatedAt: null, source: null },
          };
        } catch (e) {
          if (e.code === 404) return { jsonBody: { workers: [], jobs: [], clientOptions: [], updatedAt: null, source: null } };
          throw e;
        }
      }

      return {
        status: 409,
        jsonBody: { error: 'Dispatch data now syncs automatically from the "JCIT 2026 Crew Calendar" Smartsheet — edit jobs there instead.' },
      };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
