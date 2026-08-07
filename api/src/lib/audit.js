// Lightweight audit logging for security-relevant events (writes, permission
// denials, and reads of client PII). Emits a single structured JSON line to
// Application Insights via context.log, so you can query/alert on it, e.g.
// spot a user reading an abnormal number of dispatch records in a short window.
//
// IMPORTANT: log the actor + action + resource identifiers only — NEVER the
// sensitive values themselves (no phone numbers, addresses, etc.).

function audit(context, user, action, detail) {
  try {
    context.log(
      'AUDIT ' +
        JSON.stringify({
          audit: true,
          ts: new Date().toISOString(),
          upn: user && user.upn ? user.upn : null,
          isEditor: user ? !!user.isEditor : null,
          action,
          ...(detail || {}),
        })
    );
  } catch (_) {
    // Logging must never break a request.
  }
}

module.exports = { audit };
