const { app } = require('@azure/functions');

// Temporary diagnostic endpoint — remove after debugging the unexpected
// Authorization header on /api/* requests. Not auth-gated on purpose.
app.http('debugHeaders', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'debugHeaders',
  handler: async (request) => {
    return { jsonBody: { headers: Object.fromEntries(request.headers.entries()) } };
  },
});
