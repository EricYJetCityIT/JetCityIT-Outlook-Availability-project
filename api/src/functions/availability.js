const { app } = require('@azure/functions');
const { requireUser, requireEditor, AuthError, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { audit } = require('../lib/audit');

const CONTAINER_ID = 'availability';

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

function docId(weekKey, name) {
  return `${weekKey}__${slugify(name)}`;
}

// Mirrors getNames()/getSlots(n) for a whole week at once (manager/crew calendar view),
// and mirrors deleteAll() via DELETE (manager's "clear all submissions for this week").
app.http('availabilityWeek', {
  methods: ['GET', 'DELETE'],
  authLevel: 'anonymous',
  route: 'availability/{weekKey}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      const { weekKey } = request.params;
      const container = getContainer(CONTAINER_ID);

      if (request.method === 'DELETE') {
        requireEditor(user); // clearing everyone's submissions for a week is editor-only
        const { resources } = await container.items
          .query({
            query: 'SELECT c.id FROM c WHERE c.weekKey = @weekKey',
            parameters: [{ name: '@weekKey', value: weekKey }],
          })
          .fetchAll();
        await Promise.all(resources.map((r) => container.item(r.id, weekKey).delete()));
        audit(context, user, 'availability.deleteWeek', { weekKey, deleted: resources.length });
        return { jsonBody: { ok: true } };
      }

      const { resources } = await container.items
        .query({
          query: 'SELECT c.name, c.slots FROM c WHERE c.weekKey = @weekKey',
          parameters: [{ name: '@weekKey', value: weekKey }],
        })
        .fetchAll();
      return { jsonBody: { names: resources.map((r) => r.name), entries: resources } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// Mirrors getSlots(n)/setSlots(n, ss) for a single tech's week.
app.http('availabilityUser', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'availability/{weekKey}/{name}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      const { weekKey, name } = request.params;
      const decodedName = decodeURIComponent(name);
      const container = getContainer(CONTAINER_ID);
      const id = docId(weekKey, decodedName);

      if (request.method === 'GET') {
        try {
          const { resource } = await container.item(id, weekKey).read();
          return { jsonBody: { slots: resource ? resource.slots : null } };
        } catch (e) {
          if (e.code === 404) return { jsonBody: { slots: null } };
          throw e;
        }
      }

      // A tech may submit/edit only their OWN availability; editors may edit anyone's.
      // (Matches on display-name slug since availability is keyed by name. A future
      // migration should key by the immutable oid/upn to make this airtight.)
      if (!user.isEditor && slugify(decodedName) !== slugify(user.name)) {
        throw new AuthError(403, 'You can only change your own availability.');
      }

      const body = await request.json();
      const doc = {
        id,
        weekKey,
        name: decodedName.trim(),
        slots: body.slots,
        updatedBy: user.upn,
        updatedAt: new Date().toISOString(),
      };
      await container.items.upsert(doc);
      audit(context, user, 'availability.put', { weekKey, name: decodedName.trim() });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
