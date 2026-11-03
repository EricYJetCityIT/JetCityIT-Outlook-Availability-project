const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { checkRateLimit } = require('./ratelimit');
const { getAccessLists } = require('./access');

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

// The "financial" group — a separate, smaller access group (e.g. for the
// Invoice tab), independent of editor status. Comma-separated @jetcityit.com
// emails in the FINANCE_UPNS app setting. Empty/unset => nobody is in it.
const FINANCE_UPNS = (process.env.FINANCE_UPNS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// The "Project Planners" group — a separate access group (for the Project
// Planning tab), independent of editor and finance status. Comma-separated
// @jetcityit.com emails in the PLANNER_UPNS app setting. Empty/unset => nobody.
const PLANNER_UPNS = (process.env.PLANNER_UPNS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// The "Testers" group — a private access group for in-progress features (today
// the Job Sheets tab), so a small set of people (e.g. Eric + Dylan) can test
// something before it's shown to everyone. Independent of editor, finance, and
// planner status. Comma-separated @jetcityit.com emails in the TESTER_UPNS app
// setting. Empty/unset => nobody is in it (the gated tab stays hidden for all).
const TESTER_UPNS = (process.env.TESTER_UPNS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// The "Cardholders" group -- people who carry a company card and submit
// purchase requests + receipts on the Expenses tab (the Financial group
// approves them). Comma-separated @jetcityit.com emails in the CARDHOLDER_UPNS
// app setting. Empty/unset => nobody.
const CARDHOLDER_UPNS = (process.env.CARDHOLDER_UPNS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// OPTIONAL: narrows who may manage access on the Manager view's Access tab (add/remove people in the
// Editor / Finance / Planner / Tester lists). Unset or empty => every editor who is an editor through Azure
// (EDITOR_UPNS or the DataEditor role) may. Set => only the people listed here (and who are also such editors).
// Matters because the Finance group is meant to be smaller than the editor group.
const ACCESS_ADMIN_UPNS = (process.env.ACCESS_ADMIN_UPNS || '')
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
  constructor(status, message, meta) {
    super(message);
    this.status = status;
    if (meta) Object.assign(this, meta); // e.g. { retryAfterSec, upn } for 429s
  }
}

// Validates the bearer token on an incoming request and enforces the same
// @jetcityit.com restriction already shown in the frontend's login overlay
// (the API must not trust the client to have applied it).
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

  // Per-user rate limit — caps how fast any one signed-in identity (or a leaked
  // token) can pull data, blunting scraping / bulk harvesting of client PII.
  const rl = checkRateLimit(upn);
  if (!rl.allowed) {
    throw new AuthError(429, 'Too many requests — please slow down.', { retryAfterSec: rl.retryAfterSec, upn });
  }

  const roles = Array.isArray(decoded.roles) ? decoded.roles : [];
  // Access is the Azure/Entra grants (the lists above and the DataEditor role) PLUS anyone an access
  // admin added on the Manager view's Access tab (see lib/access.js; a failed read adds nobody).
  const { lists: granted, unavailable } = await getAccessLists();
  const azureEditor = roles.includes(WRITE_ROLE) || EDITOR_UPNS.includes(upn);
  const isEditor = azureEditor || granted.editors.includes(upn);
  const isFinance = FINANCE_UPNS.includes(upn) || granted.finance.includes(upn);
  const isPlanner = PLANNER_UPNS.includes(upn) || granted.planners.includes(upn);
  const isTester = TESTER_UPNS.includes(upn) || granted.testers.includes(upn);
  const isCardholder = CARDHOLDER_UPNS.includes(upn); // Azure-managed only (not on the Access tab)
  // Only people who are editors through Azure (EDITOR_UPNS or the Entra role) may change who has access,
  // so someone granted Editor from the page can never hand out access themselves. If ACCESS_ADMIN_UPNS
  // is set it narrows that further to the people listed there (they must still be Azure editors).
  const isAccessAdmin = azureEditor && (ACCESS_ADMIN_UPNS.length === 0 || ACCESS_ADMIN_UPNS.includes(upn));

  return { name: decoded.name || upn, upn, roles, isEditor, isFinance, isPlanner, isTester, isCardholder, isAccessAdmin, accessUnavailable: unavailable };
}

// "No" vs "couldn't check": when the page-granted lists could not be read and nothing is cached, someone
// who fails a check may really be on those lists, so answer 503 (try again) instead of a misleading 403.
function deny(user, message) {
  if (user && user.accessUnavailable) {
    throw new AuthError(503, 'Access list is temporarily unavailable. Please try again in a moment.');
  }
  throw new AuthError(403, message);
}

// Gate for write/change operations. Reads never call this; writes do.
function requireEditor(user) {
  if (!user || !user.isEditor) {
    deny(user, 'You do not have permission to change this data.');
  }
}

// Gate for managing who has which access (the Manager view's Access tab and its endpoints). This one
// depends only on Azure settings, so it never needs the 503 case.
function requireAccessAdmin(user) {
  if (!user || !user.isAccessAdmin) {
    throw new AuthError(403, 'You do not have permission to manage access.');
  }
}

// For /api/me (and handlers that branch on the caller's role): while the page lists are unreadable the flags
// may be missing page grants, so answer 503 rather than a downgraded role the browser would remember.
function requireAccessKnown(user) {
  if (user && user.accessUnavailable) deny(user);
}

// The people granted in Azure settings (read-only from the site), for the Access tab to display.
function azureAccessLists() {
  return { editors: EDITOR_UPNS.slice(), finance: FINANCE_UPNS.slice(), planners: PLANNER_UPNS.slice(), testers: TESTER_UPNS.slice() };
}

// Gate for the financial group (Invoice tab and any invoice data endpoints).
function requireFinance(user) {
  if (!user || !user.isFinance) {
    deny(user, 'You do not have permission to view this.');
  }
}

// Gate for the Project Planners group (Project Planning tab and its endpoints).
function requirePlanner(user) {
  if (!user || !user.isPlanner) {
    deny(user, 'You do not have permission to view this.');
  }
}

// Gate for the Testers group (in-progress test-only tabs and their endpoints).
function requireTester(user) {
  if (!user || !user.isTester) {
    deny(user, 'You do not have permission to view this.');
  }
}

// Gate for endpoints usable by either group -- e.g. the company directory,
// which both report-forwarding (editors) and plan-forwarding (planners) need
// for their recipient picker. Not every editor is a planner or vice versa.
function requireEditorOrPlanner(user) {
  if (!user || (!user.isEditor && !user.isPlanner)) {
    deny(user, 'You do not have permission to view this.');
  }
}

// Gate for the Expenses tab: cardholders submit, the Financial group approves.
function requireCardholderOrFinance(user) {
  if (!user || (!user.isCardholder && !user.isFinance)) {
    deny(user, 'You do not have permission to view this.');
  }
}

function authErrorResponse(e, context) {
  if (e instanceof AuthError) {
    if (e.status === 429) {
      // Surface rate-limit trips in Application Insights so scraping/abuse is
      // visible and alertable (actor only — no PII).
      try {
        context.log('RATE_LIMIT ' + JSON.stringify({ upn: e.upn || null, ts: new Date().toISOString() }));
      } catch (_) { /* logging must never break the response */ }
      return {
        status: 429,
        headers: { 'Retry-After': String(e.retryAfterSec || 60) },
        jsonBody: { error: e.message },
      };
    }
    if (e.status === 503) return { status: 503, headers: { 'Retry-After': '5' }, jsonBody: { error: e.message } };
    return { status: e.status, jsonBody: { error: e.message } };
  }
  context.error(e);
  return { status: 500, jsonBody: { error: 'Internal server error' } };
}

module.exports = { requireUser, requireEditor, requireFinance, requirePlanner, requireTester, requireEditorOrPlanner, requireCardholderOrFinance, requireAccessAdmin, requireAccessKnown, deny, azureAccessLists, AuthError, authErrorResponse };
