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

module.exports = { getAppToken, sendMail };
