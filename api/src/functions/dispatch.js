const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');

const CONTAINER_ID = 'dispatch';
const DOC_ID = 'state';

// Mirrors the JCITDispatch module's load()/save() — a single shared
// document holding the whole worker roster + job list (matches the
// existing jetcityit.dispatch.v1 localStorage shape).
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
          return {
            jsonBody: resource ? { workers: resource.workers, jobs: resource.jobs } : { workers: [], jobs: [] },
          };
        } catch (e) {
          if (e.code === 404) return { jsonBody: { workers: [], jobs: [] } };
          throw e;
        }
      }

      const body = await request.json();
      const doc = {
        id: DOC_ID,
        workers: body.workers || [],
        jobs: body.jobs || [],
        updatedBy: user.upn,
        updatedAt: new Date().toISOString(),
      };
      await container.items.upsert(doc);
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
