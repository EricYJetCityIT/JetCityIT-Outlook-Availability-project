const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { requireUser, requirePlanner, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');

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
