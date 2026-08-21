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
async function sendMail({ from, to, subject, html }) {
  const token = await getAppToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph sendMail error ${res.status}: ${text}`);
  }
}

// Sends an HTML email as `from` with file attachments. Small files (<3MB) go
// straight into the draft; larger ones (the report photos are often several MB,
// past Graph's ~4MB single-request cap) use an upload session with chunked PUTs
// (chunks must be a multiple of 320 KiB except the last). Flow: create draft →
// attach each file → send. attachments = [{ name, contentType, bytes:Buffer }].
async function sendMailWithAttachments({ from, to, subject, html, attachments }) {
  const list = attachments || [];
  if (!list.length) return sendMail({ from, to, subject, html });
  const token = await getAppToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}`;
  const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const draftRes = await fetch(`${base}/messages`, {
    method: 'POST', headers: authJson,
    body: JSON.stringify({ subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }),
  });
  if (!draftRes.ok) throw new Error(`Graph draft error ${draftRes.status}: ${await draftRes.text().catch(() => '')}`);
  const msgId = (await draftRes.json()).id;

  const SMALL = 3 * 1024 * 1024;
  const CHUNK = 320 * 1024 * 10; // 3.2MB, a multiple of 320 KiB
  for (const att of list) {
    const size = att.bytes.length;
    const contentType = att.contentType || 'application/octet-stream';
    if (size <= SMALL) {
      const r = await fetch(`${base}/messages/${msgId}/attachments`, {
        method: 'POST', headers: authJson,
        body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: att.name, contentType, contentBytes: att.bytes.toString('base64') }),
      });
      if (!r.ok) throw new Error(`Graph attach error ${r.status}: ${await r.text().catch(() => '')}`);
    } else {
      const sessRes = await fetch(`${base}/messages/${msgId}/attachments/createUploadSession`, {
        method: 'POST', headers: authJson,
        body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: att.name, size, contentType } }),
      });
      if (!sessRes.ok) throw new Error(`Graph upload session error ${sessRes.status}: ${await sessRes.text().catch(() => '')}`);
      const uploadUrl = (await sessRes.json()).uploadUrl;
      for (let start = 0; start < size; start += CHUNK) {
        const end = Math.min(start + CHUNK, size);
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${size}` },
          body: att.bytes.subarray(start, end),
        });
        if (!(put.status === 200 || put.status === 201 || put.status === 202)) {
          throw new Error(`Graph upload chunk error ${put.status}: ${await put.text().catch(() => '')}`);
        }
      }
    }
  }

  const sendRes = await fetch(`${base}/messages/${msgId}/send`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!(sendRes.ok || sendRes.status === 202)) throw new Error(`Graph send error ${sendRes.status}: ${await sendRes.text().catch(() => '')}`);
}

// Full company directory (id, displayName, mail, userPrincipalName), used as
// a fallback when Smartsheet's contact list doesn't have someone's email --
// Smartsheet's contactOptions is that account's contextual "suggested
// contacts," not a complete roster, so it silently misses anyone who hasn't
// recently been a suggested contact. Requires an application-level
// User.Read.All permission (admin-consented) on top of Mail.Send.
async function listUsers() {
  const token = await getAppToken();
  let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName&$top=999';
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

module.exports = { getAppToken, sendMail, sendMailWithAttachments, listUsers };
