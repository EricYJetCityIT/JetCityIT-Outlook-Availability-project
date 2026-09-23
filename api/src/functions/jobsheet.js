const { app } = require('@azure/functions');
const { requireUser, requireTester, authErrorResponse, AuthError } = require('../lib/auth');
const ss = require('../lib/smartsheet');

// Auth failures (401/403/429) go through the shared handler; any other failure
// (e.g. a Smartsheet API error) returns its real message here. This tab is
// Testers-only, so surfacing the cause to the two testers is fine and makes the
// read path debuggable instead of a blank "Internal server error".
function jobsheetError(e, context) {
  if (e instanceof AuthError) return authErrorResponse(e, context);
  try { context.error(e); } catch (_) { /* logging must never break the response */ }
  return { status: 500, jsonBody: { error: String((e && e.message) || e || 'Unknown error') } };
}

// Job Sheets tab (Testers group). Serves a picker of the token's Smartsheet
// workspaces, the sheets inside whichever one is chosen, and one sheet's
// contents (items + live QA photos) to the in-app viewer, plus a write-back
// endpoint for the Notes/status columns. Gated to the Testers group; beyond
// that, the real access boundary is the app's SMARTSHEET_API_TOKEN's own
// Smartsheet permissions -- there is no app-side workspace allow-list, so a
// Tester can reach anything that token can see (same as every other
// Smartsheet-backed feature in this app; Job Sheets is no longer special-cased
// to one configured workspace).

// GET /api/jobsheet/workspaces — list every workspace the token can see, for
// the tab's workspace picker.
app.http('jobsheetWorkspaces', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobsheet/workspaces',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const workspaces = await ss.fetchAllWorkspaces();
      return { jsonBody: { workspaces } };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// GET /api/jobsheet/search?q=<term> — account-wide sheet-name search, so a
// Tester can jump straight to a sheet without walking the workspace/sheet
// pickers. Returns [] for a missing/blank query rather than erroring.
app.http('jobsheetSearch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobsheet/search',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const q = (new URL(request.url).searchParams.get('q') || '').trim();
      if (!q) return { jsonBody: { results: [] } };
      const results = await ss.searchSheets(q);
      return { jsonBody: { results } };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// GET /api/jobsheet/sheets?workspaceId=<id> — list the job sheets in one workspace.
app.http('jobsheetSheets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobsheet/sheets',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      if (!workspaceId) return { status: 400, jsonBody: { error: 'Missing workspaceId' } };
      const sheets = await ss.fetchWorkspaceSheets(workspaceId);
      return { jsonBody: { sheets: sheets.map((s) => ({ id: s.id, name: s.name })) } };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// GET /api/jobsheet/sheet?id=<sheetId> — one sheet's viewer payload.
app.http('jobsheetSheet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobsheet/sheet',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return { status: 400, jsonBody: { error: 'Missing sheet id' } };
      const view = await ss.fetchJobSheetView(id);
      return { jsonBody: view };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// POST /api/jobsheet/cell — writes one cell (Notes text / status checkbox) back
// to a row. Testers-only. Body: { sheetId, rowId, columnId, value }.
app.http('jobsheetCell', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'jobsheet/cell',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const body = await request.json().catch(() => null);
      if (!body || !body.sheetId || !body.rowId || !body.columnId) {
        return { status: 400, jsonBody: { error: 'Missing sheetId, rowId, or columnId' } };
      }
      await ss.updateJobSheetCell(body.sheetId, body.rowId, body.columnId, body.value);
      return { jsonBody: { ok: true } };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// GET /api/jobsheet/photo?u=<encoded signed url> — streams one QA cell-image.
// Anonymous by necessity (an <img> tag can't send our custom auth header), but
// the capability is the signed url itself: it's only handed out by the
// Testers-gated /sheet endpoint, is short-lived, and is validated here to be a
// Smartsheet-signed, non-expired image-proxy url (SSRF guard — never fetches an
// arbitrary host).
app.http('jobsheetPhoto', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobsheet/photo',
  handler: async (request, context) => {
    try {
      const u = new URL(request.url).searchParams.get('u');
      if (!u) return { status: 400, jsonBody: { error: 'Missing image url' } };
      let target;
      try { target = new URL(u); } catch (_) { return { status: 400, jsonBody: { error: 'Bad image url' } }; }
      if (target.protocol !== 'https:' || target.hostname !== 'aws.smartsheet.com' || !target.pathname.startsWith('/storageProxy/')) {
        return { status: 403, jsonBody: { error: 'Image host not permitted' } };
      }
      if (!target.searchParams.get('hmac')) return { status: 403, jsonBody: { error: 'Unsigned image url' } };
      const exp = target.searchParams.get('expirationDate');
      if (exp && new Date(exp).getTime() < Date.now()) return { status: 410, jsonBody: { error: 'Image link expired' } };
      const { contentType, bytes } = await ss.fetchImageBytes(u);
      return { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' }, body: bytes };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});
