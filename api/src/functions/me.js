const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');

// Returns the caller's identity + whether they may edit data, so the frontend
// can hide/disable "change" controls for read-only users. This is a UX aid
// only — the real enforcement is server-side in each write endpoint.
app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      return { jsonBody: { upn: user.upn, name: user.name, isEditor: user.isEditor } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
