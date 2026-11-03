const { getContainer } = require('./cosmos');

// Access groups that can be granted from the site's Manager view -> Access tab, on top of the
// lists already set in Azure app settings (EDITOR_UPNS, FINANCE_UPNS, PLANNER_UPNS, TESTER_UPNS)
// and the Entra "DataEditor" role. The page-granted lists live in ONE Cosmos doc (never in code:
// it is staff data and the repo is public) and are ADDED to the Azure ones at sign-in time
// (auth.js requireUser), so removing someone from the page never removes anyone who is still in
// the Azure settings, and a broken read of this doc can only ever fall back to the Azure lists.
//   { id:'access-config', editors:[upn], finance:[upn], planners:[upn], testers:[upn], updatedAt, updatedBy }
// `updatedAt` is the version a save must be based on (two admins can't silently overwrite each
// other); the write itself is conditional on the doc's etag.
const CONTAINER_ID = 'dispatch';
const DOC_ID = 'access-config';
const GROUPS = ['editors', 'finance', 'planners', 'testers'];
const MAX_PER_GROUP = 200;
const TTL_MS = 30 * 1000;               // how long one server instance trusts what it read
const RETRY_MS = 5 * 1000;              // after a failed read, wait this long before trying again
const READ_TIMEOUT_MS = 2500;           // never hold a request on a slow Cosmos longer than this
const MAX_STALE_MS = 10 * 60 * 1000;    // a last-good copy is not trusted longer than this when reads keep failing
const UPN_RE = /^[a-z0-9][a-z0-9._%+'-]{0,63}@jetcityit\.com$/;

const emptyLists = () => ({ editors: [], finance: [], planners: [], testers: [] });
const normUpn = (s) => String(s == null ? '' : s).trim().toLowerCase();
const validUpn = (s) => UPN_RE.test(normUpn(s));

function cleanLists(doc) {
  const out = emptyLists();
  GROUPS.forEach((g) => {
    const seen = new Set();
    (Array.isArray(doc && doc[g]) ? doc[g] : []).forEach((u) => {
      const n = normUpn(u);
      if (validUpn(n) && !seen.has(n) && seen.size < MAX_PER_GROUP) { seen.add(n); out[g].push(n); }
    });
  });
  return out;
}

// { lists, version, etag }; version is '' until the first save. Throws on any error other than
// "doc doesn't exist yet", so callers can tell "nobody granted" from "couldn't read".
async function readAccess(container) {
  const c = container || getContainer(CONTAINER_ID);
  try {
    const { resource } = await c.item(DOC_ID, DOC_ID).read();
    return { lists: cleanLists(resource), version: (resource && resource.updatedAt) || '', etag: resource && resource._etag };
  } catch (e) {
    if (e && e.code === 404) return { lists: emptyLists(), version: '', etag: null };
    throw e;
  }
}

let cache = null, cacheAt = 0, retryAt = 0, inflight = null, gen = 0;

// Waiting callers give up after READ_TIMEOUT_MS, but the read itself keeps going: if it finishes late
// it still fills the cache (unless a save happened meanwhile), so the next request is served from it.
function readWithTimeout(g) {
  let timer;
  const read = readAccess();
  read.then((r) => { if (g === gen) { cache = r.lists; cacheAt = Date.now(); retryAt = 0; } }, () => {});
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('access read timed out')), READ_TIMEOUT_MS); });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

// The page-granted lists for the sign-in check: { lists, unavailable }. It NEVER throws.
//  - Cached per instance for 30 s, so this is at most one Cosmos read per 30 s, not one per request.
//  - Concurrent callers share ONE read, and a read gives up after 2.5 s, so a slow Cosmos can't pile
//    every request up behind it.
//  - If a read fails, the last good copy keeps being used and the next try is ~5 s later (also when
//    there is no good copy yet, so a failing read isn't repeated on every request).
//  - `unavailable` is true only when a read failed and there is NOTHING cached: the Azure lists still
//    apply, but we can't tell "not granted on the page" from "couldn't check" (auth.js answers 503,
//    not 403, to someone who needs the page lists for what they asked).
async function getAccessLists() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return { lists: cache, unavailable: false };
  if (now >= retryAt) {
    if (!inflight) {
      const g = gen;
      inflight = readWithTimeout(g).then(
        (r) => r.lists, // (cached inside readWithTimeout unless a save happened during the read)
        (e) => {
          retryAt = Date.now() + RETRY_MS;
          console.warn('ACCESS_READ_FAILED ' + String((e && e.message) || e).slice(0, 160));
          return null;
        }
      ).finally(() => { inflight = null; });
    }
    const fresh = await inflight;
    if (fresh) return { lists: fresh, unavailable: false };
  }
  // Reads keep failing: keep honoring the last good copy, but not forever.
  return cache && Date.now() - cacheAt < MAX_STALE_MS ? { lists: cache, unavailable: false } : { lists: emptyLists(), unavailable: true };
}
// After a save: the next request re-reads, but the previous good copy is kept as a fallback if that read fails.
function invalidateAccessCache() { gen++; cacheAt = 0; retryAt = 0; inflight = null; }
// After our own save the new lists ARE the truth on this instance: use them straight away.
function primeAccessCache(lists) { gen++; cache = lists; cacheAt = Date.now(); retryAt = 0; inflight = null; }

class AccessConflict extends Error {}

// Adds/removes people in ONE group, only if the list is still the version the caller started from.
// Returns what REALLY changed ({added, removed}); a request that changes nothing writes nothing.
async function updateGroup(group, add, remove, by, expectVersion) {
  if (!GROUPS.includes(group)) throw new Error('Unknown group');
  const c = getContainer(CONTAINER_ID);
  const cur = await readAccess(c);
  if (String(expectVersion || '') !== cur.version) throw new AccessConflict('The access list was changed by someone else.');
  const lists = cur.lists;
  const before = lists[group];
  const gone = new Set((remove || []).map(normUpn));
  const next = before.filter((u) => !gone.has(u));
  (add || []).map(normUpn).forEach((u) => { if (validUpn(u) && !next.includes(u)) next.push(u); });
  const added = next.filter((u) => !before.includes(u));
  const removed = before.filter((u) => !next.includes(u));
  if (!added.length && !removed.length) return { lists, version: cur.version, added, removed };
  if (next.length > MAX_PER_GROUP) throw new Error('Too many people in this group');
  lists[group] = next;
  const doc = { id: DOC_ID, ...lists, updatedAt: new Date().toISOString(), updatedBy: by || null };
  try {
    if (cur.etag) await c.item(DOC_ID, DOC_ID).replace(doc, { accessCondition: { type: 'IfMatch', condition: cur.etag } });
    else await c.items.create(doc);
  } catch (e) {
    if (e && (e.code === 412 || e.code === 409)) throw new AccessConflict('The access list was changed by someone else.');
    throw e;
  }
  primeAccessCache(lists);
  return { lists, version: doc.updatedAt, added, removed };
}

module.exports = { GROUPS, MAX_PER_GROUP, normUpn, validUpn, readAccess, getAccessLists, invalidateAccessCache, updateGroup, AccessConflict, emptyLists };
