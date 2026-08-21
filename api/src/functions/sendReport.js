const { app } = require('@azure/functions');
const Jimp = require('jimp');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { fetchReportByJobId, fetchAttachmentBytes } = require('../lib/smartsheet');
const { sendMail } = require('../lib/graph');

// Downscale + recompress a photo so several fit under Graph's ~4MB /sendMail
// inline cap (keeping us on Mail.Send only, no mailbox-write permission).
// Returns { name, contentType, bytes } as JPEG, or null for non-images.
async function compressPhoto(name, contentType, bytes) {
  if (!/^image\//i.test(contentType || '') && !/\.(jpe?g|png|bmp|tiff?|gif)$/i.test(name || '')) return null;
  const img = await Jimp.read(bytes);
  if (img.bitmap.width > 1600) img.resize(1600, Jimp.AUTO);
  img.quality(72);
  const out = await img.getBufferAsync(Jimp.MIME_JPEG);
  const base = String(name || 'photo').replace(/\.[^.]+$/, '');
  return { name: base + '.jpg', contentType: 'image/jpeg', bytes: out };
}

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

// HTML mirroring the Smartsheet report: title, subtitle, label/value table,
// and a photos note. Inline styles only — mail clients strip <style>/classes.
function buildReportHtml(project, date, fields, attachedCount, omittedCount) {
  const rows = (fields || []).map((f) =>
    `<tr>`
    + `<td style="padding:7px 16px 7px 0;font-weight:600;color:#3a4a5a;vertical-align:top;white-space:nowrap;border-bottom:1px solid #eef1f4">${escHtml(f.label)}</td>`
    + `<td style="padding:7px 0;color:#1a2430;vertical-align:top;border-bottom:1px solid #eef1f4">${escHtml(f.value).replace(/\n/g, '<br>')}</td>`
    + `</tr>`).join('');
  let photos = '';
  if (attachedCount > 0) {
    photos = `<p style="color:#3a4a5a;font-size:13px;margin-top:16px">📎 ${attachedCount} photo${attachedCount !== 1 ? 's' : ''} attached`
      + (omittedCount > 0 ? ` <span style="color:#9aa4ae">(${omittedCount} more not attached — too large)</span>` : '') + `</p>`;
  } else if (omittedCount > 0) {
    photos = `<p style="color:#9aa4ae;font-size:13px;margin-top:16px">${omittedCount} photo${omittedCount !== 1 ? 's' : ''} on this report were too large to attach.</p>`;
  }
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:660px;color:#1a2430;font-size:14px;line-height:1.45">`
    + `<h2 style="margin:0 0 2px;font-size:20px;color:#12805c">Daily Project Report</h2>`
    + `<div style="color:#66707a;font-size:13px;margin-bottom:16px">${escHtml(project)}${date ? (' &middot; ' + escHtml(date)) : ''}</div>`
    + `<table style="border-collapse:collapse;width:100%">${rows}</table>`
    + photos
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

      // Download + compress the report's photos to attach inline. Keep the whole
      // /sendMail request under Graph's ~4MB cap (base64 adds ~33%), so budget
      // the raw total to ~2.8MB. Compressed photos are a few hundred KB each, so
      // several fit; any beyond the budget/count are noted as omitted.
      const MAX_TOTAL = Math.floor(2.8 * 1024 * 1024);
      const MAX_COUNT = 20;
      const attMeta = (r.attachments || []).slice(0, MAX_COUNT);
      const files = [];
      let total = 0, skipped = (r.attachments || []).length - attMeta.length;
      for (const a of attMeta) {
        try {
          const raw = await fetchAttachmentBytes(getReportSheetId(), a.id);
          let f = raw;
          try {
            const c = await compressPhoto(raw.name, raw.contentType, raw.bytes);
            if (c) f = c; // non-images keep their original bytes
          } catch (ce) { context.error('photo compress failed, using original', a.id, ce); }
          if (total + f.bytes.length > MAX_TOTAL) { skipped++; continue; }
          total += f.bytes.length;
          files.push(f);
        } catch (e) { context.error('report attachment fetch failed', a.id, e); skipped++; }
      }

      let attached = files.length;
      try {
        await sendMail({ from: user.upn, to, subject, html: buildReportHtml(project, date, fields, attached, skipped), attachments: files });
      } catch (e) {
        // If sending with the photos fails (e.g. size), retry once without them
        // so the report still gets delivered.
        context.error('sendReport send failed; retrying without photos:', e);
        try {
          attached = 0;
          await sendMail({ from: user.upn, to, subject, html: buildReportHtml(project, date, fields, 0, (r.attachments || []).length) });
        } catch (e2) {
          context.error('sendReport send failed (no photos too):', e2);
          return { status: 502, jsonBody: { error: 'Email send failed. Check that Mail.Send + MAIL_CLIENT_SECRET are configured.' } };
        }
      }
      return { jsonBody: { sent: true, to, attached, omitted: attached ? skipped : (r.attachments || []).length } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
