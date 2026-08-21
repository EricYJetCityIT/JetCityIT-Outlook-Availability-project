const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { fetchReportByJobId } = require('../lib/smartsheet');
const { sendMail } = require('../lib/graph');

// Forwards a job's submitted Daily Project Report as a formatted HTML email,
// sent FROM the signed-in editor's own mailbox (app-only Graph sendMail, the
// same permission the availability reminder uses). Editors only; the sender is
// always the authenticated caller's UPN (never a value from the request), so
// no one can send as someone else. Empty report fields are already dropped by
// fetchReportByJobId, so the email omits them.
function getReportSheetId() {
  const id = process.env.REPORT_SHEET_ID;
  if (!id) throw new Error('REPORT_SHEET_ID is not configured');
  return id;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML mirroring the Smartsheet report: title, subtitle, label/value table.
// Inline styles only — mail clients strip <style>/CSS classes.
function buildReportHtml(project, date, fields) {
  const rows = (fields || []).map((f) =>
    `<tr>`
    + `<td style="padding:7px 16px 7px 0;font-weight:600;color:#3a4a5a;vertical-align:top;white-space:nowrap;border-bottom:1px solid #eef1f4">${escHtml(f.label)}</td>`
    + `<td style="padding:7px 0;color:#1a2430;vertical-align:top;border-bottom:1px solid #eef1f4">${escHtml(f.value).replace(/\n/g, '<br>')}</td>`
    + `</tr>`).join('');
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:660px;color:#1a2430;font-size:14px;line-height:1.45">`
    + `<h2 style="margin:0 0 2px;font-size:20px;color:#12805c">Daily Project Report</h2>`
    + `<div style="color:#66707a;font-size:13px;margin-bottom:16px">${escHtml(project)}${date ? (' &middot; ' + escHtml(date)) : ''}</div>`
    + `<table style="border-collapse:collapse;width:100%">${rows}</table>`
    + `<p style="color:#9aa4ae;font-size:12px;margin-top:20px">Sent from the JCIT Crew Calendar</p>`
    + `</div>`;
}

app.http('sendReport', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'send-report',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);
      let body = {};
      try { body = await request.json(); } catch (_) { /* invalid/empty body handled below */ }
      const jobId = String(body.jobId || '').trim();
      const to = String(body.to || '').trim();
      if (!/^ss-\d{6,}$/.test(jobId)) return { status: 400, jsonBody: { error: 'Invalid jobId' } };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { status: 400, jsonBody: { error: 'Invalid recipient email' } };

      const r = await fetchReportByJobId(getReportSheetId(), jobId);
      if (!r || !r.found) return { status: 404, jsonBody: { error: 'No linked report found for this job' } };

      const fields = r.fields || [];
      const project = (fields.find((f) => f.label === 'Project Name') || {}).value || '';
      const date = (fields.find((f) => f.label === 'Service Date') || {}).value || '';
      const subject = 'Daily Project Report — ' + project + (date ? (' · ' + date) : '');
      const html = buildReportHtml(project, date, fields);

      try {
        await sendMail({ from: user.upn, to, subject, html });
      } catch (e) {
        context.error('sendReport sendMail failed:', e);
        return { status: 502, jsonBody: { error: 'Email send failed. Check that Mail.Send + MAIL_CLIENT_SECRET are configured.' } };
      }
      return { jsonBody: { sent: true, to } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
