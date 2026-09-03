const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { listUsers } = require('../lib/graph');
const { getContainer } = require('../lib/cosmos');

// In-app "Team contacts" (opened from the header info menu). Any signed-in
// @jetcityit.com user can READ it; editors can EDIT the curated numbers. Two
// sources, merged client-side:
//   staff  - JCIT people pulled from Entra (Graph), with whatever phone is on
//            file (mobile preferred, else business). Read-only, auto-updated.
//   custom - a hand-maintained list (office line, on-call, vendors, and crew
//            whose cell isn't in Entra) stored in COSMOS, never in the public
//            repo. Editors add/remove these in the app.
const CONTAINER_ID = 'dispatch';
const DOC_ID = 'team-contacts';
const MAX_CUSTOM = 100;

let staffCache = null;
let staffCacheAt = 0;
const STAFF_TTL_MS = 60 * 60 * 1000;

// Strip control characters, collapse whitespace, and cap length.
function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Normalizes one curated contact row; drops rows with no name.
function sanitizeContact(c) {
  if (!c || typeof c !== 'object') return null;
  const name = clean(c.name, 80);
  if (!name) return null;
  return {
    name,
    phone: clean(c.phone, 40),
    email: clean(c.email, 120),
    role: clean(c.role, 60),
  };
}

// The stored doc holds the curated list plus `hidden` = keys of Entra staff an
// editor chose to hide from this view (staff re-sync from Graph, so a plain
// delete would reappear — hiding is remembered and reversible).
async function readDoc() {
  const container = getContainer(CONTAINER_ID);
  try {
    const { resource } = await container.item(DOC_ID, DOC_ID).read();
    return {
      contacts: Array.isArray(resource && resource.contacts) ? resource.contacts : [],
      hidden: Array.isArray(resource && resource.hidden) ? resource.hidden : [],
    };
  } catch (e) {
    if (e.code === 404) return { contacts: [], hidden: [] };
    throw e;
  }
}

async function readStaff() {
  if (staffCache && Date.now() - staffCacheAt < STAFF_TTL_MS) return staffCache;
  const users = await listUsers();
  const out = [];
  const seen = {};
  users.forEach((u) => {
    if (u.accountEnabled === false) return; // skip disabled accounts
    const phone = clean(u.mobilePhone || (Array.isArray(u.businessPhones) ? u.businessPhones[0] : ''), 40);
    if (!phone) return; // this list is about phone numbers - skip people with none
    const email = clean(u.mail || u.userPrincipalName, 120);
    const key = (email || u.displayName || '').toLowerCase();
    if (!key || seen[key]) return;
    seen[key] = 1;
    out.push({ name: clean(u.displayName || email, 80), email, phone, role: clean(u.jobTitle, 60), key });
  });
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  staffCache = out;
  staffCacheAt = Date.now();
  return out;
}

app.http('contacts', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'contacts',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);

      const doc = await readDoc();
      const hiddenSet = new Set((doc.hidden || []).map((k) => String(k).toLowerCase()));

      if (request.method === 'GET') {
        // Staff pull can fail (Graph hiccup) without breaking the curated list.
        let allStaff = [];
        try {
          allStaff = await readStaff();
        } catch (e) {
          context.error(`contacts: staff pull failed: ${e && e.message}`);
        }
        const staff = allStaff.filter((s) => !hiddenSet.has(s.key));
        // Hidden-but-still-in-Entra people, so an editor can restore them.
        const hiddenStaff = allStaff.filter((s) => hiddenSet.has(s.key)).map((s) => ({ name: s.name, key: s.key }));
        return { jsonBody: { staff, custom: doc.contacts, hiddenStaff, canEdit: !!(user && user.isEditor) } };
      }

      // PUT (editors only) — may replace the curated list and/or hide/unhide a
      // staff row. Any subset of {contacts, hide, unhide} is applied to the doc.
      requireEditor(user);
      const body = await request.json().catch(() => ({}));

      let contacts = doc.contacts;
      if (Array.isArray(body.contacts)) {
        if (body.contacts.length > MAX_CUSTOM) {
          return { status: 400, jsonBody: { error: `Too many contacts (max ${MAX_CUSTOM})` } };
        }
        contacts = body.contacts.map(sanitizeContact).filter(Boolean);
      }

      if (body.hide) hiddenSet.add(String(body.hide).toLowerCase());
      if (body.unhide) hiddenSet.delete(String(body.unhide).toLowerCase());
      const hidden = Array.from(hiddenSet).slice(0, MAX_CUSTOM * 2);

      const container = getContainer(CONTAINER_ID);
      await container.items.upsert({ id: DOC_ID, contacts, hidden, updatedAt: new Date().toISOString(), updatedBy: user.upn || null });
      return { jsonBody: { saved: true, contacts, hidden } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
