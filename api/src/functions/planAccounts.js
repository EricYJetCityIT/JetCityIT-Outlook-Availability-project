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

async function accountSheets(acct) {
  const sheets = await ss.fetchWorkspaceSheets(process.env[acct.env] || acct.workspaceId);
  return sheets.filter((s) => !isJunk(s.name)).slice(0, MAX_SHEETS);
}

function accountError(e, context) {
  if (e instanceof AuthError) return authErrorResponse(e, context);
  try { context.error(e); } catch (_) { /* logging must never break the response */ }
  return { status: 500, jsonBody: { error: 'Smartsheet lookup failed' } };
}

// GET /api/plan-accounts/{key}/sheet?id=<sheetId> -- one sheet from that
// client's workspace, read-only (stat cards + searchable table). Sheet ids
// from anywhere else are refused.
app.http('planAccountSheet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'plan-accounts/{key}/sheet',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      const acct = ACCOUNTS[String(request.params.key || '').toLowerCase()];
      if (!acct) return { status: 404, jsonBody: { error: 'No Smartsheet workspace for that client' } };
      const id = String(request.query.get('id') || '').trim();
      if (!/^\d{1,20}$/.test(id)) return { status: 400, jsonBody: { error: 'Missing sheet id' } };
      if (!(await accountSheets(acct)).some((s) => s.id === id)) {
        return { status: 404, jsonBody: { error: `That sheet is not in the ${acct.label} workspace.` } };
      }
      return { jsonBody: await ss.sheetDetail(id) };
    } catch (e) {
      return accountError(e, context);
    }
  },
});

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
      const sheets = await accountSheets(acct);
      return {
        jsonBody: {
          label: acct.label,
          sheets: sheets.map((s) => ({ id: s.id, name: s.name, modifiedAt: s.modifiedAt })),
        },
      };
    } catch (e) {
      return accountError(e, context);
    }
  },
});
