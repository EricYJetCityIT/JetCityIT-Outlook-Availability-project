const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { listUsers } = require('../lib/graph');

// Company directory (name + email) for the Forward-report recipient picker, so
// editors can send a report to anyone at JCIT, not just the client contacts.
// Editors only. Cached in-memory for an hour (per Function instance) to avoid
// hammering Graph on every Forward. Uses the app's already-granted
// User.Read.All (same permission the availability reminder's directory
// fallback relies on).
let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 60 * 1000;

app.http('directory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'directory',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);
      if (cache && Date.now() - cacheAt < TTL_MS) return { jsonBody: cache };
      const users = await listUsers();
      const seen = {};
      const out = [];
      users.forEach((u) => {
        const email = String(u.mail || '').trim();
        if (!email) return;
        const k = email.toLowerCase();
        if (seen[k]) return;
        seen[k] = 1;
        out.push({ name: u.displayName || email, email });
      });
      out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      cache = { users: out };
      cacheAt = Date.now();
      return { jsonBody: cache };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
