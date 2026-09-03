const TENANT_ID = process.env.AAD_TENANT_ID;
const CLIENT_ID = process.env.AAD_CLIENT_ID;

let cachedToken = null; // { accessToken, expiresAt }

// App-only (client-credentials) Graph token -- every OTHER Graph call in this
// app (the shared-calendar push, crew-assignment write-back) runs client-side
// on the signed-in tech's own MSAL session. A scheduled job has no signed-in
// user to borrow a token from, so it authenticates as the app itself instead.
// Requires the "JetCity Availability App" registration to have an
// application-level Mail.Send permission (admin-consented, NOT delegated) and
// a client secret set here as MAIL_CLIENT_SECRET -- both created by hand in
// the Azure Portal, never by code.
async function getAppToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.accessToken;
  const clientSecret = process.env.MAIL_CLIENT_SECRET;
  if (!clientSecret) throw new Error('MAIL_CLIENT_SECRET is not configured');
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph token error ${res.status}: ${text}`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

// Sends mail as `from`, which must be a real mailbox (user or shared mailbox)
// -- a plain distribution list has no message store and app-only sendMail
// will fail against one.
// Optional `attachments` = [{ name, contentType, bytes:Buffer }] are inlined as
// fileAttachments. Inline attachments only need Mail.Send (no draft/mailbox
// write), but the whole request must stay under Graph's ~4MB /sendMail cap, so
// callers must keep the total small (the report sender compresses photos first).
async function sendMail({ from, to, subject, html, attachments }) {
  const token = await getAppToken();
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (attachments && attachments.length) {
    message.attachments = attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: a.bytes.toString('base64'),
    }));
  }
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph sendMail error ${res.status}: ${text}`);
  }
}

// Full company directory (id, displayName, mail, userPrincipalName), used as
// a fallback when Smartsheet's contact list doesn't have someone's email --
// Smartsheet's contactOptions is that account's contextual "suggested
// contacts," not a complete roster, so it silently misses anyone who hasn't
// recently been a suggested contact. Requires an application-level
// User.Read.All permission (admin-consented) on top of Mail.Send.
async function listUsers() {
  const token = await getAppToken();
  // mobilePhone/businessPhones/jobTitle feed the in-app Team contacts list;
  // adding them to the select is harmless for the matchDirectoryUser callers.
  let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName,mobilePhone,businessPhones,jobTitle,accountEnabled&$top=999';
  const users = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph listUsers error ${res.status}: ${text}`);
    }
    const data = await res.json();
    users.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return users;
}

// Matches a roster name ("Eve N" — first name + last initial, the convention
// the Smartsheet roster uses) to a directory user's email. Checks the initial
// against every word after the first name so compound surnames ("Van Cise")
// still match. Used to resolve people Smartsheet's contactOptions (only its
// "suggested contacts") doesn't know. Mirrors the reminder's matcher.
function matchDirectoryUser(name, directoryUsers) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const firstName = parts[0].toLowerCase();
  const lastInitial = parts[parts.length - 1][0].toLowerCase();
  const match = (directoryUsers || []).find((u) => {
    const dParts = (u.displayName || '').trim().split(/\s+/);
    if (dParts.length < 2 || dParts[0].toLowerCase() !== firstName) return false;
    return dParts.slice(1).some((p) => p[0] && p[0].toLowerCase() === lastInitial);
  });
  return match ? match.mail || match.userPrincipalName || null : null;
}

module.exports = { getAppToken, sendMail, listUsers, matchDirectoryUser };
