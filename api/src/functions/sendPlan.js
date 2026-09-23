const { app } = require('@azure/functions');
const { requireUser, requirePlanner, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');
const { sendMail } = require('../lib/graph');

// Forwards a Project Plan as a formatted HTML email, sent FROM the signed-in
// planner's own mailbox (app-only Graph sendMail, same permission/pattern as
// sendReport.js). Planners only; the sender is always the authenticated
// caller's UPN (never client-supplied), so no one can send as someone else.
const CONTAINER_ID = 'dispatch';
const ID_PREFIX = 'plan:';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function contactRows(list, showOrg) {
  return (list || []).map((c) =>
    `<tr>`
    + `<td style="padding:5px 16px 5px 0;color:#1a2430;vertical-align:top">${escHtml(c.name)}${showOrg && c.org ? ` <span style="color:#9aa4ae">&middot; ${escHtml(c.org)}</span>` : ''}</td>`
    + `<td style="padding:5px 0;color:#66707a;vertical-align:top">${escHtml(c.phone)}</td>`
    + `</tr>`).join('');
}

function contactBox(title, list, showOrg) {
  const rows = contactRows(list, showOrg);
  return `<div style="flex:1;min-width:220px;background:#f6f8fa;border:1px solid #e3e8ec;border-radius:10px;padding:10px 14px;margin:0 8px 12px 0">`
    + `<div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:6px">${escHtml(title)}</div>`
    + (rows ? `<table style="border-collapse:collapse">${rows}</table>` : `<div style="color:#9aa4ae;font-size:13px">&mdash;</div>`)
    + `</div>`;
}

function hcChips(rows) {
  return (rows || []).map((r) => `<span style="display:inline-block;background:#e6f5ef;color:#0b7a5e;border-radius:6px;padding:2px 8px;font-size:12.5px;margin:0 6px 6px 0">${escHtml(r.floor)} <b>${parseInt(r.hc, 10) || 0}</b></span>`).join('');
}

function hcTotal(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((a, r) => a + (r.hc || 0), 0);
}

// HTML mirroring the plan's read view (project managers/leads, scope,
// disconnect/reconnect HC + totals, timeline, pmhc, requirements). Empty
// sections are omitted, same as the in-app read view.
function buildPlanHtml(p) {
  let html = `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:660px;color:#1a2430;font-size:14px;line-height:1.45">`;
  html += `<h2 style="margin:0 0 2px;font-size:20px;color:#12805c">${escHtml(p.project || 'Untitled plan')}</h2>`;
  const sub = [p.projectId, p.planDate].filter(Boolean).map(escHtml).join(' &middot; ');
  if (sub) html += `<div style="color:#66707a;font-size:13px;margin-bottom:4px">${sub}</div>`;
  if (p.bisDate) html += `<div style="display:inline-block;background:#c0392b;color:#fff;font-size:12px;font-weight:600;padding:3px 10px;border-radius:6px;margin-bottom:12px">BIS deadline ${escHtml(p.bisDate)}</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;margin-top:10px">${contactBox('Project managers (client)', p.managers, true)}${contactBox('JCIT project leads', p.leads, false)}</div>`;
  if (p.scope) html += `<div style="margin:14px 0"><div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:4px">Move scope</div><div style="white-space:pre-wrap">${escHtml(p.scope)}</div></div>`;
  if ((p.disconnect && p.disconnect.length) || (p.reconnect && p.reconnect.length)) {
    html += `<div style="display:flex;flex-wrap:wrap;margin:14px 0;gap:20px">`
      + `<div style="flex:1;min-width:220px"><div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:6px">Disconnect &middot; total ${hcTotal(p.disconnect).toLocaleString()} HC</div>${hcChips(p.disconnect) || '<span style="color:#9aa4ae;font-size:13px">&mdash;</span>'}</div>`
      + `<div style="flex:1;min-width:220px"><div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:6px">Reconnect &middot; total ${hcTotal(p.reconnect).toLocaleString()} HC</div>${hcChips(p.reconnect) || '<span style="color:#9aa4ae;font-size:13px">&mdash;</span>'}</div>`
      + `</div>`;
  }
  if (p.timeline && p.timeline.length) {
    const rows = p.timeline.map((r) => `<tr><td style="padding:5px 10px 5px 0;border-bottom:1px solid #eef1f4">${escHtml(r.task)}</td><td style="padding:5px 10px 5px 0;color:#66707a;border-bottom:1px solid #eef1f4">${escHtml(r.when)}</td><td style="padding:5px 0;color:#66707a;border-bottom:1px solid #eef1f4">${escHtml(r.lead)}</td></tr>`).join('');
    html += `<div style="margin:14px 0"><div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:6px">Preliminary timeline</div><table style="border-collapse:collapse;width:100%">${rows}</table></div>`;
  }
  if (p.pmhc) html += `<div style="margin:14px 0"><div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:4px">Post-move help center</div><div style="white-space:pre-wrap">${escHtml(p.pmhc)}</div></div>`;
  if (p.requirements) html += `<div style="margin:14px 0"><div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#66707a;margin-bottom:4px">Technician requirements</div><div style="white-space:pre-wrap">${escHtml(p.requirements)}</div></div>`;
  html += `<p style="color:#9aa4ae;font-size:12px;margin-top:20px">Sent from the JCIT Crew Calendar &middot; Project Planning</p>`;
  html += `</div>`;
  return html;
}

app.http('sendPlan', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'send-plan',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requirePlanner(user);
      let body = {};
      try { body = await request.json(); } catch (_) { /* invalid/empty body handled below */ }
      const rawId = String(body.planId || '').trim();
      const to = String(body.to || '').trim();
      if (!rawId) return { status: 400, jsonBody: { error: 'Missing planId' } };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { status: 400, jsonBody: { error: 'Invalid recipient email' } };
      const docId = rawId.indexOf(ID_PREFIX) === 0 ? rawId : ID_PREFIX + rawId;

      const container = getContainer(CONTAINER_ID);
      let plan;
      try {
        const { resource } = await container.item(docId, docId).read();
        plan = resource;
      } catch (e) {
        if (e.code === 404) return { status: 404, jsonBody: { error: 'Plan not found' } };
        throw e;
      }
      if (!plan) return { status: 404, jsonBody: { error: 'Plan not found' } };

      const subject = 'Project Plan — ' + (plan.project || 'Untitled plan') + (plan.planDate ? (' · ' + plan.planDate) : '');
      try {
        await sendMail({ from: user.upn, to, subject, html: buildPlanHtml(plan) });
      } catch (e) {
        context.error('sendPlan send failed:', e);
        return { status: 502, jsonBody: { error: 'Email send failed. Check that Mail.Send + MAIL_CLIENT_SECRET are configured.' } };
      }
      return { jsonBody: { sent: true, to } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
