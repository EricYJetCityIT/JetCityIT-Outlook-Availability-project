const { getContainer } = require('./cosmos');

// "Inactive crew": people who still show up in the synced Smartsheet roster (they
// are assigned to past jobs, or sit in the sheet's contact lists) or in the
// availability submissions, but who no longer work here. The roster is rebuilt
// from the sheet every sync and past assignments can't be rewritten, so the
// "hide" list lives in Cosmos (never in code: it is staff data, and the repo is
// public) and is laid over the roster whenever it is read:
//   * GET /api/dispatch marks matching workers `active:false` (so Assign crew,
//     the board's crew strip and My-schedule skip them; jobs they were already
//     assigned to keep showing them);
//   * the weekly availability reminder skips them (no more emails);
//   * the Manager view's Individual tab hides matching availability submitters
//     (client side, same idea as isInactiveName below, see index.html).
// One doc in the shared `dispatch` container: { id:'crew-inactive', names:[...], updatedAt }.
// `updatedAt` doubles as the list's version: a save must name the version it was
// based on, so two editors (or one stale tab) can't silently overwrite each other.
const CONTAINER_ID = 'dispatch';
const DOC_ID = 'crew-inactive';
const MAX_NAMES = 200;
const MAX_NAME_LEN = 60;

// Roster first names that differ from the login spelling (a variant or a nickname);
// keep in step with FIRST_NAME_ALIASES in index.html.
const FIRST_NAME_ALIASES = { abylai: 'abylay', matt: 'matthew' };

// First name + last initial, e.g. "Ben VanCise" and "Ben V" both -> "ben|v". Same
// idea as normNameKey() in index.html and availabilityReminder.js: the roster
// abbreviates to "First L" while people sign in (and submit availability) under
// their full name.
function nameKey(s) {
  const t = String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!t.length) return '';
  const first = FIRST_NAME_ALIASES[t[0]] || t[0];
  return t.length > 1 ? `${first}|${t[1][0]}` : first;
}
const exact = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Is `name` (one entry of `listNames`) on the inactive list? An exact match always
// counts. A first-name + last-initial match counts only when no OTHER name in the
// same list shares that key, so two people who abbreviate the same way ("Ben V" /
// "Ben Voss") are never both hidden because one of them left; hide the exact
// spelling instead.
function isInactiveName(name, listNames, inactiveNames) {
  const n = exact(name);
  if (!n || !inactiveNames || !inactiveNames.length) return false;
  if (inactiveNames.some((c) => exact(c) === n)) return true;
  const k = nameKey(name);
  if (!k || !inactiveNames.some((c) => nameKey(c) === k)) return false;
  return !(listNames || []).some((m) => exact(m) !== n && nameKey(m) === k);
}

// Cleans a client-supplied list: strings only, control characters stripped,
// whitespace collapsed, length-limited, de-duplicated (case-insensitive), capped.
function sanitizeNames(input) {
  if (!Array.isArray(input)) return null;
  const out = [], seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const s = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
    const k = exact(s);
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

// { names, version }: version is '' until the list has been saved once. Throws on any
// error other than "doc doesn't exist yet", so callers can tell "empty" from "unreadable".
async function readInactive(container) {
  const c = container || getContainer(CONTAINER_ID);
  try {
    const { resource } = await c.item(DOC_ID, DOC_ID).read();
    return { names: resource && Array.isArray(resource.names) ? resource.names : [], version: (resource && resource.updatedAt) || '', etag: resource && resource._etag };
  } catch (e) {
    if (e.code === 404) return { names: [], version: '', etag: null };
    throw e;
  }
}
async function readInactiveNames(container) {
  return (await readInactive(container)).names;
}

class InactiveConflict extends Error {}

// Replaces the list, but only if it is still the version the caller started from
// (`expectVersion`, '' for "never saved"). The write itself is conditional on the doc's
// etag (or on the doc not existing), so a save that lands between our read and our write
// loses instead of overwriting. Throws InactiveConflict when someone else got there first.
async function writeInactiveNames(names, by, expectVersion) {
  const c = getContainer(CONTAINER_ID);
  const cur = await readInactive(c);
  if (String(expectVersion || '') !== cur.version) throw new InactiveConflict('The inactive list was changed by someone else.');
  const doc = { id: DOC_ID, names, updatedAt: new Date().toISOString(), updatedBy: by || null };
  try {
    if (cur.etag) await c.item(DOC_ID, DOC_ID).replace(doc, { accessCondition: { type: 'IfMatch', condition: cur.etag } });
    else await c.items.create(doc);
  } catch (e) {
    if (e && (e.code === 412 || e.code === 409)) throw new InactiveConflict('The inactive list was changed by someone else.');
    throw e;
  }
  return doc;
}

// Roster workers with the inactive list laid over them.
function applyInactive(workers, inactiveNames) {
  const list = (workers || []).map((w) => w.name);
  return (workers || []).map((w) => (isInactiveName(w.name, list, inactiveNames) ? { ...w, active: false } : w));
}

module.exports = { nameKey, isInactiveName, sanitizeNames, readInactive, readInactiveNames, writeInactiveNames, applyInactive, InactiveConflict, MAX_NAMES };
