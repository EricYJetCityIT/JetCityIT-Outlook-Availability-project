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
    return;
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
}

app.timer('smartsheetSync', {
  schedule: '0 */10 * * * *',
  handler: async (myTimer, context) => {
    try {
      await runSync(context);
    } catch (e) {
      context.error('Smartsheet sync failed:', e);
    }
  },
});

module.exports = { runSync };
