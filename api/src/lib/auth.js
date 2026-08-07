const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { checkRateLimit } = require('./ratelimit');

const TENANT_ID = process.env.AAD_TENANT_ID;
const CLIENT_ID = process.env.AAD_CLIENT_ID;
// MSAL's acquireTokenSilent issues v1.0 tokens for this app's own
// "Expose an API" scope (unlike the v2.0 tokens Graph scopes get), so the
// issuer is the older sts.windows.net form, not login.microsoftonline.com/v2.0.
const ISSUER = `https://sts.windows.net/${TENANT_ID}/`;
const AUDIENCE = `api://${CLIENT_ID}`;
const ALLOWED_DOMAIN = '@jetcityit.com';
const REQUIRED_SCOPE = 'access_as_user';

// Authorization model: EVERYONE signed in with an @jetcityit.com account can
// READ (techs need client phone numbers to call/text on site). Only "editors"
// may CHANGE data (reassign crew, clear availability weeks). A user is an editor
// if EITHER is true:
//   1. Their token carries the Entra App Role "DataEditor" (roles claim) — preferred,
//      managed in the Entra portal with no code change.
//   2. Their email is listed in the EDITOR_UPNS app setting (comma-separated) —
//      a quick-start / fallback that needs no app-registration change.
const WRITE_ROLE = 'DataEditor';
const EDITOR_UPNS = (process.env.EDITOR_UPNS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getSigningKey,
      { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'] },
      (err, decoded) => (err ? reject(err) : resolve(decoded))
    );
  });
}

class AuthError extends Error {
  constructor(status, message, retryAfterSec) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

// Validates the bearer token, enforces the @jetcityit.com restriction and a
// per-user rate limit, and resolves the caller's edit permission.
//
// Reads the token from a custom header, not "Authorization" — Azure Static
// Web Apps' managed-Functions integration reserves that header for its own
// internal SWA-to-Function service token and overwrites whatever the client
// sends, so a client-supplied Authorization header never reaches this code.
async function requireUser(request) {
  const header = request.headers.get('x-jetcity-authorization') || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) throw new AuthError(401, 'Missing bearer token');

  let decoded;
  try {
    decoded = await verifyToken(match[1]);
  } catch (e) {
    throw new AuthError(401, 'Invalid token: ' + e.message);
  }

  const scopes = String(decoded.scp || '').split(' ');
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new AuthError(403, 'Token missing required scope');
  }

  const upn = String(decoded.preferred_username || decoded.upn || decoded.email || '').toLowerCase();
  if (!upn.endsWith(ALLOWED_DOMAIN)) {
    throw new AuthError(403, 'Account not permitted');
  }

  // Per-user rate limit — caps how fast any one identity can pull data.
  const rl = checkRateLimit(upn);
  if (!rl.allowed) {
    throw new AuthError(429, 'Too many requests — please slow down.', rl.retryAfterSec);
  }

  const roles = Array.isArray(decoded.roles) ? decoded.roles : [];
  const isEditor = roles.includes(WRITE_ROLE) || EDITOR_UPNS.includes(upn);

  return { name: decoded.name || upn, upn, roles, isEditor };
}

// Gate for write/change operations. Reads never call this; writes do.
function requireEditor(user) {
  if (!user || !user.isEditor) {
    throw new AuthError(403, 'You do not have permission to change this data.');
  }
}

function authErrorResponse(e, context) {
  if (e instanceof AuthError) {
    const res = { status: e.status, jsonBody: { error: e.message } };
    if (e.status === 429 && e.retryAfterSec) {
      res.headers = { 'Retry-After': String(e.retryAfterSec) };
    }
    return res;
  }
  context.error(e);
  return { status: 500, jsonBody: { error: 'Internal server error' } };
}

module.exports = { requireUser, requireEditor, AuthError, authErrorResponse };
