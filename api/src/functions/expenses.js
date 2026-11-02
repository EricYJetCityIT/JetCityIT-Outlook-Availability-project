const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { requireUser, requireCardholderOrFinance, AuthError, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { sendMail } = require('../lib/graph');
const { checkRateLimit } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');

// Company-card expenses (the Expenses tab). Cardholders (CARDHOLDER_UPNS) either
// ask before buying ("request") or submit a receipt after buying ("purchase");
// the Financial group (FINANCE_UPNS) approves. Nobody approves their own unless
// they're the only Financial-group member (then it's recorded as self-approved).
//
// Everything stays in Azure: expense docs `exp:<uuid>` and receipt images
// `expimg:<uuid>` (same uuid; the photo is shrunk to a JPEG in the browser
// first, so it fits a Cosmos item) in the shared `dispatch` container. No card
// numbers are stored. Receipt photos can be read by Azure AI Document
// Intelligence (prebuilt receipt model) when DOCINTEL_ENDPOINT + DOCINTEL_KEY
// are set; without them, the amounts are typed in by hand.
//
// Status flow:
//   request:  requested -> req-approved | req-denied ; req-approved + receipt -> submitted
//   purchase: submitted -> approved | rejected | needs-info (owner edits -> submitted)
//   approved -> reconciled (the bookkeeper has it) -> back to approved if undone
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'exp:';
const IMG_PREFIX = 'expimg:';
const CATEGORIES = ['materials', 'parking', 'fuel', 'meals', 'tools', 'travel', 'office', 'other'];
const MAX_RECEIPT_BYTES = 1200 * 1024; // base64 of this stays well under Cosmos' 2 MB item cap
const READ_LIMIT = 40;                 // receipt reads per person per hour
const READ_WINDOW_MS = 60 * 60 * 1000;
const APP_URL = 'https://crew-calendar.jetcityit.com/';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, max) => String(s == null ? '' : s).replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const money = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : null; };
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const fmtMoney = (v) => (v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const financeUpns = () => (process.env.FINANCE_UPNS || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => /@/.test(x));

function publicItem(d) {
  return {
    id: d.id.slice(ID_PREFIX.length), kind: d.kind, status: d.status, owner: d.owner, ownerName: d.ownerName || d.owner,
    description: d.description || '', vendor: d.vendor || '', category: d.category || 'other',
    estimate: d.estimate != null ? d.estimate : null, amount: d.amount != null ? d.amount : null, tax: d.tax != null ? d.tax : null,
    date: d.date || '', jobId: d.jobId || '', jobName: d.jobName || '', client: d.client || '', note: d.note || '',
    hasReceipt: !!d.hasReceipt, receiptRead: d.receiptRead || null, history: d.history || [],
    createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

// Fields a cardholder fills in. `purchase` = the receipt side (actual amount + date required).
function readFields(body, purchase) {
  const f = {
    description: clean(body.description, 300), vendor: clean(body.vendor, 120),
    category: CATEGORIES.includes(body.category) ? body.category : 'other',
    jobId: clean(body.jobId, 80), jobName: clean(body.jobName, 200), client: clean(body.client, 120),
    note: clean(body.note, 1000),
  };
  if (purchase) {
    f.amount = money(body.amount); f.tax = money(body.tax); f.date = isoDate(body.date);
    if (f.amount == null || !f.amount) return { error: 'Enter the receipt total.' };
    if (!f.date) return { error: 'Enter the purchase date.' };
    if (!f.vendor) return { error: 'Enter where it was bought.' };
  } else {
    f.estimate = money(body.estimate);
    if (!f.description) return { error: 'Say what you want to buy.' };
    if (f.estimate == null || !f.estimate) return { error: 'Enter about how much it will cost.' };
  }
  return { fields: f };
}

// The browser sends the receipt as a base64 JPEG (already shrunk). Returns the
// cleaned base64 string, or throws a 400.
function readReceipt(b64) {
  const s = String(b64 || '').replace(/^data:image\/jpeg;base64,/, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) throw new AuthError(400, 'The receipt image could not be read.');
  const bytes = Buffer.from(s, 'base64');
  if (bytes.length < 100 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new AuthError(400, 'The receipt must be a photo (JPEG).');
  if (bytes.length > MAX_RECEIPT_BYTES) throw new AuthError(400, 'The receipt photo is too large.');
  return bytes.toString('base64');
}
function readReceiptRead(r) {
  if (!r || typeof r !== 'object') return null;
  return { vendor: clean(r.vendor, 120), total: money(r.total), tax: money(r.tax), date: isoDate(r.date) };
}

function historyEntry(user, action, note) {
  return { at: new Date().toISOString(), by: user.upn, byName: clean(user.name, 120), action, note: clean(note, 500) };
}

// Mail goes FROM each recipient's own mailbox TO themselves with no Sent Items
// copy (same as the Financial summary), unless EXPENSE_MAIL_FROM names a shared
// sender. A failure never fails the request -- the expense is already saved.
// Paused unless the FINANCE_EMAILS_ON app setting is "1" (same switch as the
// Financial summary email) -- the approval flow works the same without it.
async function notify(context, recipients, subject, html) {
  if (process.env.FINANCE_EMAILS_ON !== '1') return;
  const from = process.env.EXPENSE_MAIL_FROM || process.env.FINANCE_MAIL_FROM || '';
  const wrapped = '<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f1724;max-width:620px">' + html +
    `<p style="color:#6b7280;font-size:12.5px;margin-top:14px">Open the <a href="${APP_URL}">Expenses tab</a> to review.</p></div>`;
  await Promise.allSettled([...new Set(recipients)].map((to) => Promise.race([
    sendMail({ from: from || to, to, subject, html: wrapped, saveToSentItems: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('mail timed out')), 8000)),
  ]).catch((e) => { try { context.error('expense notification failed', e); } catch (_) { /* ignore */ } })));
}
function summaryLine(d) {
  const amt = d.amount != null ? fmtMoney(d.amount) : (d.estimate != null ? '≈ ' + fmtMoney(d.estimate) : '');
  return `<b>${escHtml(d.description || d.vendor || 'Expense')}</b>${d.vendor && d.description ? ' · ' + escHtml(d.vendor) : ''} · ${amt}` +
    (d.jobName ? `<br><span style="color:#6b7280">Job: ${escHtml(d.jobName)}</span>` : '');
}
function notifyApprovers(context, d, what) {
  const to = financeUpns().filter((u) => u !== d.owner);
  if (!to.length) return Promise.resolve();
  return notify(context, to, `${what} from ${d.ownerName || d.owner}`, `<p>${escHtml(d.ownerName || d.owner)} ${escHtml(what.toLowerCase())}:</p><p>${summaryLine(d)}</p>` +
    (d.note ? `<p style="white-space:pre-wrap">${escHtml(d.note)}</p>` : ''));
}
const DECISION_TEXT = { 'req-approved': 'approved your request to buy', 'req-denied': 'did not approve your request to buy', approved: 'approved your receipt', rejected: 'rejected your receipt', 'needs-info': 'has a question about your receipt' };

async function readExpense(container, id) {
  if (!UUID_RE.test(id || '')) throw new AuthError(404, 'Expense not found');
  try { const { resource } = await container.item(ID_PREFIX + id, ID_PREFIX + id).read(); if (resource) return resource; } catch (e) { if (e.code !== 404) throw e; }
  throw new AuthError(404, 'Expense not found');
}
function canSee(user, d) { return user.isFinance || d.owner === user.upn; }

async function saveReceipt(container, uuid, owner, b64) {
  await container.items.upsert({ id: IMG_PREFIX + uuid, type: 'expenseReceipt', owner, mime: 'image/jpeg', data: b64, savedAt: new Date().toISOString() });
}

// GET    /api/expenses            -> { items, me }  (Financial group: everyone's; cardholders: their own)
// POST   /api/expenses            { kind:'request'|'purchase', ...fields, receipt?, receiptRead? }
// PUT    /api/expenses/{id}       owner: edit a request, add the receipt to an approved request, or fix + resubmit
// DELETE /api/expenses/{id}       owner, before anyone has decided
app.http('expenses', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'expenses/{id?}',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireCardholderOrFinance(user);
      const container = getContainer(CONTAINER_ID);
      const id = request.params.id;

      if (request.method === 'GET') {
        const query = user.isFinance
          ? { query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p)', parameters: [{ name: '@p', value: ID_PREFIX }] }
          : { query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p) AND c.owner = @u', parameters: [{ name: '@p', value: ID_PREFIX }, { name: '@u', value: user.upn }] };
        const { resources } = await container.items.query(query).fetchAll();
        const others = financeUpns().filter((u) => u !== user.upn).length;
        return {
          headers: { 'Cache-Control': 'no-store' },
          jsonBody: {
            items: resources.map(publicItem).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
            me: { upn: user.upn, isFinance: user.isFinance, isCardholder: user.isCardholder, canSelfApprove: user.isFinance && others === 0, receiptReader: !!(process.env.DOCINTEL_ENDPOINT && process.env.DOCINTEL_KEY) },
          },
        };
      }

      const body = request.method === 'DELETE' ? {} : await request.json().catch(() => null);
      if (!body) return { status: 400, jsonBody: { error: 'Bad request' } };

      if (request.method === 'POST') {
        if (!user.isCardholder) throw new AuthError(403, 'Only cardholders can add expenses.');
        const kind = body.kind === 'request' ? 'request' : 'purchase';
        const r = readFields(body, kind === 'purchase');
        if (r.error) return { status: 400, jsonBody: { error: r.error } };
        const uuid = randomUUID(), now = new Date().toISOString();
        const receipt = kind === 'purchase' && body.receipt ? readReceipt(body.receipt) : null;
        if (receipt) await saveReceipt(container, uuid, user.upn, receipt);
        const doc = {
          id: ID_PREFIX + uuid, type: 'expense', kind, status: kind === 'request' ? 'requested' : 'submitted',
          owner: user.upn, ownerName: clean(user.name, 120), ...r.fields,
          hasReceipt: !!receipt, receiptRead: receipt ? readReceiptRead(body.receiptRead) : null,
          history: [historyEntry(user, kind === 'request' ? 'requested' : 'submitted', '')],
          createdAt: now, updatedAt: now,
        };
        await container.items.upsert(doc);
        audit(context, user, 'expense.create', { id: uuid, kind });
        await notifyApprovers(context, doc, kind === 'request' ? 'Purchase request' : 'Receipt submitted');
        return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { item: publicItem(doc) } };
      }

      const doc = await readExpense(container, id);
      if (doc.owner !== user.upn) throw new AuthError(403, 'Only the person who added this expense can change it.');

      if (request.method === 'DELETE') {
        if (!['requested', 'submitted', 'needs-info', 'req-denied'].includes(doc.status)) {
          return { status: 409, jsonBody: { error: 'This has already been decided, so it stays on record.' } };
        }
        await container.item(doc.id, doc.id).delete();
        if (doc.hasReceipt) { try { await container.item(IMG_PREFIX + id, IMG_PREFIX + id).delete(); } catch (e) { if (e.code !== 404) throw e; } }
        audit(context, user, 'expense.delete', { id });
        return { status: 204 };
      }

      // PUT
      const wasStatus = doc.status;
      let action;
      if (doc.status === 'requested') {
        const r = readFields(body, false); if (r.error) return { status: 400, jsonBody: { error: r.error } };
        Object.assign(doc, r.fields); action = 'edited';
      } else if (['req-approved', 'submitted', 'needs-info'].includes(doc.status)) {
        const r = readFields(body, true); if (r.error) return { status: 400, jsonBody: { error: r.error } };
        Object.assign(doc, r.fields);
        if (body.receipt) {
          await saveReceipt(container, id, user.upn, readReceipt(body.receipt));
          doc.hasReceipt = true; doc.receiptRead = readReceiptRead(body.receiptRead);
        }
        action = wasStatus === 'req-approved' ? 'receipt added' : (wasStatus === 'needs-info' ? 'resubmitted' : 'edited');
        doc.status = 'submitted';
      } else {
        return { status: 409, jsonBody: { error: 'This has already been decided and can no longer be changed.' } };
      }
      doc.history = (doc.history || []).concat(historyEntry(user, action, body.reply || '')).slice(-50);
      doc.updatedAt = new Date().toISOString();
      await container.items.upsert(doc);
      audit(context, user, 'expense.update', { id, action });
      if (action === 'receipt added' || action === 'resubmitted') await notifyApprovers(context, doc, action === 'receipt added' ? 'Receipt submitted' : 'Receipt resubmitted');
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { item: publicItem(doc) } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// POST /api/expenses/{id}/decision  { action, note }  -> Financial group only
//   requested:  approve | deny
//   submitted:  approve | reject | needs-info
//   approved:   reconcile ; reconciled: unreconcile
const TRANSITIONS = {
  requested: { approve: 'req-approved', deny: 'req-denied' },
  submitted: { approve: 'approved', reject: 'rejected', 'needs-info': 'needs-info' },
  approved: { reconcile: 'reconciled' },
  reconciled: { unreconcile: 'approved' },
};
const NOTE_REQUIRED = new Set(['deny', 'reject', 'needs-info']);
app.http('expenseDecision', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'expenses/{id}/decision',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      if (!user.isFinance) throw new AuthError(403, 'Only the Financial group can approve expenses.');
      const container = getContainer(CONTAINER_ID);
      const doc = await readExpense(container, request.params.id);
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || ''), note = clean(body.note, 500);
      const next = (TRANSITIONS[doc.status] || {})[action];
      if (!next) return { status: 409, jsonBody: { error: 'That can’t be done in its current state — refresh and try again.' } };
      if (NOTE_REQUIRED.has(action) && !note) return { status: 400, jsonBody: { error: 'Add a short note so they know why.' } };
      // Approving your own: only when nobody else in the Financial group could.
      let self = false;
      if (doc.owner === user.upn && (action === 'approve' || action === 'deny' || action === 'reject')) {
        if (financeUpns().some((u) => u !== user.upn)) return { status: 403, jsonBody: { error: 'Someone else in the Financial group needs to decide on your own expense.' } };
        self = true;
      }
      doc.status = next;
      doc.history = (doc.history || []).concat(historyEntry(user, self ? next + ' (self-approved)' : next, note)).slice(-50);
      doc.updatedAt = new Date().toISOString();
      await container.items.upsert(doc);
      audit(context, user, 'expense.decision', { id: request.params.id, action, self });
      if (DECISION_TEXT[next] && doc.owner !== user.upn) {
        await notify(context, [doc.owner], `${user.name || user.upn} ${DECISION_TEXT[next]}`,
          `<p>${escHtml(user.name || user.upn)} ${escHtml(DECISION_TEXT[next])}:</p><p>${summaryLine(doc)}</p>` +
          (note ? `<p style="white-space:pre-wrap;border-left:3px solid #16A37F;padding:4px 12px">${escHtml(note)}</p>` : '') +
          (next === 'req-approved' ? '<p>Add the receipt to the same request once you’ve bought it.</p>' : ''));
      }
      return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { item: publicItem(doc) } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// GET /api/expenses/{id}/receipt -> the receipt photo (owner or Financial group)
app.http('expenseReceipt', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'expenses/{id}/receipt',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireCardholderOrFinance(user);
      const container = getContainer(CONTAINER_ID);
      const doc = await readExpense(container, request.params.id);
      if (!canSee(user, doc)) throw new AuthError(404, 'Expense not found');
      let img = null;
      try { ({ resource: img } = await container.item(IMG_PREFIX + request.params.id, IMG_PREFIX + request.params.id).read()); } catch (e) { if (e.code !== 404) throw e; }
      if (!img || !img.data) return { status: 404, jsonBody: { error: 'No receipt photo' } };
      return { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }, body: Buffer.from(img.data, 'base64') };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});

// POST /api/expense-receipt/read  { receipt: base64 JPEG } -> { configured, vendor, date, total, tax }
// Azure AI Document Intelligence, prebuilt receipt model. Nothing is saved here;
// the photo is sent again with the expense when it's submitted.
async function analyzeReceipt(b64) {
  const endpoint = String(process.env.DOCINTEL_ENDPOINT || '').replace(/\/+$/, ''), key = process.env.DOCINTEL_KEY;
  if (!/^https:\/\//.test(endpoint) || !key) return null;
  const start = await fetch(`${endpoint}/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ base64Source: b64 }),
  });
  if (start.status !== 202) throw new Error('Receipt reader returned ' + start.status);
  const op = start.headers.get('operation-location');
  if (!op || !op.startsWith(endpoint + '/')) throw new Error('Receipt reader gave no result location');
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, i < 4 ? 700 : 1200));
    const res = await fetch(op, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (!res.ok) throw new Error('Receipt reader returned ' + res.status);
    const j = await res.json();
    if (j.status === 'failed') throw new Error('Receipt reader could not read it');
    if (j.status !== 'succeeded') continue;
    const f = (((j.analyzeResult || {}).documents || [])[0] || {}).fields || {};
    const cur = (x) => (x && x.valueCurrency && Number.isFinite(x.valueCurrency.amount) ? x.valueCurrency.amount : (x && Number.isFinite(x.valueNumber) ? x.valueNumber : null));
    return {
      vendor: clean(f.MerchantName && (f.MerchantName.valueString || f.MerchantName.content), 120),
      date: isoDate(f.TransactionDate && f.TransactionDate.valueDate),
      total: money(cur(f.Total)), tax: money(cur(f.TotalTax)),
    };
  }
  throw new Error('Receipt reader took too long');
}
app.http('expenseReceiptRead', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'expense-receipt/read',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      if (!user.isCardholder) throw new AuthError(403, 'Only cardholders can add expenses.');
      if (!process.env.DOCINTEL_ENDPOINT || !process.env.DOCINTEL_KEY) return { jsonBody: { configured: false } };
      const rl = checkRateLimit('expread:' + user.upn, READ_LIMIT, READ_WINDOW_MS);
      if (!rl.allowed) return { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) }, jsonBody: { error: 'Too many receipts read in the last hour — type this one in.' } };
      const body = await request.json().catch(() => ({}));
      const b64 = readReceipt(body.receipt);
      try {
        const out = await analyzeReceipt(b64);
        audit(context, user, 'expense.receipt.read', { ok: !!out });
        return { headers: { 'Cache-Control': 'no-store' }, jsonBody: { configured: true, ...(out || {}) } };
      } catch (e) {
        try { context.error('receipt read failed', e); } catch (_) { /* ignore */ }
        return { status: 502, jsonBody: { error: 'Couldn’t read that receipt — type the amounts in.' } };
      }
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
