const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { runSync } = require('./smartsheetSync');

// User-triggered "Refresh" for the Dispatch board and Crew calendar. Lets a
// signed-in @jetcityit.com user pull the latest from the "JCIT 2026 Crew
// Calendar" Smartsheet on demand — so an open tab can show sheet edits without
// a full page reload, instead of waiting for the scheduled GitHub Actions sync.
//
// This is a thin, authenticated wrapper around the same runSync the cron uses:
//   - The cron path (/api/smartsheet-sync) is guarded by SYNC_SECRET because its
//     caller is a GitHub Actions job, not a user — that secret must NOT reach the
//     browser, so the button can't call that endpoint directly.
//   - Here, requireUser enforces the @jetcityit.com bearer token AND the shared
//     per-user rate limiter (auth.js), which blunts button-mashing.
//
// runSync itself is cheap when nothing changed: it skips the transform+write
// when the sheet's modifiedAt is unchanged (still one Smartsheet read). The
// frontend re-pulls /api/dispatch afterwards to pick up the refreshed state.
app.http('dispatchRefresh', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'dispatch/refresh',
  handler: async (request, context) => {
    try {
      await requireUser(request);
      // FORCE a full re-sync. This is a manual "refresh now" button, so the user
      // expects the freshest data + an advanced timestamp every time — unlike the
      // cron (runSync false), which skips the re-transform when the sheet's
      // modifiedAt is unchanged. Forcing also means the button picks up
      // transform-code changes immediately.
      const result = await runSync(context, true);
      return { jsonBody: result };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
