const { createHash } = require('crypto');
const { getContainer } = require('./cosmos');

// Per-tech, per-day rollup of the Job Sheets / Floor Maps attribution log
// (jobsheetActivity.js writes one `jsact:` doc per save). The Manager view's Tech
// tracking tab used to re-read every raw entry in the range on every open; this
// folds each completed day into one small doc per (day, sheet, tech) so a long
// range reads hundreds of small docs instead of tens of thousands of entries.
//
//   jsroll:<day>:<sheetId>:<hash(user)>   the rollup doc (see buildRecords)
//   jsrolled:<day>                         marker: this day is fully rolled up
//
// Days are America/Los_Angeles calendar days (the crew works in Seattle), written
// 'YYYY-MM-DD'. Correctness never depends on the nightly job having run:
//   * a completed day with no marker is computed on demand (and saved, a few per
//     request) -- the nightly job is only a pre-warmer;
//   * today is always computed on demand from the raw entries (never saved);
//   * a late entry (an offline-queued save synced after its day ended) deletes
//     that day's marker, so the day is rebuilt on the next read.
// The aggregation below mirrors the client engine (fmBuildActivity in index.html:
// "visits" = consecutive saves on one item by one tech; time on an item = the
// longest open->save per session; gaps over 20 minutes are breaks) so the numbers
// match the per-sheet Activity report.
const CONTAINER_ID = 'dispatch';
const ACT_PREFIX = 'jsact:';
const ROLL_PREFIX = 'jsroll:';
const MARK_PREFIX = 'jsrolled:';
const TZ = 'America/Los_Angeles';
const GAP_CAP_SEC = 20 * 60;
const MAX_RAW = 20000;          // raw entries read on the fly per request
const MAX_HEAL_PER_READ = 10;   // completed days built-and-saved per read request
const MAX_DAYS = 4000;          // sanity cap on a day range
const MAX_RANGE_DAYS = 730;     // reads and the nightly backfill never reach further back than this (a stray 1970 entry must not make "All time" walk 56 years)
const READ_BUDGET_MS = 20000;   // wall-clock budget for one read request (the SWA limit is ~45 s)
const MAX_RUN_QUERIES = 20;     // on-the-fly queries per read request (one per run of consecutive unrolled days)

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function ptParts(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
function ptDay(ms) { const p = ptParts(ms); return `${p.year}-${p.month}-${p.day}`; }

function isDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// Inclusive list of days; 'YYYY-MM-DD' strings compare in date order.
function dayRange(a, b) {
  const out = [];
  for (let d = a; d <= b && out.length < MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}
// The UTC instant a Pacific day starts (07:00Z in daylight time, 08:00Z otherwise).
function ptMidnight(day) {
  const [y, m, d] = day.split('-').map(Number);
  for (const off of [8, 7]) {
    const t = Date.UTC(y, m - 1, d, off);
    const p = ptParts(t);
    if (p.hour === '00' && p.minute === '00' && `${p.year}-${p.month}-${p.day}` === day) return t;
  }
  throw new Error('Bad day ' + day);
}

// Same normalisation as the client's fmNorm / jsActKey, so an entry maps to the same item.
function fmNorm(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
    .replace(/^(desk|station|seat|ws|#)\s*[-#:.]?\s*/, '')
    .replace(/^0+(?=\d)/, '');
}
function itemKey(it) {
  if (it.rowId) return 'r:' + it.rowId;
  const n = fmNorm(it.rowLabel);
  return n ? 'l:' + n : '';
}

// Raw log entries -> one record per (sheet, tech) for ONE day's entries.
//   items   distinct item keys worked        timed   { itemKey: seconds on it }
//   photos / edits  save counts              gapSum / gapN  item-to-item gaps
//   first / last    first and last capturedAt   userName/sheetName: latest non-empty
function buildRecords(entries, day) {
  const groups = new Map();
  for (const it of entries || []) {
    const key = itemKey(it), t = Date.parse(it.capturedAt);
    if (!key || Number.isNaN(t)) continue;
    const user = it.user || it.userName || 'unknown';
    const gk = String(it.sheetId || '') + '\u0001' + user;
    let g = groups.get(gk);
    if (!g) { g = { sheetId: String(it.sheetId || ''), user, list: [] }; groups.set(gk, g); }
    g.list.push({
      key, t, at: it.capturedAt, photo: it.action === 'photo', dur: it.durationSec == null ? null : it.durationSec,
      sid: it.sessionId || '', name: it.userName || it.user || 'Unknown', sheetName: it.sheetName || '',
    });
  }
  const out = [];
  groups.forEach((g) => {
    const arr = g.list.sort((a, b) => a.t - b.t);
    const visits = [];
    arr.forEach((e) => {
      const open = e.t - (e.dur == null ? 0 : e.dur * 1000), last = visits[visits.length - 1];
      if (last && last.key === e.key) { last.end = Math.max(last.end, e.t); last.start = Math.min(last.start, open); last.entries.push(e); }
      else visits.push({ key: e.key, start: open, end: e.t, entries: [e] });
    });
    const items = new Set(), timed = {};
    let gapSum = 0, gapN = 0, photos = 0, edits = 0;
    visits.forEach((v, i) => {
      items.add(v.key);
      // Time on an item: the longest open->save per session (several saves in one open all measure "since open").
      const sm = {};
      v.entries.forEach((e) => {
        if (e.sid && e.dur != null && (sm[e.sid] == null || e.dur > sm[e.sid])) sm[e.sid] = e.dur;
        if (e.photo) photos++; else edits++;
      });
      const sids = Object.keys(sm);
      if (sids.length) timed[v.key] = (timed[v.key] || 0) + sids.reduce((s, k) => s + sm[k], 0);
      if (i > 0) {
        const gap = Math.max(0, Math.round((v.start - visits[i - 1].end) / 1000));
        if (gap <= GAP_CAP_SEC) { gapSum += gap; gapN++; }
      }
    });
    let sheetName = '';
    arr.forEach((e) => { if (e.sheetName) sheetName = e.sheetName; });
    out.push({
      day, sheetId: g.sheetId, sheetName, user: g.user, userName: arr[arr.length - 1].name,
      items: [...items], timed, photos, edits, gapSum, gapN, first: arr[0].at, last: arr[arr.length - 1].at,
    });
  });
  return out;
}

function rollId(rec) {
  const sheet = String(rec.sheetId).replace(/[^A-Za-z0-9_-]/g, '_') || 'none';
  return ROLL_PREFIX + rec.day + ':' + sheet + ':' + createHash('sha1').update(String(rec.user)).digest('hex').slice(0, 12);
}

// Raw entries whose capturedAt falls in [startIso, endIso), newest first so a cut-off drops the OLDEST.
// `cap` bounds the read; one extra row says "cut off".
async function fetchEntries(container, startIso, endIso, cap) {
  const n = Math.max(1, Math.floor(cap));
  const { resources } = await container.items
    .query({
      query: `SELECT TOP ${n + 1} c.sheetId, c.sheetName, c.rowId, c.rowLabel, c.action, c.user, c.userName, c.capturedAt, c.durationSec, c.sessionId FROM c WHERE STARTSWITH(c.id, @p) AND c.capturedAt >= @a AND c.capturedAt < @b ORDER BY c.capturedAt DESC`,
      parameters: [{ name: '@p', value: ACT_PREFIX }, { name: '@a', value: startIso }, { name: '@b', value: endIso }],
    })
    .fetchAll();
  return { entries: resources.length > n ? resources.slice(0, n) : resources, cut: resources.length > n };
}
async function countEntries(container, startIso, endIso) {
  const { resources } = await container.items
    .query({
      query: 'SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p) AND c.capturedAt >= @a AND c.capturedAt < @b',
      parameters: [{ name: '@p', value: ACT_PREFIX }, { name: '@a', value: startIso }, { name: '@b', value: endIso }],
    })
    .fetchAll();
  return Number(resources[0]) || 0;
}
const dayStartIso = (day) => new Date(ptMidnight(day)).toISOString();
async function entriesForDay(container, day, cap) {
  return fetchEntries(container, dayStartIso(day), dayStartIso(addDays(day, 1)), cap);
}

// Rebuild one day from the raw log and save it (rollup docs first, marker last, so a day is only
// ever "rolled up" once all of its docs exist). Returns the records for the caller to reuse.
// Race guard: the entries are read BEFORE the marker is written, so a late save that lands in
// between would otherwise be marked "done" without being counted (its marker delete found nothing
// to delete). After writing the marker the day's entries are counted again; if the count moved,
// the day is rebuilt once more, and if it still moves the marker is dropped so a later read rebuilds it.
async function rollupDay(day) {
  const container = getContainer(CONTAINER_ID);
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { entries, cut } = await entriesForDay(container, day, MAX_RAW);
    const records = buildRecords(entries, day);
    last = { records, persisted: false, entries: entries.length, docs: 0, cut };
    if (cut) return last; // too big to trust: serve what was read, don't mark it done
    // A failed save must not fail the read that triggered it: the records are still good to serve.
    try {
      const keep = new Set();
      for (const rec of records) {
        const id = rollId(rec);
        keep.add(id);
        await container.items.upsert({ ...rec, id, type: 'jobSheetRollup', computedAt: new Date().toISOString() });
      }
      const { resources: old } = await container.items
        .query({ query: 'SELECT c.id FROM c WHERE STARTSWITH(c.id, @p)', parameters: [{ name: '@p', value: ROLL_PREFIX + day + ':' }] })
        .fetchAll();
      for (const o of old) { if (!keep.has(o.id)) await container.item(o.id, o.id).delete().catch((e) => { if (e.code !== 404) throw e; }); }
      await container.items.upsert({
        id: MARK_PREFIX + day, type: 'jobSheetRollupDay', day, entryCount: entries.length, docCount: records.length, computedAt: new Date().toISOString(),
      });
      const now = await countEntries(container, dayStartIso(day), dayStartIso(addDays(day, 1)));
      if (now === entries.length) { last.persisted = true; last.docs = records.length; return last; }
    } catch (e) {
      last.error = 'save failed';
      return last;
    }
  }
  // Still changing under us: don't leave a marker that may be stale.
  try { await invalidateRollupDay(day); } catch (_) { /* the next read recounts nothing; the nightly job re-rolls recent days */ }
  last.persisted = false;
  return last;
}

// A save with a capturedAt in an already-finished day (an offline-queued edit that synced late)
// makes that day's rollup stale: drop its marker so the next read rebuilds it. Retried a couple of
// times so a transient Cosmos error (429/503) doesn't leave a stale marker behind.
async function invalidateRollupDay(day) {
  const container = getContainer(CONTAINER_ID);
  const id = MARK_PREFIX + day;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await container.item(id, id).delete();
      return;
    } catch (e) {
      if (e && e.code === 404) return;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function rolledDays(container, fromDay, toDay) {
  const { resources } = await container.items
    .query({
      query: 'SELECT c.day FROM c WHERE STARTSWITH(c.id, @p) AND c.day >= @a AND c.day <= @b',
      parameters: [{ name: '@p', value: MARK_PREFIX }, { name: '@a', value: fromDay }, { name: '@b', value: toDay }],
    })
    .fetchAll();
  return new Set(resources.map((r) => r.day));
}
async function earliestDay(container) {
  const { resources } = await container.items
    .query({ query: 'SELECT TOP 1 c.capturedAt FROM c WHERE STARTSWITH(c.id, @p) ORDER BY c.capturedAt ASC', parameters: [{ name: '@p', value: ACT_PREFIX }] })
    .fetchAll();
  return resources.length && !Number.isNaN(Date.parse(resources[0].capturedAt)) ? ptDay(Date.parse(resources[0].capturedAt)) : null;
}

const PUBLIC_FIELDS = ['day', 'sheetId', 'sheetName', 'user', 'userName', 'items', 'timed', 'photos', 'edits', 'gapSum', 'gapN', 'first', 'last'];
function publicRecord(r) {
  const o = {};
  PUBLIC_FIELDS.forEach((f) => { o[f] = r[f]; });
  return o;
}
// Split a sorted list of days into runs of consecutive days.
function dayRuns(days) {
  const runs = [];
  days.forEach((d) => {
    const run = runs[runs.length - 1];
    if (run && addDays(run[run.length - 1], 1) === d) run.push(d); else runs.push([d]);
  });
  return runs;
}

// Records for the inclusive Pacific-day range [fromDay, toDay] (either may be null = open-ended).
// Completed days come from saved rollups; today and any not-yet-rolled day are computed on the fly.
// { records, truncated, healed, today }: truncated = part of the range was left out (older than
// MAX_RANGE_DAYS, over the time or raw-entry budget); a retry gets further because healed days are saved.
async function readRange(fromDay, toDay) {
  const started = Date.now();
  const container = getContainer(CONTAINER_ID);
  const today = ptDay(started);
  const yesterday = addDays(today, -1);
  const out = { records: [], truncated: false, healed: 0, today };
  if (!fromDay) fromDay = await earliestDay(container);
  if (!fromDay) return out;                                    // no activity logged yet
  const floor = addDays(today, -MAX_RANGE_DAYS);               // never walk an unbounded span (a stray 1970 entry, ?from=0001-01-01)
  if (fromDay < floor) { fromDay = floor; out.truncated = true; }
  const lastDay = toDay && toDay < today ? toDay : today;       // nothing exists past today
  if (fromDay > lastDay) return out;

  // Today (still in progress): never saved. Read first, with its own budget, so it can't be starved by backlog days.
  if (lastDay === today) {
    const { entries, cut } = await entriesForDay(container, today, MAX_RAW);
    if (cut) out.truncated = true;
    buildRecords(entries, today).forEach((x) => out.records.push(publicRecord(x)));
  }

  const doneEnd = lastDay < yesterday ? lastDay : yesterday;    // completed days: [fromDay, doneEnd]
  const completed = fromDay <= doneEnd ? dayRange(fromDay, doneEnd) : [];
  if (!completed.length) return out;
  const rolled = await rolledDays(container, completed[0], completed[completed.length - 1]);

  // Saved rollups for the completed days that have a marker.
  const have = completed.filter((d) => rolled.has(d));
  if (have.length) {
    const { resources } = await container.items
      .query({
        query: 'SELECT c.day, c.sheetId, c.sheetName, c.user, c.userName, c.items, c.timed, c.photos, c.edits, c.gapSum, c.gapN, c.first, c.last FROM c WHERE STARTSWITH(c.id, @p) AND c.day >= @a AND c.day <= @b',
        parameters: [{ name: '@p', value: ROLL_PREFIX }, { name: '@a', value: have[0] }, { name: '@b', value: have[have.length - 1] }],
      })
      .fetchAll();
    resources.forEach((r) => { if (rolled.has(r.day)) out.records.push(publicRecord(r)); }); // a day whose marker was dropped is rebuilt below instead
  }

  // Completed days with no marker (never rolled up, or invalidated by a late entry), newest first:
  // the first MAX_HEAL_PER_READ are built and saved; the rest are read in runs of consecutive days
  // (one query per run, not per day) and computed without saving. Time and entry budgets keep
  // one request bounded; anything skipped sets `truncated`.
  const missing = completed.filter((d) => !rolled.has(d));
  const toHeal = missing.slice(-MAX_HEAL_PER_READ).reverse();
  const rest = missing.slice(0, Math.max(0, missing.length - MAX_HEAL_PER_READ));
  const outOfTime = () => Date.now() - started > READ_BUDGET_MS;
  for (const d of toHeal) {
    if (outOfTime()) { out.truncated = true; break; }
    const r = await rollupDay(d);
    if (r.persisted) out.healed++;
    if (r.cut) out.truncated = true;
    r.records.forEach((x) => out.records.push(publicRecord(x)));
  }
  let budget = MAX_RAW, queries = 0;
  for (const run of dayRuns(rest).reverse()) {
    if (budget <= 0 || queries >= MAX_RUN_QUERIES || outOfTime()) { out.truncated = true; break; }
    queries++;
    const { entries, cut } = await fetchEntries(container, dayStartIso(run[0]), dayStartIso(addDays(run[run.length - 1], 1)), budget);
    budget -= entries.length;
    if (cut) out.truncated = true;
    const byDay = new Map();
    entries.forEach((e) => {
      const t = Date.parse(e.capturedAt);
      if (Number.isNaN(t)) return;
      const d = ptDay(t);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    });
    byDay.forEach((list, d) => buildRecords(list, d).forEach((x) => out.records.push(publicRecord(x))));
  }
  return out;
}

// Nightly pre-warm (called by the GitHub Actions cron via POST /api/jobsheet/rollup):
// re-roll yesterday and the day before (catches late-synced saves), then backfill any older day
// that has no marker, newest first, until the time budget runs out (a later night continues).
// Returns day counts only; the caller logs the failure details server-side.
async function runNightlyRollup(opts) {
  const started = Date.now();
  const budgetMs = (opts && opts.budgetMs) || 25000;
  const onError = (opts && opts.onError) || (() => {});
  const container = getContainer(CONTAINER_ID);
  const today = ptDay(Date.now());
  const yesterday = addDays(today, -1);
  const rolledList = [];
  let failed = 0;
  const doDay = async (d) => {
    try {
      const r = await rollupDay(d);
      if (r.persisted) rolledList.push(d);
      else { failed++; onError(d, r.error || (r.cut ? 'too many entries to roll up' : 'not saved')); }
    } catch (e) { failed++; onError(d, e); }
  };
  await doDay(yesterday);
  await doDay(addDays(yesterday, -1));
  let pending = 0;
  const first = await earliestDay(container);
  if (first) {
    const floor = addDays(today, -MAX_RANGE_DAYS);
    const lo = first > floor ? first : floor;
    const hi = addDays(yesterday, -2);
    if (lo <= hi) {
      const days = dayRange(lo, hi);
      const rolled = await rolledDays(container, days[0], days[days.length - 1]);
      const missing = days.filter((d) => !rolled.has(d)).reverse();
      for (const d of missing) {
        if (Date.now() - started > budgetMs) { pending++; continue; }
        await doDay(d);
      }
    }
  }
  return { today, rolled: rolledList.length, days: rolledList, pending, failed };
}

module.exports = { ptDay, isDay, addDays, dayRange, ptMidnight, buildRecords, readRange, rollupDay, invalidateRollupDay, runNightlyRollup, itemKey, MAX_RANGE_DAYS };