const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { requireUser, requireEditor, AuthError, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { sendMail } = require('../lib/graph');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');

// Suggestions / feedback box (the header's "Feedback" button). Any signed-in user can
// send one; the submission is stored in Cosmos (the shared `dispatch` container, doc ids
// `feedback:<uuid>`, so it never collides with jobs/plans/etc.) and the team lead is
// emailed a copy. Editors can list the submissions and mark them done. The sender's name
// and email come from their sign-in token, never from the request body.
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'feedback:';
const CATEGORIES = ['suggestion', 'problem', 'other'];
const CATEGORY_LABEL = { suggestion: 'Suggestion', problem: 'Something is not working', other: 'Other' };
const MAX_MESSAGE = 2000;
const MAX_PAGE = 40;
const SEND_LIMIT = 10;                     // per person per hour (in memory; fails open)
const SEND_WINDOW_MS = 60 * 60 * 1000;
const LIST_LIMIT = 200;   // newest unresolved items returned
const DONE_LIMIT = 100;   // newest finished items returned
// Who gets the email copy. Same mailbox the availability reminder already sends from.
const SENDER = 'Ericy@jetcityit.com';
const NOTIFY_TO = () => process.env.FEEDBACK_NOTIFY_TO || SENDER;

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Keeps line breaks and tabs, drops other control characters, trims, length-limits.
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, max);
}
const oneLine = (s, max) => cleanText(s, max).replace(/\s+/g, ' ');

function feedbackError(e, context) {
  if (e instanceof AuthError) return authErrorResponse(e, context);
  try { context.error(e); } catch (_) { /* logging must never break the response */ }
  return { status: 500, jsonBody: { error: 'Something went wrong. Please try again.' } };
}

function publicItem(d) {
  return { id: d.id, category: d.category, message: d.message, page: d.page || '', user: d.user || '', userName: d.userName || '', createdAt: d.createdAt, status: d.status || 'new' };
}

async function notify(doc, context) {
  try {
    const subject = oneLine(`Site feedback (${CATEGORY_LABEL[doc.category]}) from ${doc.userName || doc.user}`, 150);
    const html = `<p><b>${escHtml(CATEGORY_LABEL[doc.category])}</b> from ${escHtml(doc.userName || doc.user)} (${escHtml(doc.user)})` +
      `${doc.page ? ` while on <i>${escHtml(doc.page)}</i>` : ''}:</p>` +
      `<blockquote style="margin:8px 0;padding:8px 14px;border-left:3px solid #16A37F;white-space:pre-wrap">${escHtml(doc.message)}</blockquote>` +
      `<p style="color:#666">Sent from the Team Availability site's Feedback button. Editors can see and mark these done in the same box.</p>`;
    // Don't make the sender wait on a slow mail service: the copy is already saved.
    await Promise.race([
      sendMail({ from: SENDER, to: NOTIFY_TO(), subject, html }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mail timed out')), 8000)),
    ]);
  } catch (e) {
    // The submission is already saved; a mail failure must not make the sender think it was lost.
    try { context.error('feedback notification failed', e); } catch (_) { /* ignore */ }
  }
}

// POST   /api/feedback        { category, message, page? }  -> any signed-in user
// GET    /api/feedback        -> { items } newest first (editors only)
// PUT    /api/feedback/{id}   { status: 'new'|'done' }      -> editors only
// DELETE /api/feedback/{id}   -> editors only; removes the item for good (the emailed copy is separate)
app.http('feedback', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'feedback/{id?}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      const container = getContainer(CONTAINER_ID);

      if (request.method === 'POST') {
        const rl = checkRateLimit('feedback:' + user.upn, SEND_LIMIT, SEND_WINDOW_MS);
        if (!rl.allowed) return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'You have sent a lot of feedback in the last hour. Please try again later.' } };
        const body = await request.json().catch(() => null);
        if (!body || typeof body.message !== 'string') return { status: 400, jsonBody: { error: 'Please write a message.' } };
        const message = cleanText(body.message, MAX_MESSAGE);
        if (!message) return { status: 400, jsonBody: { error: 'Please write a message.' } };
        const category = CATEGORIES.includes(body.category) ? body.category : 'other';
        const doc = {
          id: ID_PREFIX + randomUUID(),
          type: 'feedback',
          category,
          message,
          page: oneLine(body.page, MAX_PAGE),
          user: oneLine(user.upn, 200),
          userName: oneLine(user.name, 200),
          status: 'new',
          createdAt: new Date().toISOString(),
        };
        await container.items.create(doc);
        audit(context, user, 'feedback.sent', { category });
        await notify(doc, context);
        return { status: 201, jsonBody: { ok: true } };
      }

      requireEditor(user); // reading or triaging everyone's feedback is editor-only

      if (request.method === 'GET') {
        // Unresolved items always come back (newest LIST_LIMIT of them) plus the newest few
        // finished ones, so a long backlog never hides something still waiting for action.
        const fetchByStatus = async (isDone, n) => {
          const cond = isDone ? "c.status = 'done'" : "(NOT IS_DEFINED(c.status) OR c.status != 'done')";
          const { resources } = await container.items
            .query({
              query: `SELECT TOP ${n} c.id, c.category, c.message, c.page, c.user, c.userName, c.createdAt, c.status FROM c WHERE STARTSWITH(c.id, @p) AND ${cond} ORDER BY c.createdAt DESC`,
              parameters: [{ name: '@p', value: ID_PREFIX }],
            })
            .fetchAll();
          return resources;
        };
        const [open, done] = await Promise.all([fetchByStatus(false, LIST_LIMIT), fetchByStatus(true, DONE_LIMIT)]);
        const items = open.concat(done).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return { jsonBody: { items: items.map(publicItem) } };
      }

      const id = String(request.params.id || '');
      if (id.indexOf(ID_PREFIX) !== 0) return { status: 400, jsonBody: { error: 'Missing feedback id' } };

      if (request.method === 'DELETE') {
        let found;
        try {
          ({ resource: found } = await container.item(id, id).read());
        } catch (e) {
          if (e && e.code === 404) found = null; else throw e;
        }
        if (!found || found.type !== 'feedback') return { status: 404, jsonBody: { error: 'Not found' } }; // never deletes anything that isn't a feedback item
        try {
          await container.item(id, id).delete();
        } catch (e) {
          if (!(e && e.code === 404)) throw e; // already gone (e.g. two editors deleting at once) is fine
        }
        audit(context, user, 'feedback.delete', { id }); // resource id only, never the message or sender
        return { jsonBody: { ok: true } };
      }

      // PUT: mark done / reopen
      const body = await request.json().catch(() => null);
      if (!body || (body.status !== 'new' && body.status !== 'done')) return { status: 400, jsonBody: { error: "status must be 'new' or 'done'" } };
      let cur;
      try {
        ({ resource: cur } = await container.item(id, id).read());
      } catch (e) {
        if (e && e.code === 404) cur = null; else throw e;
      }
      if (!cur || cur.type !== 'feedback') return { status: 404, jsonBody: { error: 'Not found' } };
      const next = { ...cur, status: body.status, updatedAt: new Date().toISOString(), updatedBy: oneLine(user.upn, 200) };
      await container.item(id, id).replace(next);
      audit(context, user, 'feedback.status', { id, status: body.status });
      return { jsonBody: { ok: true, item: publicItem(next) } };
    } catch (e) {
      return feedbackError(e, context);
    }
  },
});
