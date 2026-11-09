const { app } = require('@azure/functions');
const { requireUser, requirePlanner, authErrorResponse, AuthError } = require('../lib/auth');
const ss = require('../lib/smartsheet');

// T-Mobile view inside the Project Planning tab (Project Planners group).
// Lists the move sheets in the T-mobile Smartsheet workspace and serves one
// sheet's destination-walk columns, normalized, so the browser can build the
// "walk summary" and "completion report" PDFs (see /tmobile-report.js).
// Scoped to that ONE workspace on purpose: a sheet id from anywhere else is
// refused, so this view can never read the rest of the Smartsheet account.
// TMOBILE_WORKSPACE_ID overrides the default (the T-mobile workspace).
const DEFAULT_WORKSPACE_ID = '7118863767758724';
function workspaceId() { return process.env.TMOBILE_WORKSPACE_ID || DEFAULT_WORKSPACE_ID; }

// Sheets whose name starts with TEMPLATE are blank starting points, not jobs.
const isTemplate = (name) => /^\s*template\b/i.test(name || '');

function tmobileError(e, context) {
  if (e instanceof AuthError) return authErrorResponse(e, context);
  try { context.error(e); } catch (_) { /* logging must never break the response */ }
  return { status: 500, jsonBody: { error: String((e && e.message) || e || 'Unknown error') } };
}

async function jobSheets() {
  const sheets = await ss.fetchWorkspaceSheets(workspaceId());
  return sheets.filter((s) => !isTemplate(s.name));
}

// Column titles drift between jobs (trailing spaces, "Destination Pic" vs
// "Destination pre move Pic", "Current Floor (CPS)"), so match on a squashed
// lowercase title against a few accepted spellings per field.
const squash = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const FIELDS = {
  name: ['name'],
  bldg: ['newbldg', 'newbuilding'],
  floor: ['newfloor'],
  desk: ['newdesk', 'newworkspacezone', 'newworkspace'],
  pre: ['destinationpremovepic', 'destinationpic', 'premovepic'],
  status: ['walkstatus'],
  needs: ['destinationneeds', 'needs'],
  note: ['jcitnotes'],
  fix: ['jetcityfix', 'jcitfix'],
  post: ['destinationpostmovepic', 'postmovepic'],
  curFloor: ['currentfloorcps', 'currentfloor'],
  curDesk: ['currentdesk', 'currentworkspacezone'],
  source: ['source'],
};

function mapColumns(columns) {
  const byTitle = new Map((columns || []).map((c) => [squash(c.title), c.id]));
  const ids = {};
  for (const [field, titles] of Object.entries(FIELDS)) {
    const hit = titles.find((t) => byTitle.has(t));
    if (hit) ids[field] = byTitle.get(hit);
  }
  return ids;
}

// Display text of a cell ("06" stays "06"; a photo cell shows its filename).
function text(cell) {
  if (!cell) return '';
  const v = cell.displayValue != null ? cell.displayValue : cell.value;
  return v == null ? '' : String(v).trim();
}
// A photo column counts as filled if it holds a cell image or any text.
const hasPhoto = (cell) => !!(cell && (cell.image || text(cell)));
const isChecked = (cell) => !!(cell && (cell.value === true || String(cell.value).toLowerCase() === 'true'));
function multi(cell) {
  if (!cell) return [];
  const ov = cell.objectValue;
  if (ov && Array.isArray(ov.values)) return ov.values.map((v) => String(v).trim()).filter(Boolean);
  return text(cell).split(',').map((s) => s.trim()).filter(Boolean);
}

function normalize(sheet) {
  const ids = mapColumns(sheet.columns);
  const rows = (sheet.rows || []).map((r) => {
    const cells = new Map((r.cells || []).map((c) => [c.columnId, c]));
    const get = (f) => (ids[f] != null ? cells.get(ids[f]) : null);
    return {
      row: r.rowNumber,
      name: text(get('name')),
      bldg: text(get('bldg')),
      floor: text(get('floor')),
      desk: text(get('desk')),
      pre: hasPhoto(get('pre')),
      post: hasPhoto(get('post')),
      fix: isChecked(get('fix')),
      status: text(get('status')),
      needs: multi(get('needs')),
      note: text(get('note')),
      curFloor: text(get('curFloor')),
      curDesk: text(get('curDesk')),
      source: text(get('source')),
    };
  }).filter((r) => r.name);
  const missing = ['name', 'bldg', 'desk', 'pre', 'needs', 'note', 'fix', 'post'].filter((f) => ids[f] == null);
  return { id: String(sheet.id), name: sheet.name, permalink: sheet.permalink || '', rows, missingColumns: missing };
}

// GET /api/tmobile/sheets — the job sheets in the T-mobile workspace.
app.http('tmobileSheets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tmobile/sheets',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      const sheets = await jobSheets();
      return { jsonBody: { sheets: sheets.map((s) => ({ id: s.id, name: s.name, modifiedAt: s.modifiedAt })) } };
    } catch (e) {
      return tmobileError(e, context);
    }
  },
});

// GET /api/tmobile/sheet?id=<sheetId> — one job sheet's walk data, normalized.
app.http('tmobileSheet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tmobile/sheet',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      const id = new URL(request.url).searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) return { status: 400, jsonBody: { error: 'Missing sheet id' } };
      const allowed = await jobSheets();
      if (!allowed.some((s) => s.id === id)) {
        return { status: 404, jsonBody: { error: 'That sheet is not in the T-Mobile workspace.' } };
      }
      const sheet = await ss.fetchGenericSheet(id);
      return { jsonBody: normalize(sheet) };
    } catch (e) {
      return tmobileError(e, context);
    }
  },
});
