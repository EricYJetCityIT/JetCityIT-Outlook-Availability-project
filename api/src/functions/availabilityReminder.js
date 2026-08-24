const { app } = require('@azure/functions');
const { getContainer } = require('../lib/cosmos');
const { fetchSheet, resolveColumns } = require('../lib/smartsheet');
const { sendMail, listUsers } = require('../lib/graph');
const { safeEqual } = require('../lib/secure');
const { audit } = require('../lib/audit');

const AVAILABILITY_CONTAINER = 'availability';
const DISPATCH_CONTAINER = 'dispatch';
const DISPATCH_DOC_ID = 'state';
const SENDER = 'Ericy@jetcityit.com';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Mirrors the client's getMondayOf()/weekKey() (index.html) so the server
// checks the exact same week bucket the "My availability" tab writes to. Uses
// UTC date math throughout -- Azure Functions run in UTC, and the cron only
// ever fires while it's still Monday in both UTC and Pacific, so there's no
// day-boundary edge case to worry about here.
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d;
}
function weekKeyOf(mon) {
  return `wk:${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
}
function weekLabel(mon) {
  const fri = new Date(mon);
  fri.setUTCDate(mon.getUTCDate() + 4);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(mon)} – ${fmt(fri)}`;
}

// Normalizes a name to a first-name + last-initial key ("dylan|m") so an
// abbreviated roster name ("Dylan M") matches the full display name people
// actually submit availability under ("Dylan McCormack"). Mirrors
// normNameKey() in index.html so the reminder agrees with the dispatch view.
function normNameKey(s) {
  const t = String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return t.length > 1 ? `${t[0]}|${t[1][0]}` : t[0] || '';
}

async function submittedNames(weekKey) {
  const { resources } = await getContainer(AVAILABILITY_CONTAINER).items
    .query({
      query: 'SELECT c.name FROM c WHERE c.weekKey = @weekKey',
      parameters: [{ name: '@weekKey', value: weekKey }],
    })
    .fetchAll();
  return resources.map((r) => r.name);
}

// Returns a predicate "did this roster name submit?" that tolerates the
// abbreviated-vs-full-name mismatch that otherwise flags nearly everyone as
// missing. A worker counts as submitted if their name matches a submission
// exactly, or unambiguously by first-name + last-initial -- exactly one
// submitter shares the key. The unambiguous guard mirrors resolveAvailName()
// in index.html so a Jason Martin / Jason Miller style collision never marks
// the wrong person done (in that case we fall through to reminding both).
function submissionLookup(names) {
  const exact = new Set(names.map((n) => n.trim().toLowerCase()));
  const keyCounts = new Map();
  names.forEach((n) => {
    const k = normNameKey(n);
    keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
  });
  return (workerName) =>
    exact.has(workerName.trim().toLowerCase()) || keyCounts.get(normNameKey(workerName)) === 1;
}

async function activeWorkerNames() {
  let resource;
  try {
    ({ resource } = await getContainer(DISPATCH_CONTAINER).item(DISPATCH_DOC_ID, DISPATCH_DOC_ID).read());
  } catch (e) {
    if (e.code === 404) return [];
    throw e;
  }
  return (resource && resource.workers ? resource.workers : []).filter((w) => w.active).map((w) => w.name);
}

// Matches a roster name (e.g. "Ben V", abbreviated to first name + last
// initial, same convention the Smartsheet roster already uses) against the
// company directory by first-name + last-initial. Checks the initial against
// EVERY word after the first name, not just the last one -- a directory
// displayName like "Ben Van Cise" means the roster's "V" is the first half of
// a compound surname ("Van Cise"), not the final word ("Cise"). Good enough
// for a ~20 person roster; a company large enough to have two people share
// both a first name and some later-word initial would need something
// sturdier than name matching anyway.
function matchDirectoryUser(name, directoryUsers) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const firstName = parts[0].toLowerCase();
  const lastInitial = parts[parts.length - 1][0].toLowerCase();
  const match = directoryUsers.find((u) => {
    const dParts = (u.displayName || '').trim().split(/\s+/);
    if (dParts.length < 2 || dParts[0].toLowerCase() !== firstName) return false;
    return dParts.slice(1).some((p) => p[0].toLowerCase() === lastInitial);
  });
  return match ? match.mail || match.userPrincipalName || null : null;
}

// Checks this week and next week for missing availability submissions among
// the active roster, and emails anyone missing either one -- one combined
// email per person naming which week(s), not one email per missing week.
async function runReminder(context, { dryRun = false } = {}) {
  const now = new Date();
  const thisMonday = mondayOf(now);
  const nextMonday = new Date(thisMonday);
  nextMonday.setUTCDate(thisMonday.getUTCDate() + 7);
  const weeks = [
    { key: weekKeyOf(thisMonday), label: weekLabel(thisMonday) },
    { key: weekKeyOf(nextMonday), label: weekLabel(nextMonday) },
  ];

  const [workers, submittedByWeek] = await Promise.all([
    activeWorkerNames(),
    Promise.all(weeks.map((w) => submittedNames(w.key))),
  ]);
  const hasSubmitted = submittedByWeek.map((names) => submissionLookup(names));

  // name -> [missing week labels]
  const missing = new Map();
  workers.forEach((name) => {
    const missingWeeks = weeks.filter((w, i) => !hasSubmitted[i](name)).map((w) => w.label);
    if (missingWeeks.length) missing.set(name, missingWeeks);
  });

  if (!missing.size) {
    context.log('availability-reminder: everyone on the active roster is up to date, nothing to send.');
    return { sent: 0, skipped: 0, weeks: weeks.map((w) => w.key) };
  }

  const sheet = await fetchSheet();
  const { emailToName } = resolveColumns(sheet);
  const nameToEmail = new Map();
  emailToName.forEach((name, email) => nameToEmail.set(name, email));

  // The company directory is only fetched if Smartsheet's contact map
  // actually misses someone -- most weeks it won't be needed at all.
  let directoryUsers = null;
  let directoryError = null;
  async function directoryUsersOnce() {
    if (directoryUsers === null) {
      try {
        directoryUsers = await listUsers();
      } catch (e) {
        directoryError = e.message;
        directoryUsers = [];
      }
    }
    return directoryUsers;
  }

  let sent = 0;
  let skipped = 0;
  // Surfaced directly in the response (not just context.log/error) because
  // Application Insights isn't enabled on this app -- those calls have
  // nowhere to land, so this is the only way to see why someone was skipped.
  const skippedDetail = [];
  // In a dry run, the list of who WOULD be emailed (and for which weeks) is
  // returned instead of anything being sent -- lets us verify the name
  // matching without spamming the team.
  const wouldSend = [];
  for (const [name, missingWeeks] of missing) {
    let email = nameToEmail.get(name);
    if (!email) {
      email = matchDirectoryUser(name, await directoryUsersOnce());
    }
    if (!email) {
      skipped++;
      skippedDetail.push({ name, reason: 'no-email-on-file', directoryError: directoryError || undefined });
      continue;
    }
    if (dryRun) {
      wouldSend.push({ name, email, weeks: missingWeeks });
      continue;
    }
    const weeksHtml = missingWeeks.map((label) => `<li>${label}</li>`).join('');
    const html = `<p>Hey ${name.split(' ')[0]},</p>
<p>Just a heads up — you haven't submitted your availability yet for:</p>
<ul>${weeksHtml}</ul>
<p><a href="https://crew-calendar.jetcityit.com/">Submit it here</a> — takes less than a minute.</p>
<p>Thanks,<br/>Eric</p>`;
    try {
      await sendMail({ from: SENDER, to: email, subject: 'Reminder: submit your availability', html });
      sent++;
    } catch (e) {
      skipped++;
      skippedDetail.push({ name, reason: 'send-failed', error: e.message });
    }
  }

  if (dryRun) {
    return { dryRun: true, wouldSend, skipped, skippedDetail, weeks: weeks.map((w) => w.key) };
  }
  audit(context, null, 'availability.reminder.sent', { weeks: weeks.map((w) => w.key), sent, skipped });
  return { sent, skipped, skippedDetail, weeks: weeks.map((w) => w.key) };
}

// HTTP-triggered (SWA managed Functions don't run Timer triggers) and called
// by a GitHub Actions cron every Monday, gated by the same shared SYNC_SECRET
// already used for the Smartsheet sync / report-match crons.
app.http('availabilityReminder', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'availability-reminder',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || !safeEqual(provided, expected)) {
      return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    }

    try {
      // ?dry=1 (or ?dryRun=true) computes and returns who would be emailed
      // without sending anything -- safe way to verify the name matching.
      const dryParam = (request.query.get('dry') || request.query.get('dryRun') || '').toLowerCase();
      const dryRun = dryParam === '1' || dryParam === 'true';
      const result = await runReminder(context, { dryRun });
      return { jsonBody: result };
    } catch (e) {
      // Application Insights isn't enabled on this app, so context.error has
      // nowhere to land -- include the message in the response itself.
      return { status: 500, jsonBody: { error: 'availability-reminder failed', message: e.message } };
    }
  },
});

module.exports = { runReminder };
