const { app } = require('@azure/functions');
const { getContainer } = require('../lib/cosmos');
const { fetchSheet, transformSheetToDispatch } = require('../lib/smartsheet');

const CONTAINER_ID = 'dispatch';
const STATE_DOC_ID = 'state';
const SYNC_DOC_ID = 'smartsheet-sync-state';

async function readSyncState(container) {
  try {
    const { resource } = await container.item(SYNC_DOC_ID, SYNC_DOC_ID).read();
    return resource || null;
  } catch (e) {
    if (e.code === 404) return null;
    throw e;
  }
}

// Mirrors the "JCIT 2026 Crew Calendar" Smartsheet into the shared dispatch
// doc that both the Manager Dispatch view and Crew calendar read from.
// Smartsheet is the sole source of truth now — this always fully replaces
// workers/jobs with what's currently in the sheet, it does not merge.
// Skips the (expensive) transform+write entirely when the sheet's
// modifiedAt hasn't changed since the last check.
async function runSync(context) {
  const container = getContainer(CONTAINER_ID);
  const syncState = await readSyncState(container);
  const sheet = await fetchSheet();
  const now = new Date().toISOString();

  if (syncState && syncState.lastSheetModifiedAt === sheet.modifiedAt) {
    context.log('Smartsheet unchanged since last sync, skipping.');
    await container.items.upsert({ ...syncState, id: SYNC_DOC_ID, lastCheckedAt: now });
    return { synced: false, jobCount: syncState.jobCount, workerCount: syncState.workerCount };
  }

  const { workers, jobs } = transformSheetToDispatch(sheet);

  await container.items.upsert({
    id: STATE_DOC_ID,
    workers,
    jobs,
    updatedBy: 'smartsheet-sync',
    updatedAt: now,
    source: 'smartsheet',
  });

  await container.items.upsert({
    id: SYNC_DOC_ID,
    lastSheetModifiedAt: sheet.modifiedAt,
    lastCheckedAt: now,
    lastSyncedAt: now,
    jobCount: jobs.length,
    workerCount: workers.length,
  });

  context.log(`Smartsheet synced: ${jobs.length} jobs, ${workers.length} workers.`);
  return { synced: true, jobCount: jobs.length, workerCount: workers.length };
}

// Azure Static Web Apps' *managed* Functions integration only supports
// HTTP-triggered functions — Timer triggers are silently never invoked
// there (a real, documented limitation, not a config mistake). So this
// runs as a plain HTTP endpoint instead, called on a schedule by a GitHub
// Actions cron workflow (.github/workflows/smartsheet-sync-schedule.yml).
// Guarded by a shared secret rather than user auth, since the caller is a
// GitHub Actions job, not a signed-in @jetcityit.com user.
app.http('smartsheetSync', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'smartsheet-sync',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || provided !== expected) {
      return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    }

    try {
      const result = await runSync(context);
      return { jsonBody: result };
    } catch (e) {
      context.error('Smartsheet sync failed:', e);
      return { status: 500, jsonBody: { error: 'Sync failed' } };
    }
  },
});

module.exports = { runSync };
