const { app } = require('@azure/functions');
const { requireUser, requirePlanner, authErrorResponse, AuthError } = require('../lib/auth');
const ss = require('../lib/smartsheet');

// Client sub-tabs in Project Planning (KP / PSE / Brooks; Project Planners only).
// Lists the job sheets at the top level of that client's Smartsheet workspace,
// newest first, so the tab can show how each job is going (progress comes from
// GET /api/plan-sheets?progress=<id>). Each key is scoped to ONE workspace;
// <KEY>_WORKSPACE_ID env vars override the defaults. Amazon has no workspace:
// Amazon tracks its jobs in its own Smartsheet account.
const ACCOUNTS = {
  kp: { label: 'KP', env: 'KP_WORKSPACE_ID', workspaceId: '4212706560501636' },
  pse: { label: 'PSE', env: 'PSE_WORKSPACE_ID', workspaceId: '3754485089625988' },
  brooks: { label: 'Brooks', env: 'BROOKS_WORKSPACE_ID', workspaceId: '4596587046430596' },
};
const MAX_SHEETS = 40;

// Blank starting points and copies marked not-for-use aren't jobs.
const isJunk = (name) => /^\s*template\b/i.test(name || '') || /do not use/i.test(name || '');

app.http('planAccountSheets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'plan-accounts/{key}/sheets',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      const key = String(request.params.key || '').toLowerCase();
      const acct = ACCOUNTS[key];
      if (!acct) return { status: 404, jsonBody: { error: 'No Smartsheet workspace for that client' } };
      const sheets = await ss.fetchWorkspaceSheets(process.env[acct.env] || acct.workspaceId);
      return {
        jsonBody: {
          label: acct.label,
          sheets: sheets.filter((s) => !isJunk(s.name)).slice(0, MAX_SHEETS)
            .map((s) => ({ id: s.id, name: s.name, modifiedAt: s.modifiedAt })),
        },
      };
    } catch (e) {
      if (e instanceof AuthError) return authErrorResponse(e, context);
      try { context.error(e); } catch (_) { /* logging must never break the response */ }
      return { status: 500, jsonBody: { error: 'Smartsheet lookup failed' } };
    }
  },
});
