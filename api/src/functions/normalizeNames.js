const { app } = require('@azure/functions');
const { safeEqual } = require('../lib/secure');
const { fetchSheet, buildNameNormalizationRows, putRows, resolveColumns } = require('../lib/smartsheet');

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
      const url = new URL(request.url);
      const apply = url.searchParams.get('apply') === 'true';
      const onlyRowId = url.searchParams.get('rowId') || null; // limit to one row for testing
      const sheet = await fetchSheet();
      const updates = buildNameNormalizationRows(sheet, onlyRowId);
      const sample = updates.slice(0, 8).map((u) => ({ rowId: u.id, changes: u.changes }));
      if (!apply) {
        // Diagnostic: raw objectValue of the first few Lead/Technicians cells
        // that mention Jason, so we can see exactly how the contact is stored.
        let raw = [];
        try {
          const { COLUMNS } = resolveColumns(sheet);
          const ids = [COLUMNS.lead.id, COLUMNS.technicians.id];
          for (const row of (sheet.rows || [])) {
            for (const cell of (row.cells || [])) {
              if (ids.includes(cell.columnId) && /jason/i.test(cell.displayValue || '')) {
                raw.push({ display: cell.displayValue, value: cell.value, objectValue: cell.objectValue });
              }
            }
            if (raw.length >= 3) break;
          }
        } catch (e) { raw = [{ err: String(e.message || e) }]; }
        return { jsonBody: { dryRun: true, rowsToChange: updates.length, sample, raw } };
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
