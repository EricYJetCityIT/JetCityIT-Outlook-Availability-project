const { app } = require('@azure/functions');
const { requireUser, requireEditor, authErrorResponse } = require('../lib/auth');
const { addRowAttachment } = require('../lib/smartsheet');
const { runSync } = require('./smartsheetSync');
const { audit } = require('../lib/audit');

// In-app "Add attachment" on New/Edit job — uploads one or more files (photos,
// maps, PDFs) as Smartsheet row attachments, then re-syncs so the board shows
// the 📎 count and the files become viewable in the in-app viewer. Editors only
// (same bar as creating/editing a job). A deliberate write carve-out alongside
// jobCreate.js / jobNotes.js / jobCrew.js.
//
// The client posts multipart/form-data with one part per file. We stream each
// file's bytes straight to Smartsheet; nothing is persisted on our side.
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
// Photos + maps + the occasional PDF/plan. Kept to a safe, previewable set —
// the in-app viewer renders images and PDFs inline.
const ALLOWED = [
  /^image\//i,
  /^application\/pdf$/i,
];

function typeAllowed(mime, name) {
  const t = String(mime || '');
  if (ALLOWED.some((re) => re.test(t))) return true;
  // Some browsers send an empty type for HEIC or odd files — fall back to the
  // extension so phone photos and PDFs still go through.
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|pdf)$/i.test(String(name || ''));
}

app.http('jobAttachment', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'dispatch/jobs/{jobId}/attachments',
  handler: async (request, context) => {
    try {
      const user = await requireUser(request);
      requireEditor(user);

      const rowId = String(request.params.jobId || '').replace(/^ss-/, '');
      if (!/^\d{6,}$/.test(rowId)) {
        return { status: 400, jsonBody: { error: 'Invalid job id' } };
      }

      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return { status: 400, jsonBody: { error: 'Expected a multipart file upload' } };
      }

      // Collect the File parts (skip any non-file fields).
      const files = [];
      for (const value of form.values()) {
        if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') {
          files.push(value);
        }
      }
      if (!files.length) return { status: 400, jsonBody: { error: 'No file was uploaded' } };
      if (files.length > MAX_FILES) {
        return { status: 400, jsonBody: { error: `Too many files at once (max ${MAX_FILES})` } };
      }

      const uploaded = [];
      for (const file of files) {
        const name = file.name || 'file';
        if (!typeAllowed(file.type, name)) {
          return { status: 400, jsonBody: { error: `Unsupported file type: ${name}. Only images and PDFs are allowed.` } };
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        if (!bytes.length) continue; // skip empty parts
        if (bytes.length > MAX_BYTES) {
          return { status: 400, jsonBody: { error: `"${name}" is too large (max 25 MB).` } };
        }
        await addRowAttachment(rowId, name, file.type || 'application/octet-stream', bytes);
        uploaded.push(name);
      }

      if (!uploaded.length) return { status: 400, jsonBody: { error: 'No file was uploaded' } };

      audit(context, user, 'dispatch.job.attach', { jobId: rowId, count: uploaded.length });

      // Re-sync so the board reflects the new attachment count right away.
      const result = await runSync(context, true);
      return { jsonBody: { ...result, attached: uploaded.length } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
