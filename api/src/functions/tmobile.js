const { app } = require('@azure/functions');
const { requireUser, requirePlanner, authErrorResponse, AuthError } = require('../lib/auth');
const ss = require('../lib/smartsheet');
const { getContainer } = require('../lib/cosmos');

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

// Photo cells hold a Smartsheet cell image; collect them so their short-lived
// signed URLs can be resolved in two batches (thumbnail + full size).
const THUMB_PX = 240;
const FULL_PX = 1000;

async function normalize(sheet) {
  const ids = mapColumns(sheet.columns);
  const images = []; // { row, which, imageId }
  const rows = (sheet.rows || []).map((r) => {
    const cells = new Map((r.cells || []).map((c) => [c.columnId, c]));
    const get = (f) => (ids[f] != null ? cells.get(ids[f]) : null);
    for (const which of ['pre', 'post']) {
      const c = get(which);
      if (c && c.image && c.image.id) images.push({ row: r.rowNumber, which, imageId: c.image.id });
    }
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
  });
  // Smartsheet scales the image when width is given; the URLs expire (~30 min),
  // so the browser re-fetches the sheet for fresh ones when they go stale.
  const [thumbs, fulls] = await Promise.all([
    ss.fetchImageUrls(images.map((x) => ({ imageId: x.imageId, width: THUMB_PX }))),
    ss.fetchImageUrls(images.map((x) => ({ imageId: x.imageId, width: FULL_PX }))),
  ]);
  const byRow = new Map(rows.map((r) => [r.row, r]));
  for (const x of images) {
    const r = byRow.get(x.row);
    if (!r) continue;
    r[x.which + 'Thumb'] = thumbs.get(x.imageId) || '';
    r[x.which + 'Url'] = fulls.get(x.imageId) || '';
  }
  const missing = ['name', 'bldg', 'desk', 'pre', 'needs', 'note', 'fix', 'post'].filter((f) => ids[f] == null);
  return {
    id: String(sheet.id), name: sheet.name, permalink: sheet.permalink || '',
    fetchedAt: new Date().toISOString(),
    rows: rows.filter((r) => r.name), missingColumns: missing,
  };
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
      return { jsonBody: await normalize(sheet) };
    } catch (e) {
      return tmobileError(e, context);
    }
  },
});

// GET /api/tmobile/photo?u=<signed Smartsheet image url> — streams one photo
// to the browser (the page's CSP only allows same-origin images). Only
// Smartsheet's signed storage URLs are accepted, and only for Project Planners;
// the response is never cached by the service worker (it skips /api/*).
app.http('tmobilePhoto', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tmobile/photo',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
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
      return { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' }, body: bytes };
    } catch (e) {
      return tmobileError(e, context);
    }
  },
});

// Saved report versions ("Client copy", "Internal copy", ...), shared by the
// Project Planners. One Cosmos doc in the `dispatch` container. A version holds
// SETTINGS ONLY -- its name, which sections and columns to include, and whether
// to hide note text -- never names, buildings or other sheet data, which are
// picked per report and not stored.
const PRESETS_ID = 'tmobile:presets';
const SECTION_KEYS = {
  walk: ['totals', 'bydesk', 'followUp', 'atDesk', 'notFound'],
  completion: ['summary', 'completed', 'good', 'alsoChecked', 'open', 'none', 'photos', 'appendix'],
};
const COLUMN_KEYS = ['bldg', 'floor', 'desk', 'curDesk', 'note'];
const pickKeys = (v, allowed) => (Array.isArray(v) ? v : []).filter((k) => allowed.includes(k));

function sanitizePreset(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').replace(/[\x00-\x1f\x7f]+/g, '').trim().slice(0, 60);
  if (!name) return null;
  const sections = p.sections && typeof p.sections === 'object' ? p.sections : {};
  return {
    id: String(p.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || `p${Date.now().toString(36)}`,
    name,
    sections: { walk: pickKeys(sections.walk, SECTION_KEYS.walk), completion: pickKeys(sections.completion, SECTION_KEYS.completion) },
    columns: pickKeys(p.columns, COLUMN_KEYS),
    hideNotes: !!p.hideNotes,
  };
}

// GET /api/tmobile/presets — the saved report versions.
// PUT /api/tmobile/presets  { presets: [...] } — replace the list (max 20).
app.http('tmobilePresets', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'tmobile/presets',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      const container = getContainer('dispatch');
      if (request.method === 'GET') {
        try {
          const { resource } = await container.item(PRESETS_ID, PRESETS_ID).read();
          return { jsonBody: { presets: (resource && resource.presets) || [] } };
        } catch (e) {
          if (e && e.code === 404) return { jsonBody: { presets: [] } };
          throw e;
        }
      }
      let body;
      try { body = await request.json(); } catch (_) { return { status: 400, jsonBody: { error: 'Invalid JSON' } }; }
      const presets = (Array.isArray(body && body.presets) ? body.presets : []).map(sanitizePreset).filter(Boolean).slice(0, 20);
      await container.items.upsert({ id: PRESETS_ID, type: 'tmobilePresets', presets, updatedBy: user.upn, updatedAt: new Date().toISOString() });
      return { jsonBody: { presets } };
    } catch (e) {
      return tmobileError(e, context);
    }
  },
});
