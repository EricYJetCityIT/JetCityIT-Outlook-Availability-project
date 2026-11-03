const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { requireUser, requireEditor, AuthError, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { sendMail } = require('../lib/graph');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');
const { safeEqual } = require('../lib/secure');

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
const MAX_NOTE = 500;     // the optional note sent back when an item is marked done
const DONE_TO_RE = /^[a-z0-9][a-z0-9._%+'-]{0,63}@jetcityit\.com$/i;
const DIGEST_LIST = 25;   // items listed in the weekly digest (the rest are counted)
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
  return { id: d.id, category: d.category, message: d.message, page: d.page || '', user: d.user || '', userName: d.userName || '', createdAt: d.createdAt, status: d.status || 'new', doneNote: d.doneNote || '', notified: !!d.notifiedAt };
}

// Tells the person who sent a piece of feedback that it has been dealt with: 'sent', 'failed' (the mail service
// refused it), or 'unsure' (no answer in time, so it may still be delivered: never retried automatically).
async function notifyDone(doc, note, actor, context) {
  try {
    const subject = oneLine('Your feedback on the Team Availability site is done', 150);
    const html = `<p>Hi ${escHtml((doc.userName || '').split(' ')[0] || 'there')},</p>` +
      `<p>Thanks for your feedback. ${escHtml(actor.name || 'The team')} marked it as done.</p>` +
      (note ? `<p><b>Note:</b></p><blockquote style="margin:8px 0;padding:8px 14px;border-left:3px solid #16A37F;white-space:pre-wrap">${escHtml(note)}</blockquote>` : '') +
      `<p style="color:#666;margin-top:16px">What you sent:</p>` +
      `<blockquote style="margin:8px 0;padding:8px 14px;border-left:3px solid #ccc;color:#555;white-space:pre-wrap">${escHtml(String(doc.message).slice(0, 600))}</blockquote>` +
      `<p style="color:#666">If something still isn't right, just reply to this email.</p>`;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('unsure'), 8000); });
    const res = await Promise.race([sendMail({ from: SENDER, to: doc.user, subject, html }).then(() => 'sent'), timeout]);
    clearTimeout(timer);
    return res;
  } catch (e) {
    try { context.error('feedback done-notification failed', e); } catch (_) { /* ignore */ }
    return 'failed';
  }
}

async function notify(doc, context) {
  try {
    const subject = oneLine(`Site feedback (${CATEGORY_LABEL[doc.category]}) from ${doc.userName || doc.user}`, 150);
    const html = `<p><b>${escHtml(CATEGORY_LABEL[doc.category])}</b> from ${escHtml(doc.userName || doc.user)} (${escHtml(doc.user)})` +
      `${doc.page ? ` while on <i>${escHtml(doc.page)}</i>` : ''}:</p>` +
      `<blockquote style="margin:8px 0;padding:8px 14px;border-left:3px solid #16A37F;white-space:pre-wrap">${escHtml(doc.message)}</blockquote>` +
      `<p style="color:#666">Sent from the Team Availability site's Feedback button. To read, mark done or delete submissions, open Manager view, then the Feedback tab.</p>`;
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
// GET    /api/feedback?summary=1 -> { open } how many are not done yet (editors only)
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

      if (request.method === 'GET' && request.query.get('summary')) {
        // Just the number of unresolved items, for the "new" badge on the Manager view (cheap, no message text).
        const { resources } = await container.items
          .query({
            query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p) AND (NOT IS_DEFINED(c.status) OR c.status != 'done')",
            parameters: [{ name: '@p', value: ID_PREFIX }],
          })
          .fetchAll();
        return { jsonBody: { open: Number(resources[0]) || 0 } };
      }

      if (request.method === 'GET') {
        // Unresolved items always come back (newest LIST_LIMIT of them) plus the newest few
        // finished ones, so a long backlog never hides something still waiting for action.
        const fetchByStatus = async (isDone, n) => {
          const cond = isDone ? "c.status = 'done'" : "(NOT IS_DEFINED(c.status) OR c.status != 'done')";
          const { resources } = await container.items
            .query({
              query: `SELECT TOP ${n} c.id, c.category, c.message, c.page, c.user, c.userName, c.createdAt, c.status, c.doneNote, c.notifiedAt FROM c WHERE STARTSWITH(c.id, @p) AND ${cond} ORDER BY c.createdAt DESC`,
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

      // PUT: mark done / reopen. Marking done may carry a short note and ask to email the sender.
      const body = await request.json().catch(() => null);
      if (!body || (body.status !== 'new' && body.status !== 'done')) return { status: 400, jsonBody: { error: "status must be 'new' or 'done'" } };
      let cur;
      try {
        ({ resource: cur } = await container.item(id, id).read());
      } catch (e) {
        if (e && e.code === 404) cur = null; else throw e;
      }
      if (!cur || cur.type !== 'feedback') return { status: 404, jsonBody: { error: 'Not found' } };
      const closing = body.status === 'done' && cur.status !== 'done';
      // Someone else already closed it: don't silently drop this editor's note / email request.
      if (body.status === 'done' && !closing && (body.notify === true || (typeof body.note === 'string' && body.note.trim()))) {
        return { status: 409, jsonBody: { error: 'Someone else already marked this done, so your note was not sent. Refresh to see it.' } };
      }
      const next = { ...cur, status: body.status, updatedAt: new Date().toISOString(), updatedBy: oneLine(user.upn, 200) };
      let toNotify = false;
      if (closing) {
        const note = typeof body.note === 'string' ? cleanText(body.note, MAX_NOTE) : '';
        if (note) next.doneNote = note; else delete next.doneNote; // never carry an older closure's note forward
        // One email per item, never to yourself, and only to a real company address.
        toNotify = body.notify === true && !cur.notifiedAt && DONE_TO_RE.test(String(cur.user || '')) && String(cur.user).toLowerCase() !== user.upn;
        // Claim the send in the same write that closes the item, BEFORE mailing: a slow or crashed send, a retry or a
        // second editor can then never mail the sender twice. Cleared again below only if the mail definitely failed.
        if (toNotify) next.notifiedAt = new Date().toISOString();
      }
      try {
        // IfMatch: two editors marking the same item done at once must not both send the email.
        await container.item(id, id).replace(next, cur._etag ? { accessCondition: { type: 'IfMatch', condition: cur._etag } } : undefined);
      } catch (e) {
        if (e && (e.code === 412 || e.code === 409)) return { status: 409, jsonBody: { error: 'Someone else just changed this item. Refresh and try again.' } };
        throw e;
      }
      audit(context, user, 'feedback.status', { id, status: body.status, notify: toNotify });
      let notified = 'no';
      if (toNotify) {
        notified = await notifyDone(cur, next.doneNote, user, context);
        if (notified === 'failed') {
          delete next.notifiedAt;
          try { await container.item(id, id).patch([{ op: 'remove', path: '/notifiedAt' }]); }
          catch (e) { try { context.error('feedback notifiedAt release failed', e); } catch (_) { /* ignore */ } }
        }
      }
      return { jsonBody: { ok: true, notified, item: publicItem(next) } };
    } catch (e) {
      return feedbackError(e, context);
    }
  },
});

// Weekly digest of feedback nobody has dealt with yet, emailed to the team lead (FEEDBACK_DIGEST_TO, else the
// same address as the instant copies). Like the other scheduled jobs it is a plain HTTP endpoint called by a
// GitHub Actions cron (.github/workflows/feedback-digest-schedule.yml) and guarded by the shared SYNC_SECRET.
// Nothing open => nothing sent. The response is counts only (the Actions log is public).
app.http('feedbackDigest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'feedback-digest',
  handler: async (request, context) => {
    const expected = process.env.SYNC_SECRET;
    const provided = request.headers.get('x-sync-secret') || '';
    if (!expected || !safeEqual(provided, expected)) return { status: 401, jsonBody: { error: 'Invalid or missing sync secret' } };
    try {
      const container = getContainer(CONTAINER_ID);
      const q = (query, extra) => container.items.query({ query, parameters: [{ name: '@p', value: ID_PREFIX }].concat(extra || []) }).fetchAll().then((r) => r.resources);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const open = "(NOT IS_DEFINED(c.status) OR c.status != 'done')";
      const [count, freshCount, items] = await Promise.all([
        q(`SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p) AND ${open}`),
        q(`SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @p) AND ${open} AND c.createdAt >= @since`, [{ name: '@since', value: weekAgo }]),
        q(`SELECT TOP ${DIGEST_LIST} c.category, c.message, c.user, c.userName, c.createdAt FROM c WHERE STARTSWITH(c.id, @p) AND ${open} ORDER BY c.createdAt DESC`),
      ]);
      const total = Number(count[0]) || 0;
      if (!total) return { jsonBody: { open: 0, sent: false } };
      const fresh = Number(freshCount[0]) || 0;
      const rows = items.map((d) => {
        const msg = oneLine(d.message, 280);
        return `<li style="margin:0 0 10px"><b>${escHtml(CATEGORY_LABEL[d.category] || 'Other')}</b> from ${escHtml(d.userName || d.user)}` +
          ` <span style="color:#888">(${escHtml(String(d.createdAt || '').slice(0, 10))})</span><br>${escHtml(msg)}${d.message.length > msg.length ? '…' : ''}</li>`;
      }).join('');
      const html = `<p><b>${total}</b> piece${total === 1 ? '' : 's'} of site feedback ${total === 1 ? 'is' : 'are'} still open` +
        `${fresh ? `, ${fresh} new in the last 7 days` : ''}.</p><ul style="padding-left:18px">${rows}</ul>` +
        `${total > items.length ? `<p style="color:#666">…and ${total - items.length} older.</p>` : ''}` +
        `<p style="color:#666">Open Manager view, then the Feedback tab to mark items done (you can let the sender know at the same time).</p>`;
      await sendMail({ from: SENDER, to: process.env.FEEDBACK_DIGEST_TO || NOTIFY_TO(), subject: `Site feedback: ${total} open`, html });
      context.log(`Feedback digest sent: ${total} open.`);
      return { jsonBody: { open: total, sent: true } };
    } catch (e) {
      context.error('Feedback digest failed:', e);
      return { status: 500, jsonBody: { error: 'Digest failed' } };
    }
  },
});
