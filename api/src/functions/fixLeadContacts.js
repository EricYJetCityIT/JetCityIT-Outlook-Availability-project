const { app } = require('@azure/functions');
const { safeEqual } = require('../lib/secure');
const { fetchSheet, resolveColumns } = require('../lib/smartsheet');

// One-off: rename the jason@ contact from "Jason M" to "Jason P" in the JCIT
// Lead + Technicians column contact lists (the Smartsheet dropdown), using the
// app's Smartsheet token — which may have Admin on the sheet where the
// interactive identity does not. SYNC_SECRET-gated. Only the contact list
// (column definition) changes; no row/cell data is touched.
const BASE = 'https://api.smartsheet.com/2.0';

app.http('fixLeadContacts', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'fix-lead-contacts',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || !safeEqual(provided, expected)) {
      return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    }
    try {
      const sheetId = process.env.SMARTSHEET_SHEET_ID;
      const token = process.env.SMARTSHEET_API_TOKEN;
      const sheet = await fetchSheet();
      const { COLUMNS } = resolveColumns(sheet);
      const targets = [COLUMNS.lead, COLUMNS.technicians];
      const results = [];
      for (const col of targets) {
        const opts = (col.contactOptions || []).map((o) => ({
          email: o.email,
          name: String(o.email || '').toLowerCase() === 'jason@jetcityit.com' ? 'Jason P' : o.name,
        }));
        const res = await fetch(`${BASE}/sheets/${sheetId}/columns/${col.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'MULTI_CONTACT_LIST', contactOptions: opts }),
        });
        const body = await res.text().catch(() => '');
        results.push({ column: col.title, status: res.status, ok: res.ok, body: body.slice(0, 200) });
      }
      return { jsonBody: { results } };
    } catch (e) {
      context.error('fix-lead-contacts failed:', e);
      return { status: 500, jsonBody: { error: String(e.message || e) } };
    }
  },
});
