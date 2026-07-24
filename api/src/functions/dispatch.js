const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');

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
      await requireUser(request);
      const container = getContainer(CONTAINER_ID);

      if (request.method === 'GET') {
        try {
          const { resource } = await container.item(DOC_ID, DOC_ID).read();
          return {
            jsonBody: resource
              ? { workers: resource.workers, jobs: resource.jobs, updatedAt: resource.updatedAt || null, source: resource.source || null }
              : { workers: [], jobs: [], updatedAt: null, source: null },
          };
        } catch (e) {
          if (e.code === 404) return { jsonBody: { workers: [], jobs: [], updatedAt: null, source: null } };
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
