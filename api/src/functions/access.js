const { app } = require('@azure/functions');
const { requireUser, requireAccessAdmin, azureAccessLists, authErrorResponse } = require('../lib/auth');
const { GROUPS, normUpn, validUpn, readAccess, updateGroup, AccessConflict, MAX_PER_GROUP } = require('../lib/access');
const { audit } = require('../lib/audit');

// Manager view -> Access tab. Lets the people who are editors through Azure (EDITOR_UPNS or the Entra
// "DataEditor" role: requireAccessAdmin) see and change who has Editor / Finance / Planner / Tester
// access, without touching Azure settings. The people listed in Azure settings are shown but can only
// be changed there; this only adds/removes people on top of them (lib/access.js).
//   GET /api/access                 -> { version, azure:{group:[upn]}, page:{group:[upn]} }
//   PUT /api/access  { group, add:[upn], remove:[upn], expect:"<version>" }  -> same shape
// A change takes effect for that person at their next sign-in / page load (and within ~30 s on the server).
const MAX_BATCH = 50;

function view(lists, version, changed) {
  return { version, azure: azureAccessLists(), page: lists, ...(changed ? { changed } : {}) };
}

app.http('access', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'access',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireAccessAdmin(user);

      if (request.method === 'GET') {
        const cur = await readAccess();
        return { jsonBody: view(cur.lists, cur.version) };
      }

      const body = await request.json().catch(() => null);
      if (!body || typeof body.expect !== 'string' || !GROUPS.includes(body.group)) {
        return { status: 400, jsonBody: { error: 'Expected { group, add, remove, expect }' } };
      }
      const asList = (v) => (Array.isArray(v) ? v : []);
      const add = asList(body.add).map(normUpn), remove = asList(body.remove).map(normUpn).filter((u) => u.length <= 80);
      if (add.length > MAX_BATCH || remove.length > MAX_BATCH) return { status: 400, jsonBody: { error: 'Too many changes at once' } };
      const bad = add.find((u) => !validUpn(u));
      if (bad !== undefined) return { status: 400, jsonBody: { error: 'Only @jetcityit.com email addresses can be added.' } };
      if (!add.length && !remove.length) return { status: 400, jsonBody: { error: 'Nothing to change' } };

      let out;
      try {
        out = await updateGroup(body.group, add, remove, user.upn, body.expect);
      } catch (e) {
        if (e instanceof AccessConflict) return { status: 409, jsonBody: { error: 'Someone else changed access. It has been reloaded; check it and try again.' } };
        if (e && /Too many people/.test(e.message)) return { status: 400, jsonBody: { error: 'That group is full.' } };
        throw e;
      }
      // Security-relevant: who gave whom what is recorded (UPNs are the identifiers here, never message text),
      // and only what REALLY changed (a request that adds someone already there, or removes an Azure-listed
      // person, changes and records nothing).
      if (out.added.length || out.removed.length) audit(context, user, 'access.change', { group: body.group, added: out.added, removed: out.removed });
      return { jsonBody: view(out.lists, out.version, { added: out.added, removed: out.removed }) };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
