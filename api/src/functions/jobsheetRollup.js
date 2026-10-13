const { app } = require('@azure/functions');
const { safeEqual } = require('../lib/secure');
const { runNightlyRollup } = require('../lib/jobsheetRollup');

// Nightly pre-warm of the Tech tracking rollups (see lib/jobsheetRollup.js).
// Azure Static Web Apps' managed Functions only run HTTP triggers, so -- exactly
// like smartsheetSync.js -- this is a plain HTTP endpoint called on a schedule by
// a GitHub Actions cron (.github/workflows/jobsheet-rollup-schedule.yml) and
// guarded by the shared SYNC_SECRET rather than user auth. Tech tracking stays
// correct without it (missing days are built on demand); this just keeps reads fast.
app.http('jobsheetRollup', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'jobsheet/rollup',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || !safeEqual(provided, expected)) {
      return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    }
    try {
      // Failure details go to the function log only; the response (printed in the public Actions log) is counts.
      const result = await runNightlyRollup({ onError: (day, err) => context.error(`Job sheet rollup failed for ${day}:`, err) });
      context.log(`Job sheet rollup: ${result.rolled} day(s) rolled, ${result.pending} pending, ${result.failed} failed.`);
      // A non-2xx makes the workflow step (curl -f) go red, so a night with failures doesn't pass silently.
      if (result.failed > 0) return { status: 500, jsonBody: { error: 'Rollup finished with errors', failed: result.failed, rolled: result.rolled } };
      return { jsonBody: result };
    } catch (e) {
      context.error('Job sheet rollup failed:', e);
      return { status: 500, jsonBody: { error: 'Rollup failed' } };
    }
  },
});
