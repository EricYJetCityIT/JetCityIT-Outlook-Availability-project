const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { requireUser, requirePlanner, requireEditorOrPlanner, authErrorResponse, AuthError } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const ss = require('../lib/smartsheet');
const { audit } = require('../lib/audit');

// Project plans (the "Project Planning" tab). Any signed-in @jetcityit.com user
// can READ a plan (crew pull it up on-site); only the Project Planners group
// (PLANNER_UPNS / isPlanner) may create, edit, or delete one. Each plan is its
// own Cosmos doc in the shared `dispatch` container, id-namespaced `plan:<uuid>`
// so it never collides with the jobs `state` doc, team-contacts, or parking.
// A plan links to the calendar by PROJECT NAME: the job-detail popup's
// "Project plan" button looks a plan up via GET /api/plans?project=<name>
// (case-insensitive), matching every dispatch job sharing that project name
// (a big project has many rows, one per day/task -- not just one job). A plan
// may also carry `jobId` (the one representative dispatch job it was linked
// FROM, e.g. "ss-123") — informational only, not used for the name lookup.
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'plan:';
const MAX_PLAN_FILES = 30;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB, same as job attachments

const MAX = {
  contacts: 20,   // managers + leads each
  rows: 100,      // disconnect / reconnect floor rows each
  timeline: 60,   // timeline rows
  text: 8000,     // scope / pmhc / requirements
};

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, '') // strip control chars, keep \t \n
    .trim()
    .slice(0, max);
}

// Non-negative integer headcount (blank => 0).
function hc(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
}

function sanitizeContact(c) {
  if (!c || typeof c !== 'object') return null;
  const name = clean(c.name, 120);
  const phone = clean(c.phone, 40);
  const org = clean(c.org, 80);
  if (!name && !phone) return null;
  return { name, phone, org };
}

function sanitizeFloor(r) {
  if (!r || typeof r !== 'object') return null;
  const floor = clean(r.floor, 40);
  if (!floor) return null;
  return { floor, hc: hc(r.hc) };
}

function sanitizeTimeline(r) {
  if (!r || typeof r !== 'object') return null;
  const task = clean(r.task, 300);
  const when = clean(r.when, 120);
  const lead = clean(r.lead, 120);
  if (!task && !when && !lead) return null;
  return { task, when, lead };
}

// Linked Smartsheet ({id, name, url}) or null. The URL must be a Smartsheet
// app link, so a plan can never carry an arbitrary link to somewhere else.
function sanitizeSheet(s) {
  if (!s || typeof s !== 'object') return null;
  const id = clean(s.id, 20);
  if (!/^\d+$/.test(id)) return null;
  let url = clean(s.url, 300);
  if (!/^https:\/\/app\.smartsheet\.(com|eu|au)\//.test(url)) url = '';
  return { id, name: clean(s.name, 200) || id, url };
}

// Linked floor map ({id, name}) -- id is the Floor Maps doc id. Only the id and
// a display name are kept; the map itself stays Testers-only in floormaps.js.
function sanitizeMap(m) {
  if (!m || typeof m !== 'object') return null;
  const id = clean(m.id, 80);
  if (!/^(floormap:)?[0-9a-f-]{36}$/i.test(id)) return null;
  return { id: id.indexOf('floormap:') === 0 ? id : 'floormap:' + id, name: clean(m.name, 200) || 'Floor map' };
}

// Client group a plan belongs to -- drives the Project Planning sub-tabs
// (KP / Amazon / PSE / Brooks). '' = no group (shows under All plans only).
const ACCOUNTS = ['kp', 'amazon', 'pse', 'brooks'];
function sanitizeAccount(v) {
  const s = String(v || '').toLowerCase().trim();
  return ACCOUNTS.includes(s) ? s : '';
}

// A file attached to the plan ({id, name, mimeType}) -- id is a SHEET-level
// attachment on the crew calendar sheet (uploaded via POST /api/plan-files),
// so the job popup's existing /api/attachment/{id} viewer opens it as-is.
function sanitizeAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const id = clean(a.id, 24);
  if (!/^\d+$/.test(id)) return null;
  return { id, name: clean(a.name, 200) || 'File', mimeType: clean(a.mimeType, 120) };
}

function arr(v, fn, cap) {
  return (Array.isArray(v) ? v : []).map(fn).filter(Boolean).slice(0, cap);
}

// Build a stored plan doc from a request body (all fields optional).
function sanitizePlan(body, id, user) {
  return {
    id,
    type: 'projectPlan',
    project: clean(body.project, 200),
    projectId: clean(body.projectId, 60),
    jobId: clean(body.jobId, 60),
    client: clean(body.client, 200),
    account: sanitizeAccount(body.account),
    sheet: sanitizeSheet(body.sheet),
    maps: arr(body.maps, sanitizeMap, 20),
    attachments: arr(body.attachments, sanitizeAttachment, MAX_PLAN_FILES),
    planDate: clean(body.planDate, 60),
    bisDate: clean(body.bisDate, 60),
    managers: arr(body.managers, sanitizeContact, MAX.contacts),
    leads: arr(body.leads, sanitizeContact, MAX.contacts),
    scope: clean(body.scope, MAX.text),
    disconnect: arr(body.disconnect, sanitizeFloor, MAX.rows),
    reconnect: arr(body.reconnect, sanitizeFloor, MAX.rows),
    timeline: arr(body.timeline, sanitizeTimeline, MAX.timeline),
    pmhc: clean(body.pmhc, MAX.text),
    requirements: clean(body.requirements, MAX.text),
    updatedAt: new Date().toISOString(),
    updatedBy: (user && user.upn) || null,
  };
}

// Lightweight row for the plan list (avoids shipping every plan's full body).
function summarize(p) {
  const total = (rows) => (Array.isArray(rows) ? rows.reduce((a, r) => a + (r.hc || 0), 0) : 0);
  return {
    id: p.id,
    project: p.project || '',
    projectId: p.projectId || '',
    jobId: p.jobId || '',
    client: p.client || '',
    account: p.account || '',
    sheet: p.sheet && p.sheet.id ? { id: p.sheet.id, name: p.sheet.name || '', url: p.sheet.url || '' } : null,
    mapCount: Array.isArray(p.maps) ? p.maps.length : 0,
    planDate: p.planDate || '',
    bisDate: p.bisDate || '',
    discTotal: total(p.disconnect),
    reconTotal: total(p.reconnect),
    updatedAt: p.updatedAt || null,
    updatedBy: p.updatedBy || null,
  };
}

app.http('plans', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'plans/{id?}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      const container = getContainer(CONTAINER_ID);
      const rawId = request.params.id ? String(request.params.id) : '';
      // Never let a caller reach outside the plan namespace.
      const docId = rawId && rawId.indexOf(ID_PREFIX) === 0 ? rawId : (rawId ? ID_PREFIX + rawId : '');

      if (request.method === 'GET') {
        if (!docId) {
          // List: all plan docs, newest first. ?project= narrows to plans
          // linked to a dispatch job by PROJECT NAME (case-insensitive exact
          // match) -- used by the job-detail popup's "Project plan" button. A
          // named project can have many dispatch rows (one per day/task), so
          // this deliberately matches by name, not a single job id. ?jobId=
          // is also accepted (kept for the one representative job a plan was
          // linked FROM -- informational, not how lookups match).
          const projectFilter = request.query.get('project');
          const jobIdFilter = request.query.get('jobId');
          let query;
          if (projectFilter) {
            query = {
              query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND LOWER(c.project) = LOWER(@name) ORDER BY c.updatedAt DESC',
              parameters: [{ name: '@p', value: ID_PREFIX }, { name: '@name', value: projectFilter }],
            };
          } else if (jobIdFilter) {
            query = {
              query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND c.jobId = @jobId ORDER BY c.updatedAt DESC',
              parameters: [{ name: '@p', value: ID_PREFIX }, { name: '@jobId', value: jobIdFilter }],
            };
          } else {
            query = {
              query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) ORDER BY c.updatedAt DESC',
              parameters: [{ name: '@p', value: ID_PREFIX }],
            };
          }
          const { resources } = await container.items.query(query).fetchAll();
          return { jsonBody: { plans: resources.map(summarize), canEdit: !!user.isPlanner } };
        }
        try {
          const { resource } = await container.item(docId, docId).read();
          if (!resource) return { status: 404, jsonBody: { error: 'Plan not found' } };
          return { jsonBody: { plan: resource, canEdit: !!user.isPlanner } };
        } catch (e) {
          if (e.code === 404) return { status: 404, jsonBody: { error: 'Plan not found' } };
          throw e;
        }
      }

      // Everything below changes data -- Project Planners only.
      requirePlanner(user);
      const body = await request.json().catch(() => ({}));

      if (request.method === 'DELETE') {
        if (!docId) return { status: 400, jsonBody: { error: 'Missing plan id' } };
        try {
          await container.item(docId, docId).delete();
        } catch (e) {
          if (e.code !== 404) throw e; // already gone == deleted
        }
        return { jsonBody: { deleted: true, id: docId } };
      }

      // POST = create (server assigns id); PUT = update an existing plan.
      const id = request.method === 'POST' || !docId ? ID_PREFIX + randomUUID() : docId;
      const plan = sanitizePlan(body, id, user);
      const { resource } = await container.items.upsert(plan);
      return { jsonBody: { plan: resource || plan } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// "📊 Link Smartsheet" on the plan form (Project Planners only).
// GET /api/plan-sheets?q=<term>        -> account-wide sheet-name search
// GET /api/plan-sheets?id=<id>         -> that sheet's name + permalink
// GET /api/plan-sheets?progress=<id>   -> {total, done, ...} for progress bars
// Same Smartsheet search the Job Sheets tab uses, gated to Planners and
// Editors (Editors pick a sheet for a calendar job in the New / Edit job
// modal; Job Sheets is Testers-only). Nothing is stored here; the plan save
// (or /api/job-links) stores the picked {id, name, url}.
app.http('planSheets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'plan-sheets',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditorOrPlanner(user);
      // ?progress=<id> -> how far along that sheet is (done / total items)
      const progressId = (request.query.get('progress') || '').trim();
      if (progressId) {
        if (!/^\d{1,20}$/.test(progressId)) return { status: 400, jsonBody: { error: 'Bad sheet id' } };
        try {
          return { jsonBody: { progress: await ss.sheetProgress(progressId) } };
        } catch (e) {
          if (/error (403|404)/.test(String(e && e.message))) return { status: 404, jsonBody: { error: 'Sheet not found' } };
          throw e;
        }
      }
      const id = (request.query.get('id') || '').trim();
      if (id) {
        if (!/^\d{1,20}$/.test(id)) return { status: 400, jsonBody: { error: 'Bad sheet id' } };
        try {
          return { jsonBody: { sheet: await ss.fetchSheetInfo(id) } };
        } catch (e) {
          if (e.status === 404 || e.status === 403) return { status: 404, jsonBody: { error: 'Sheet not found' } };
          throw e;
        }
      }
      const q = (request.query.get('q') || '').trim().slice(0, 100);
      if (!q) return { jsonBody: { results: [] } };
      return { jsonBody: { results: await ss.searchSheets(q) } };
    } catch (e) {
      if (e instanceof AuthError) return authErrorResponse(e, context);
      try { context.error(e); } catch (_) { /* logging must never break the response */ }
      return { status: 500, jsonBody: { error: 'Smartsheet lookup failed' } };
    }
  },
});

// "📎 Add attachment" on the plan form (Project Planners only).
// POST /api/plan-files  (multipart, one part per file) -> { files: [{id, name, mimeType}] }
// Each file becomes a SHEET-level attachment on the crew calendar sheet -- the
// same sheet job attachments live on (as row attachments), so no new storage
// and the existing viewer (/api/attachment/{id}) opens them for any signed-in
// user, like job files. Sheet-level attachments are not synced onto any job.
// The form keeps the returned list and saves it on the plan (plan.attachments);
// removing one from a plan only unlinks it -- the file stays in Smartsheet.
function planFileTypeAllowed(mime, name) {
  const t = String(mime || '');
  if (/^image\//i.test(t) || /^application\/pdf$/i.test(t)) return true;
  if (/wordprocessingml|spreadsheetml|^application\/msword$|^application\/vnd\.ms-excel$/i.test(t)) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|pdf|docx?|xlsx?)$/i.test(String(name || ''));
}

app.http('planFiles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'plan-files',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      let form;
      try { form = await request.formData(); } catch (_) { return { status: 400, jsonBody: { error: 'Expected a multipart file upload' } }; }
      const files = [];
      for (const value of form.values()) {
        if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') files.push(value);
      }
      if (!files.length) return { status: 400, jsonBody: { error: 'No file was uploaded' } };
      if (files.length > 10) return { status: 400, jsonBody: { error: 'Too many files at once (max 10)' } };
      // Check every file before uploading any, so a bad one doesn't leave half a batch behind.
      const ready = [];
      for (const file of files) {
        const name = clean(file.name, 180) || 'file';
        if (!planFileTypeAllowed(file.type, name)) return { status: 400, jsonBody: { error: `Unsupported file type: ${name}. Pictures, PDFs, Word and Excel files only.` } };
        const bytes = Buffer.from(await file.arrayBuffer());
        if (!bytes.length) continue;
        if (bytes.length > MAX_FILE_BYTES) return { status: 400, jsonBody: { error: `"${name}" is too large (max 25 MB).` } };
        ready.push({ name, type: file.type || 'application/octet-stream', bytes });
      }
      if (!ready.length) return { status: 400, jsonBody: { error: 'No file was uploaded' } };
      const out = [];
      for (const f of ready) {
        const att = await ss.addSheetAttachment(ss.getSheetId(), `Project plan - ${f.name.replace(/[\/:*?"<>|]+/g, ' ')}`, f.type, f.bytes);
        if (!att || !att.id) throw new Error('Smartsheet did not return an attachment id');
        out.push({ id: String(att.id), name: f.name, mimeType: att.mimeType || f.type });
      }
      audit(context, user, 'plan.attach', { count: out.length });
      return { jsonBody: { files: out } };
    } catch (e) {
      if (e instanceof AuthError) return authErrorResponse(e, context);
      try { context.error(e); } catch (_) { /* logging must never break the response */ }
      return { status: 500, jsonBody: { error: 'Could not attach the file' } };
    }
  },
});
