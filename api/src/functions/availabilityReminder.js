const { app } = require('@azure/functions');
const { getContainer } = require('../lib/cosmos');
const { fetchSheet, resolveColumns } = require('../lib/smartsheet');
const { sendMail } = require('../lib/graph');
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

async function submittedNameSet(weekKey) {
  const { resources } = await getContainer(AVAILABILITY_CONTAINER).items
    .query({
      query: 'SELECT c.name FROM c WHERE c.weekKey = @weekKey',
      parameters: [{ name: '@weekKey', value: weekKey }],
    })
    .fetchAll();
  return new Set(resources.map((r) => r.name.trim().toLowerCase()));
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

// Checks this week and next week for missing availability submissions among
// the active roster, and emails anyone missing either one -- one combined
// email per person naming which week(s), not one email per missing week.
async function runReminder(context) {
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
    Promise.all(weeks.map((w) => submittedNameSet(w.key))),
  ]);

  // name -> [missing week labels]
  const missing = new Map();
  workers.forEach((name) => {
    const key = name.trim().toLowerCase();
    const missingWeeks = weeks.filter((w, i) => !submittedByWeek[i].has(key)).map((w) => w.label);
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

  let sent = 0;
  let skipped = 0;
  for (const [name, missingWeeks] of missing) {
    const email = nameToEmail.get(name);
    if (!email) {
      skipped++;
      context.log(`availability-reminder: no email on file for "${name}", skipping.`);
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
      context.error(`availability-reminder: failed to email ${name}:`, e);
    }
  }

  audit(context, null, 'availability.reminder.sent', { weeks: weeks.map((w) => w.key), sent, skipped });
  context.log(`availability-reminder: ${sent} sent, ${skipped} skipped.`);
  return { sent, skipped, weeks: weeks.map((w) => w.key) };
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
      const result = await runReminder(context);
      return { jsonBody: result };
    } catch (e) {
      context.error('availability-reminder failed:', e);
      return { status: 500, jsonBody: { error: 'availability-reminder failed' } };
    }
  },
});

module.exports = { runReminder };
