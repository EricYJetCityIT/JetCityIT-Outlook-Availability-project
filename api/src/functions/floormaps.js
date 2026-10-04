const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { requireUser, requireTester, authErrorResponse, AuthError } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const ss = require('../lib/smartsheet');

// Floor Maps tab (Testers group). A floor map = one rendered floor-plan image
// + a list of pins (normalized x/y + a label such as a desk number) + the job
// sheet the pins match against. Pins are matched to sheet rows BY LABEL at
// view time (the sheet's identifier column), so re-sorting or re-adding rows
// in Smartsheet never breaks a map. Photos and row data are NOT copied here --
// the client reads them live from the Testers-gated /api/jobsheet/sheet.
//
// Storage: the map doc lives in the shared `dispatch` Cosmos container,
// id-namespaced `floormap:<uuid>` (same pattern as `plan:`). The image is a
// sheet-level attachment on the linked Smartsheet (see addSheetAttachment),
// streamed back through GET /api/floormaps/{id}/image. Everything is
// Testers-only, read and write -- client floor plans are sensitive.
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'floormap:';
const MAX_PINS = 3000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_JOB_NAME = 160;
const MAX_FLOOR_LABEL = 60;

function floormapError(e, context) {
  if (e instanceof AuthError) return authErrorResponse(e, context);
  try { context.error(e); } catch (_) { /* logging must never break the response */ }
  return { status: 500, jsonBody: { error: String((e && e.message) || e || 'Unknown error') } };
}

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, max);
}

function unit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, Math.round(n * 1e5) / 1e5));
}

function sanitizePins(pins) {
  return (Array.isArray(pins) ? pins : [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const x = unit(p.x), y = unit(p.y);
      if (x === null || y === null) return null;
      return { x, y, label: clean(p.label, 40) };
    })
    .filter(Boolean)
    .slice(0, MAX_PINS);
}

function toDocId(raw) {
  const s = String(raw || '');
  if (!s) return '';
  return s.indexOf(ID_PREFIX) === 0 ? s : ID_PREFIX + s;
}

function summarize(m) {
  return {
    id: m.id,
    name: m.name || '',
    sheetId: m.sheetId || '',
    sheetName: m.sheetName || '',
    // Optional grouping: maps sharing a jobName (or, when blank, the same sheet)
    // are the floors of one job; floorLabel is that map's name within it.
    jobName: m.jobName || '',
    floorLabel: m.floorLabel || '',
    pinCount: Array.isArray(m.pins) ? m.pins.length : 0,
    updatedAt: m.updatedAt || null,
    updatedBy: m.updatedBy || null,
  };
}

async function readMap(container, docId) {
  try {
    const { resource } = await container.item(docId, docId).read();
    return resource || null;
  } catch (e) {
    if (e.code === 404) return null;
    throw e;
  }
}

// GET    /api/floormaps        -> { maps: [summary] }
// GET    /api/floormaps/{id}   -> { map }
// POST   /api/floormaps        -> multipart: meta (JSON: name, sheetId, sheetName,
//                                 imgW, imgH, pins, jobName?, floorLabel?) + image file -> { map }
// PUT    /api/floormaps/{id}   -> JSON { name?, jobName?, floorLabel?, pins? } -> { map }
// DELETE /api/floormaps/{id}   -> removes the doc + its sheet attachment
app.http('floormaps', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'floormaps/{id?}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const container = getContainer(CONTAINER_ID);
      const docId = toDocId(request.params.id);

      if (request.method === 'GET') {
        if (!docId) {
          const { resources } = await container.items.query({
            query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) ORDER BY c.updatedAt DESC',
            parameters: [{ name: '@p', value: ID_PREFIX }],
          }).fetchAll();
          return { jsonBody: { maps: resources.map(summarize) } };
        }
        const map = await readMap(container, docId);
        if (!map) return { status: 404, jsonBody: { error: 'Floor map not found' } };
        return { jsonBody: { map } };
      }

      if (request.method === 'POST') {
        let form;
        try { form = await request.formData(); } catch (_) { return { status: 400, jsonBody: { error: 'Expected a multipart upload' } }; }
        let meta;
        try { meta = JSON.parse(String(form.get('meta') || '{}')); } catch (_) { return { status: 400, jsonBody: { error: 'Bad meta JSON' } }; }
        const sheetId = clean(meta.sheetId, 40);
        if (!/^\d+$/.test(sheetId)) return { status: 400, jsonBody: { error: 'Pick a Smartsheet for this map' } };
        const file = form.get('image');
        if (!file || typeof file.arrayBuffer !== 'function') return { status: 400, jsonBody: { error: 'Missing floor plan image' } };
        if (!/^image\/(jpeg|png|webp)$/i.test(file.type || '')) return { status: 400, jsonBody: { error: 'Floor plan image must be JPEG, PNG or WebP' } };
        const bytes = Buffer.from(await file.arrayBuffer());
        if (!bytes.length) return { status: 400, jsonBody: { error: 'Empty image' } };
        if (bytes.length > MAX_IMAGE_BYTES) return { status: 400, jsonBody: { error: 'Floor plan image is too large (max 20 MB)' } };

        const name = clean(meta.name, 160) || clean(meta.sheetName, 160) || 'Floor map';
        const ext = /png/i.test(file.type) ? 'png' : (/webp/i.test(file.type) ? 'webp' : 'jpg');
        const att = await ss.addSheetAttachment(sheetId, `Floor map - ${name.replace(/[\\/:*?"<>|]+/g, ' ')}.${ext}`, file.type, bytes);
        if (!att || !att.id) throw new Error('Smartsheet did not return an attachment id');

        const now = new Date().toISOString();
        const map = {
          id: ID_PREFIX + randomUUID(),
          type: 'floorMap',
          name,
          sheetId,
          sheetName: clean(meta.sheetName, 200),
          jobName: clean(meta.jobName, MAX_JOB_NAME),
          floorLabel: clean(meta.floorLabel, MAX_FLOOR_LABEL),
          attachmentId: String(att.id),
          imgW: Math.max(0, parseInt(meta.imgW, 10) || 0),
          imgH: Math.max(0, parseInt(meta.imgH, 10) || 0),
          pins: sanitizePins(meta.pins),
          createdAt: now,
          createdBy: user.upn,
          updatedAt: now,
          updatedBy: user.upn,
        };
        const { resource } = await container.items.upsert(map);
        return { jsonBody: { map: resource || map } };
      }

      if (!docId) return { status: 400, jsonBody: { error: 'Missing floor map id' } };
      const existing = await readMap(container, docId);

      if (request.method === 'DELETE') {
        if (existing) {
          if (existing.sheetId && existing.attachmentId) {
            // Best effort: a missing/foreign attachment must not block removing the map.
            try { await ss.deleteSheetAttachment(existing.sheetId, existing.attachmentId); } catch (e) { try { context.warn(e); } catch (_) { /* ignore */ } }
          }
          try { await container.item(docId, docId).delete(); } catch (e) { if (e.code !== 404) throw e; }
        }
        return { jsonBody: { deleted: true, id: docId } };
      }

      // PUT: the name, job grouping and pins are editable; sheet + image are fixed at creation.
      // jobName / floorLabel may be cleared (empty string) to take a map out of a job.
      if (!existing) return { status: 404, jsonBody: { error: 'Floor map not found' } };
      const body = await request.json().catch(() => ({}));
      const next = {
        ...existing,
        name: body.name !== undefined ? (clean(body.name, 160) || existing.name) : existing.name,
        // Only an explicit string changes these (a stray null/number leaves them alone).
        jobName: typeof body.jobName === 'string' ? clean(body.jobName, MAX_JOB_NAME) : (existing.jobName || ''),
        floorLabel: typeof body.floorLabel === 'string' ? clean(body.floorLabel, MAX_FLOOR_LABEL) : (existing.floorLabel || ''),
        pins: body.pins !== undefined ? sanitizePins(body.pins) : existing.pins,
        updatedAt: new Date().toISOString(),
        updatedBy: user.upn,
      };
      const { resource } = await container.items.upsert(next);
      return { jsonBody: { map: resource || next } };
    } catch (e) {
      return floormapError(e, context);
    }
  },
});

// GET /api/floormaps/{id}/image — streams the map's floor-plan image from its
// Smartsheet attachment. Testers-only (the client fetches it with the auth
// header and hands the blob to the map as an object URL).
app.http('floormapImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'floormaps/{id}/image',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const docId = toDocId(request.params.id);
      const map = await readMap(getContainer(CONTAINER_ID), docId);
      if (!map || !map.attachmentId) return { status: 404, jsonBody: { error: 'Floor map not found' } };
      const { contentType, bytes } = await ss.fetchAttachmentBytes(map.sheetId, map.attachmentId);
      return { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' }, body: bytes };
    } catch (e) {
      return floormapError(e, context);
    }
  },
});
