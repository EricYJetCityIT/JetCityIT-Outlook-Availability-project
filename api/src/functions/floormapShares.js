const { app } = require('@azure/functions');
const { randomBytes, randomUUID } = require('crypto');
const { requireUser, requireTester, authErrorResponse, AuthError } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const ss = require('../lib/smartsheet');

// Client share links for Floor Maps.
//
// A Tester (TESTER_UPNS) creates a link for ONE map with a level:
//   view    -> plan, pins, status, photos
//   comment -> + leave notes on a desk
//   approve -> + mark a desk approved / needs work (a walkthrough sign-off)
//   edit    -> + add or replace a desk's photos
// Anyone holding the link can open it WITHOUT signing in, until it expires or
// is revoked. The link carries a random 192-bit token in the URL fragment
// (share.html#t=...), so it never reaches server logs or Referer headers; the
// page sends it back in the X-Share-Token header.
//
// What a client can see is built server-side from the live job sheet and
// filtered: identifier, photo and checkbox columns, plus text columns only if
// the link allows notes. Never the activity log, tech names, labor time,
// Smartsheet ids, or other links' feedback.
//
// Docs live in the shared `dispatch` container:
//   fmshare:<token>  one link (label, level, expiry, revoked, open count)
//   fmfb:<uuid>      one piece of client feedback (comment / approval)
const CONTAINER_ID = 'dispatch';
const SHARE_PREFIX = 'fmshare:';
const FEEDBACK_PREFIX = 'fmfb:';
const MAP_PREFIX = 'floormap:';
const LEVELS = ['view', 'comment', 'approve', 'edit'];
const MAX_DAYS = 365;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ').trim().slice(0, max);
}
function mapDocId(raw) {
  const s = String(raw || '');
  return s.indexOf(MAP_PREFIX) === 0 ? s : MAP_PREFIX + s;
}
function levelAtLeast(level, min) { return LEVELS.indexOf(level) >= LEVELS.indexOf(min); }
function shareStatus(sh) {
  if (sh.revokedAt) return 'revoked';
  if (sh.expiresAt && Date.parse(sh.expiresAt) < Date.now()) return 'expired';
  return 'active';
}
async function readDoc(container, id) {
  try { const { resource } = await container.item(id, id).read(); return resource || null; }
  catch (e) { if (e.code === 404) return null; throw e; }
}
function testerError(e, context) {
  if (e instanceof AuthError) return authErrorResponse(e, context);
  try { context.error(e); } catch (_) { /* ignore */ }
  return { status: 500, jsonBody: { error: String((e && e.message) || e || 'Unknown error') } };
}
// Public routes never echo internal error text (Smartsheet/Cosmos messages).
function publicError(e, context) {
  if (e && e.publicStatus) return { status: e.publicStatus, jsonBody: { error: e.message } };
  try { context.error(e); } catch (_) { /* ignore */ }
  return { status: 500, jsonBody: { error: 'Something went wrong loading this map. Please try again.' } };
}
function publicFail(status, message) { const e = new Error(message); e.publicStatus = status; return e; }

// Shape a link for the Testers' management list.
function shareSummary(sh) {
  return {
    token: sh.token, label: sh.label, level: sh.level, showNotes: !!sh.showNotes,
    expiresAt: sh.expiresAt, createdAt: sh.createdAt, createdBy: sh.createdBy,
    revokedAt: sh.revokedAt || null, openCount: sh.openCount || 0, lastOpenedAt: sh.lastOpenedAt || null,
    status: shareStatus(sh),
  };
}
function feedbackOut(f, withShare) {
  const o = { id: f.id, kind: f.kind, label: f.label, status: f.status || null, text: f.text || '', author: f.author || '', createdAt: f.createdAt };
  if (withShare) { o.shareLabel = f.shareLabel || ''; o.shareToken = f.shareToken || ''; }
  return o;
}

// ── Testers: manage a map's links + read its client feedback ───────────────

// GET  /api/floormaps/{id}/shares -> { shares, feedback }
// POST /api/floormaps/{id}/shares  JSON { label, level, days, showNotes } -> { share }
app.http('floormapShares', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'floormaps/{id}/shares',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const container = getContainer(CONTAINER_ID);
      const mapId = mapDocId(request.params.id);
      const map = await readDoc(container, mapId);
      if (!map) return { status: 404, jsonBody: { error: 'Floor map not found' } };

      if (request.method === 'GET') {
        const [shares, feedback] = await Promise.all([
          container.items.query({
            query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND c.mapId = @m ORDER BY c.createdAt DESC',
            parameters: [{ name: '@p', value: SHARE_PREFIX }, { name: '@m', value: mapId }],
          }).fetchAll(),
          container.items.query({
            query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND c.mapId = @m ORDER BY c.createdAt DESC',
            parameters: [{ name: '@p', value: FEEDBACK_PREFIX }, { name: '@m', value: mapId }],
          }).fetchAll(),
        ]);
        return { jsonBody: { shares: shares.resources.map(shareSummary), feedback: feedback.resources.map((f) => feedbackOut(f, true)) } };
      }

      const body = await request.json().catch(() => ({}));
      const label = clean(body.label, 120);
      if (!label) return { status: 400, jsonBody: { error: 'Give the link a name (e.g. the client or person it is for)' } };
      const level = LEVELS.includes(body.level) ? body.level : 'view';
      const days = Math.min(MAX_DAYS, Math.max(1, parseInt(body.days, 10) || 30));
      const token = randomBytes(24).toString('base64url');
      const now = new Date();
      const share = {
        id: SHARE_PREFIX + token, type: 'floorMapShare', token, mapId, label, level,
        showNotes: !!body.showNotes,
        expiresAt: new Date(now.getTime() + days * 86400000).toISOString(),
        createdAt: now.toISOString(), createdBy: user.upn, openCount: 0,
      };
      await container.items.upsert(share);
      audit(context, user, 'floormap.share.create', { mapId, level, days });
      return { jsonBody: { share: shareSummary(share) } };
    } catch (e) {
      return testerError(e, context);
    }
  },
});

// DELETE /api/floormaps/{id}/shares/{token} -> revoke (kept for the record, stops working at once)
app.http('floormapShareRevoke', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'floormaps/{id}/shares/{token}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireTester(user);
      const container = getContainer(CONTAINER_ID);
      const token = String(request.params.token || '');
      if (!TOKEN_RE.test(token)) return { status: 400, jsonBody: { error: 'Bad link id' } };
      const sh = await readDoc(container, SHARE_PREFIX + token);
      if (!sh || sh.mapId !== mapDocId(request.params.id)) return { status: 404, jsonBody: { error: 'Link not found' } };
      if (!sh.revokedAt) {
        sh.revokedAt = new Date().toISOString(); sh.revokedBy = user.upn;
        await container.items.upsert(sh);
        audit(context, user, 'floormap.share.revoke', { mapId: sh.mapId });
      }
      return { jsonBody: { share: shareSummary(sh) } };
    } catch (e) {
      return testerError(e, context);
    }
  },
});

// ── Public: the client's view (no sign-in; the link token is the key) ──────

// Validates the X-Share-Token header + rate limits. Returns { container, share, map }.
async function openShare(request) {
  const ip = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const ipRl = checkRateLimit('share-ip:' + ip, 90);
  if (!ipRl.allowed) throw publicFail(429, 'Too many requests. Please wait a minute and try again.');
  const token = String(request.headers.get('x-share-token') || '');
  if (!TOKEN_RE.test(token)) throw publicFail(404, 'This link is not valid.');
  const tokRl = checkRateLimit('share-tok:' + token, 120);
  if (!tokRl.allowed) throw publicFail(429, 'Too many requests. Please wait a minute and try again.');
  const container = getContainer(CONTAINER_ID);
  const share = await readDoc(container, SHARE_PREFIX + token);
  if (!share) throw publicFail(404, 'This link is not valid.');
  const st = shareStatus(share);
  if (st === 'revoked') throw publicFail(410, 'This link has been turned off. Ask Jet City IT for a new one.');
  if (st === 'expired') throw publicFail(410, 'This link has expired. Ask Jet City IT for a new one.');
  const map = await readDoc(container, share.mapId);
  if (!map) throw publicFail(404, 'This floor map no longer exists.');
  return { container, share, map, actor: { upn: 'share:' + share.label } };
}

// Client-safe copy of the job sheet: no row ids, no internal text unless allowed.
function clientSheet(view, share) {
  const cols = (view.columns || []).filter((c) => c.type !== 'text' || share.showNotes);
  const keys = new Set(cols.map((c) => c.key));
  const rows = (view.rows || []).map((r) => {
    const o = {};
    Object.keys(r).forEach((k) => { if (keys.has(k)) o[k] = r[k]; });
    return o;
  });
  return { name: view.name || '', columns: cols, progressKey: keys.has(view.progressKey) ? view.progressKey : null, rows };
}

async function shareFeedback(container, share) {
  const { resources } = await container.items.query({
    query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND c.mapId = @m AND c.shareToken = @t ORDER BY c.createdAt ASC',
    parameters: [{ name: '@p', value: FEEDBACK_PREFIX }, { name: '@m', value: share.mapId }, { name: '@t', value: share.token }],
  }).fetchAll();
  return resources.map((f) => feedbackOut(f, false));
}

// GET /api/share -> everything the client page needs
app.http('floormapShareView', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'share',
  handler: async (request, context) => {
    try {
      const { container, share, map, actor } = await openShare(request);
      const [view, feedback] = await Promise.all([ss.fetchJobSheetView(map.sheetId), shareFeedback(container, share)]);
      // Best-effort open counter (never blocks the response on a write conflict).
      share.openCount = (share.openCount || 0) + 1; share.lastOpenedAt = new Date().toISOString();
      container.items.upsert(share).catch(() => {});
      audit(context, actor, 'floormap.share.open', { mapId: share.mapId });
      return {
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: {
          share: { label: share.label, level: share.level, showNotes: !!share.showNotes, expiresAt: share.expiresAt },
          map: { name: map.name || '', floorLabel: map.floorLabel || '', imgW: map.imgW, imgH: map.imgH, pins: (map.pins || []).map((p) => ({ x: p.x, y: p.y, label: p.label })) },
          sheet: clientSheet(view, share),
          feedback,
        },
      };
    } catch (e) {
      return publicError(e, context);
    }
  },
});

// GET /api/share/image -> the floor plan image
app.http('floormapShareImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'share/image',
  handler: async (request, context) => {
    try {
      const { map } = await openShare(request);
      if (!map.attachmentId) throw publicFail(404, 'This floor map has no plan image.');
      const { contentType, bytes } = await ss.fetchAttachmentBytes(map.sheetId, map.attachmentId);
      return { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' }, body: bytes };
    } catch (e) {
      return publicError(e, context);
    }
  },
});

// POST /api/share/feedback  JSON { kind: 'comment'|'approval', label, text, status, author }
app.http('floormapShareFeedback', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'share/feedback',
  handler: async (request, context) => {
    try {
      const { container, share, map, actor } = await openShare(request);
      const body = await request.json().catch(() => ({}));
      const kind = body.kind === 'approval' ? 'approval' : 'comment';
      if (!levelAtLeast(share.level, kind === 'approval' ? 'approve' : 'comment')) throw publicFail(403, 'This link can\'t do that.');
      const label = clean(body.label, 40);
      if (!label || !(map.pins || []).some((p) => clean(p.label, 40) === label)) throw publicFail(400, 'Unknown desk.');
      const text = clean(body.text, 2000);
      const status = kind === 'approval' ? (body.status === 'rejected' ? 'rejected' : 'approved') : null;
      if (kind === 'comment' && !text) throw publicFail(400, 'Write a comment first.');
      const author = clean(body.author, 60) || share.label;
      const doc = {
        id: FEEDBACK_PREFIX + randomUUID(), type: 'floorMapFeedback', mapId: share.mapId,
        shareToken: share.token, shareLabel: share.label, kind, label, status, text, author,
        createdAt: new Date().toISOString(),
      };
      await container.items.upsert(doc);
      audit(context, actor, 'floormap.share.' + kind, { mapId: share.mapId, status });
      return { jsonBody: { feedback: feedbackOut(doc, false) } };
    } catch (e) {
      return publicError(e, context);
    }
  },
});

// POST /api/share/photo  multipart: label, columnKey (a photo column's key), file  (edit links only)
app.http('floormapSharePhoto', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'share/photo',
  handler: async (request, context) => {
    try {
      const { share, map, actor } = await openShare(request);
      if (!levelAtLeast(share.level, 'edit')) throw publicFail(403, 'This link can\'t add photos.');
      let form;
      try { form = await request.formData(); } catch (_) { throw publicFail(400, 'Expected a photo upload.'); }
      const label = clean(form.get('label'), 40);
      const columnKey = clean(form.get('columnKey'), 40);
      let file = null;
      for (const v of form.values()) { if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') { file = v; break; } }
      if (!file) throw publicFail(400, 'No photo was uploaded.');
      if (!/^image\//i.test(file.type || '')) throw publicFail(400, 'Only image files are allowed.');
      const bytes = Buffer.from(await file.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw publicFail(400, 'Photo is empty or too large (max 15 MB).');
      // Resolve the desk's row + photo column server-side; the client never sees row ids.
      const view = await ss.fetchJobSheetView(map.sheetId);
      const col = (view.columns || []).find((c) => c.key === columnKey && c.type === 'photo');
      if (!col) throw publicFail(400, 'Unknown photo column.');
      const idCol = (view.columns || []).find((c) => c.type === 'identifier');
      const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^0+(?=\d)/, '');
      if (!label || !(map.pins || []).some((p) => clean(p.label, 40) === label)) throw publicFail(400, 'Unknown desk.');
      const row = idCol && (view.rows || []).find((r) => norm(r[idCol.key]) === norm(label));
      if (!row) throw publicFail(400, 'That desk has no row in the job sheet.');
      await ss.addCellImage(map.sheetId, row._rowId, col.key.replace(/^c/, ''), file.name || 'photo.jpg', file.type || 'image/jpeg', bytes);
      audit(context, actor, 'floormap.share.photo', { mapId: share.mapId });
      return { jsonBody: { ok: true } };
    } catch (e) {
      return publicError(e, context);
    }
  },
});
