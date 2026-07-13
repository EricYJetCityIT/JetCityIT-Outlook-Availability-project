const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');

const CONTAINER_ID = 'availability';

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

function docId(weekKey, name) {
  return `${weekKey}__${slugify(name)}`;
}

// Mirrors getNames()/getSlots(n) for a whole week at once (manager/crew calendar view).
app.http('availabilityWeek', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'availability/{weekKey}',
  handler: async (request, context) => {
    try {
      await requireUser(request);
      const { weekKey } = request.params;
      const container = getContainer(CONTAINER_ID);
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
      return { jsonBody: { ok: true } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
