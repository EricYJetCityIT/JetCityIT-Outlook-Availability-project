const { app } = require('@azure/functions');
const { safeEqual } = require('../lib/secure');
const { fetchSheet, buildNameNormalizationRows, putRows } = require('../lib/smartsheet');

// One-off maintenance pass: rewrite Lead/Technicians contact display names on
// the Crew Calendar sheet to their canonical form (the same canonicalName
// overrides the app uses — e.g. "Jason M" -> "Jason P"), so the source sheet
// matches what the app shows. SYNC_SECRET-gated like the sync jobs. Dry-run by
// default; pass ?apply=true to write. Other contacts in each cell are preserved.
function getSheetId() {
  const id = process.env.SMARTSHEET_SHEET_ID;
  if (!id) throw new Error('SMARTSHEET_SHEET_ID is not configured');
  return id;
}

app.http('normalizeNames', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'normalize-names',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || !safeEqual(provided, expected)) {
      return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    }
    try {
      const apply = new URL(request.url).searchParams.get('apply') === 'true';
      const sheet = await fetchSheet();
      const updates = buildNameNormalizationRows(sheet);
      const sample = updates.slice(0, 8).map((u) => ({ rowId: u.id, changes: u.changes }));
      if (!apply) {
        return { jsonBody: { dryRun: true, rowsToChange: updates.length, sample } };
      }
      const sheetId = getSheetId();
      let written = 0;
      const CH = 100; // batch PUTs
      for (let i = 0; i < updates.length; i += CH) {
        const batch = updates.slice(i, i + CH).map((u) => ({ id: u.id, cells: u.cells }));
        await putRows(sheetId, batch, { allowPartialSuccess: true });
        written += batch.length;
      }
      return { jsonBody: { applied: true, rowsChanged: written, sample } };
    } catch (e) {
      context.error('normalize-names failed:', e);
      return { status: 500, jsonBody: { error: String(e.message || e) } };
    }
  },
});
