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

// Job Sheets tab (Testers group) — READ-ONLY. Serves a picker of the client's
// job sheets and one sheet's contents (items + live QA photos) to the in-app
// viewer. Everything is gated to the Testers group AND limited to the single
// workspace named by JOBSHEET_WORKSPACE_ID, so the admin token can never be
// used from here to read the rest of the Smartsheet library. The workspace id
// (client-identifying) lives only in Azure app settings, never in the repo.

function getWorkspaceId() {
  const id = process.env.JOBSHEET_WORKSPACE_ID;
  if (!id) throw new Error('JOBSHEET_WORKSPACE_ID is not configured');
  return id;
}

// GET /api/jobsheet/sheets — list the job sheets in the configured workspace.
app.http('jobsheetSheets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'jobsheet/sheets',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const sheets = await ss.fetchWorkspaceSheets(getWorkspaceId());
      return { jsonBody: { sheets: sheets.map((s) => ({ id: s.id, name: s.name })) } };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// GET /api/jobsheet/sheet?id=<sheetId> — one sheet's viewer payload. The id is
// validated against the configured workspace's sheet list first, so a Testers
// member can only ever read sheets inside that one workspace.
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
      const allowed = await ss.fetchWorkspaceSheets(getWorkspaceId());
      if (!allowed.some((s) => String(s.id) === String(id))) {
        return { status: 403, jsonBody: { error: 'Sheet not permitted' } };
      }
      const view = await ss.fetchJobSheetView(id);
      return { jsonBody: view };
    } catch (e) {
      return jobsheetError(e, context);
    }
  },
});

// POST /api/jobsheet/cell — writes one cell (Notes text / status checkbox) back
// to a row. Testers-only, and limited to sheets inside the configured workspace
// (same guard as reads). Body: { sheetId, rowId, columnId, value }.
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
      const allowed = await ss.fetchWorkspaceSheets(getWorkspaceId());
      if (!allowed.some((s) => String(s.id) === String(body.sheetId))) {
        return { status: 403, jsonBody: { error: 'Sheet not permitted' } };
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
