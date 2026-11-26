const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { audit } = require('../lib/audit');

// A calendar job's linked Smartsheet ("📊 Link Smartsheet" in the New / Edit
// job modal; shown in the job popup). Stored in Cosmos, NOT in the crew
// calendar sheet, so linking never changes Smartsheet. One doc per job in the
// shared `dispatch` container, id-namespaced `joblink:<jobId>` (jobId is the
// app's "ss-<rowId>").
//   GET    /api/job-links            -> { links: { <jobId>: {id,name,url} },     (any signed-in user)
//                                          planLinks: { <project, lowercased>: {planId, sheet, maps, attachments} } }
//   PUT    /api/job-links/{jobId}    -> body { sheet: {id,name,url} }         (Editors)
//   DELETE /api/job-links/{jobId}                                             (Editors)
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'joblink:';
const PLAN_PREFIX = 'plan:'; // project plans share this container (see plans.js)

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
}
function sanitizeSheet(s) {
  if (!s || typeof s !== 'object') return null;
  const id = clean(s.id, 20);
  if (!/^\d+$/.test(id)) return null;
  let url = clean(s.url, 300);
  if (!/^https:\/\/app\.smartsheet\.(com|eu|au)\//.test(url)) url = ''; // only ever a Smartsheet link
  return { id, name: clean(s.name, 200) || id, url };
}
const validJobId = (v) => /^ss-\d{1,20}$/.test(String(v || ''));

app.http('jobLinks', {
  methods: ['GET', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'job-links/{jobId?}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      const container = getContainer(CONTAINER_ID);
      if (request.method === 'GET') {
        const { resources } = await container.items.query({
          query: 'SELECT c.jobId, c.sheet FROM c WHERE STARTSWITH(c.id, @p)',
          parameters: [{ name: '@p', value: ID_PREFIX }],
        }).fetchAll();
        const links = {};
        resources.forEach((r) => { if (r.jobId && r.sheet) links[r.jobId] = r.sheet; });
        // The project plan is the master for a job's Smartsheet / floor plans:
        // a job with nothing linked by hand falls back to the plan that shares
        // its PROJECT NAME (same case-insensitive match as the job popup's
        // "Project plan" button). Only the links are sent, not the plan body.
        // Newest plan wins when several share a name.
        const { resources: plans } = await container.items.query({
          query: 'SELECT c.id, c.project, c.sheet, c.maps, c.attachments, c.updatedAt FROM c WHERE STARTSWITH(c.id, @p) ORDER BY c.updatedAt DESC',
          parameters: [{ name: '@p', value: PLAN_PREFIX }],
        }).fetchAll();
        const planLinks = {};
        plans.forEach((p) => {
          const key = String(p.project || '').trim().toLowerCase();
          if (!key) return;
          const sheet = p.sheet && p.sheet.id ? { id: p.sheet.id, name: p.sheet.name || '', url: p.sheet.url || '' } : null;
          const maps = Array.isArray(p.maps) ? p.maps.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || '' })) : [];
          const files = Array.isArray(p.attachments) ? p.attachments.filter((a) => a && a.id).map((a) => ({ id: String(a.id), name: a.name || 'File', mimeType: a.mimeType || '' })) : [];
          const cur = planLinks[key] || (planLinks[key] = { planId: p.id, sheet: null, maps: [], attachments: [] });
          if (!cur.sheet && sheet) cur.sheet = sheet;
          if (!cur.maps.length && maps.length) cur.maps = maps;
          if (!cur.attachments.length && files.length) cur.attachments = files;
        });
        return { jsonBody: { links, planLinks } };
      }
      requireEditor(user); // changing shared job data -- editors only, like editing the job
      const jobId = String(request.params.jobId || '');
      if (!validJobId(jobId)) return { status: 400, jsonBody: { error: 'Bad job id' } };
      const docId = ID_PREFIX + jobId;
      if (request.method === 'DELETE') {
        try { await container.item(docId, docId).delete(); } catch (e) { if (e.code !== 404) throw e; }
        audit(context, user, 'dispatch.job.unlinkSheet', { jobId });
        return { jsonBody: { ok: true } };
      }
      const body = await request.json().catch(() => ({}));
      const sheet = sanitizeSheet(body && body.sheet);
      if (!sheet) return { status: 400, jsonBody: { error: 'Pick a Smartsheet to link' } };
      await container.items.upsert({
        id: docId, type: 'jobLink', jobId, sheet,
        updatedAt: new Date().toISOString(), updatedBy: user.upn || null,
      });
      audit(context, user, 'dispatch.job.linkSheet', { jobId, sheetId: sheet.id });
      return { jsonBody: { ok: true, sheet } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
