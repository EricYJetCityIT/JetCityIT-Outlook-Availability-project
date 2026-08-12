const { app } = require('@azure/functions');
const mammoth = require('mammoth');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { fetchAttachment } = require('../lib/smartsheet');

function isDocx(att) {
  return /wordprocessingml/i.test(att.mimeType || '') || /\.docx$/i.test(att.name || '');
}

// Streams an attachment's bytes back through our own origin so the browser can
// display it inline (Smartsheet's own signed URLs are cross-origin and marked
// Content-Disposition: attachment, which forces a download and is blocked by
// the page CSP's connect-src). The frontend fetches this with the bearer
// header, turns the response into a blob, and shows it in an in-app viewer.
//
// Auth + read model are identical to /api/attachment: any signed-in
// @jetcityit.com user, Smartsheet token stays server-side.
app.http('attachmentContent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'attachment/{id}/content',
  handler: async (request, context) => {
    try {
      await requireUser(request);

      const id = request.params.id;
      if (!id) return { status: 400, jsonBody: { error: 'Missing attachment id' } };

      let att;
      try {
        att = await fetchAttachment(id);
      } catch (e) {
        if (/\b404\b/.test(String(e && e.message))) {
          return { status: 404, jsonBody: { error: 'Attachment not found' } };
        }
        throw e;
      }
      if (!att || !att.url) return { status: 404, jsonBody: { error: 'Attachment not found' } };

      const fileRes = await fetch(att.url);
      if (!fileRes.ok) {
        context.error(`Attachment file fetch failed ${fileRes.status} for ${id}`);
        return { status: 502, jsonBody: { error: 'Could not retrieve the file' } };
      }

      const buf = Buffer.from(await fileRes.arrayBuffer());

      // ?as=html on a Word .docx → convert to HTML server-side (mammoth) so the
      // viewer can show it inline. Browsers can't render .docx natively and we
      // deliberately don't hand the file to any third-party viewer, so this
      // keeps document contents inside our own environment. Formatting is a
      // best-effort text/table/image rendering, not pixel-perfect; the raw file
      // is always available via the plain /content download.
      if (new URL(request.url).searchParams.get('as') === 'html' && isDocx(att)) {
        try {
          const result = await mammoth.convertToHtml({ buffer: buf });
          return {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            },
            body: result.value || '<p><em>(This document has no readable content.)</em></p>',
          };
        } catch (e) {
          context.error(`docx conversion failed for ${id}: ${e && e.message}`);
          return { status: 415, jsonBody: { error: 'Could not convert this document for preview' } };
        }
      }

      const type = att.mimeType || fileRes.headers.get('content-type') || 'application/octet-stream';
      const safeName = String(att.name || 'file').replace(/["\r\n]/g, '');

      return {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Disposition': `inline; filename="${safeName}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
        body: buf,
      };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
