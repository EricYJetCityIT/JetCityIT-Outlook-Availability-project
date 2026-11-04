# API Authorization, Rate Limiting & Audit

This describes the access model enforced by the `/api` Functions and how to
administer it.

## Access model

| Capability | Who |
|---|---|
| **Read** availability, crew calendar, and dispatch — **including client phone numbers** | Any signed-in `@jetcityit.com` user (techs need this to call/text on site) |
| **Refresh** the board from Smartsheet on demand (`POST /api/dispatch/refresh`) | Any signed-in `@jetcityit.com` user (read-only pull; runs the same sync the cron uses, guarded by the per-user rate limit) |
| **Submit / edit own** availability | Any signed-in tech (own record only) |
| **Send feedback / a suggestion** (`POST /api/feedback`, the header's Feedback button; stored in Cosmos as `feedback:<uuid>` and emailed to the team lead; sender identity comes from the sign-in token; about 10 per person per hour, counted in memory per server instance so it resets on restart; the stored items, with the sender's name and email, can be read by any editor) | Any signed-in `@jetcityit.com` user |
| **Read the feedback list / mark items done / delete an item / the count of unfinished ones** (`GET /api/feedback`, `GET /api/feedback?summary=1`, `PUT /api/feedback/{id}`, `DELETE /api/feedback/{id}`; shown in the Manager view's Feedback tab with a red count on the Manager view tab; delete removes the stored item for good, not the emailed copy; marking done can carry an optional note and, if the editor ticks it, one email to the sender saying it is done, never to an external address or to yourself). Regular techs can send feedback but can never read anyone's, including their own, once sent | **Editors only** (the same people who see the Manager view) |
| **Manage who has Editor / Finance / Planner / Tester access** (Manager view → Access tab: `GET /api/access`, `PUT /api/access`). People added there are stored in Cosmos (`access-config`) and ADDED to the Azure lists on every request (cached about 30 s per server instance); the people in the Azure settings are shown but can only be changed in Azure. A change reaches the server within about a minute and the person at their next page load. Only real changes are written and audit-logged (group + the people really added/removed). A person is matched by their **sign-in name** (the directory's `upn`), not their mail address. If Cosmos can't be read, the last good copy is used (retry every ~5 s, each read gives up after 2.5 s); with nothing cached the Azure lists alone apply, and a check that depends on the page lists answers **503 (try again)** instead of 403, so nobody is told "no" when it really means "couldn't check" | **Access admins only**: editors through Azure (`EDITOR_UPNS` or the Entra `DataEditor` role), narrowed to the people in the optional `ACCESS_ADMIN_UPNS` setting when that is set. Someone made an editor from the page cannot open or change this, so access can't be escalated from the page. **Every access admin can add themselves or anyone else to Finance, Planner and Tester**, so set `ACCESS_ADMIN_UPNS` if the Finance group must stay smaller than the editor group |
| **Reassign crew** on a job (`PUT /api/dispatch/jobs/{id}/crew`) | **Editors only** |
| **Mark crew inactive** — hide people who left from Assign crew, the Individual availability view and the weekly reminder (`PUT /api/dispatch/inactive-crew`; the list is one Cosmos doc, `crew-inactive`, laid over the synced roster on read — no one is deleted and Smartsheet is untouched) | **Editors only**. The roster from `GET /api/dispatch` marks them `active:false` for everyone; the raw list (`inactiveNames`) is only returned to editors |
| **Clear a whole week's** availability (`DELETE /api/availability/{week}`) | **Editors only** |
| Edit **another** tech's availability | **Editors only** |

Enforcement is entirely server-side (in the Functions). The frontend may hide
controls for read-only users as a convenience, but that is not the security
boundary.

## Who is an "editor"?

A caller is treated as an editor if **any** is true:

1. **Entra App Role** — their token carries the `DataEditor` role (preferred;
   managed in the Entra portal, no code/redeploy to change who has it).
2. **`EDITOR_UPNS` app setting** — their email is in this comma-separated list
   (quick start / fallback; no app-registration change needed).
3. **Added on the Manager view's Access tab** by an access admin (stored in the
   Cosmos doc `access-config`; see the access row in the table above).

Everyone else is read-only. You can start with `EDITOR_UPNS` today and move to
App Roles later with no code change. Only 1 and 2 make someone an access admin.

## Separate access groups (Invoice, Project Planners, Testers)

These groups gate their own tabs and are **independent** of editor status —
being an editor does not make someone a member, and vice versa, **except that an
access admin can add anyone (themselves included) from the Access tab** (see
`ACCESS_ADMIN_UPNS` above). Each group is a comma-separated list of
`@jetcityit.com` emails in an app setting **plus** anyone added on the Access
tab; if both are empty nobody is in the group and the tab stays hidden for
everyone.

| App setting | Grants | Frontend flag |
|---|---|---|
| `FINANCE_UPNS` | **Financial** tab — job / client profitability; cost rates and prices live in Cosmos `finance:settings`, never in code (`isFinance`, `requireFinance` on every `/api/finance/*` route) | `is-finance` body class reveals `#tab-invoice` |
| `PLANNER_UPNS` | **Project Planning** tab — the "Project Planners" group (`isPlanner`, `requirePlanner`) | `is-planner` body class reveals `#tab-planning` |
| `TESTER_UPNS` | **Job Sheets** + **Floor Maps** tabs — the "Testers" group for in-progress features (`isTester`, `requireTester`; every `/api/jobsheet/*` and `/api/floormaps/*` route, read and write, except the signed-url photo proxy and the secret-guarded `POST /api/jobsheet/rollup`, see "Scheduled endpoints" below) | `is-tester` body class reveals `#tab-jobsheet` + `#tab-floormap` |

Set them in the Static Web App → **Configuration** (application settings for the
managed Functions), e.g.:

```
PLANNER_UPNS = dylanm@jetcityit.com,someone@jetcityit.com
```

`GET /api/me` returns `{ upn, name, isEditor, isFinance, isPlanner, isTester, isAccessAdmin }`
(or 503 while the page-granted lists can't be read and the caller has no access at all, so the
browser keeps the role it already knew), which the frontend uses to reveal each tab. As always, the tab-hiding is only a UX aid — any data
endpoint behind these tabs must call `requireFinance` / `requirePlanner`
server-side to actually enforce the group.

## Floor Map client share links (the only no-sign-in data routes)

Testers create a link for ONE floor map (`POST /api/floormaps/{id}/shares`,
revoke with `DELETE …/shares/{token}`; both `requireTester`). The client opens
`share.html#t=<token>` with **no sign-in**; the page sends the token in the
`X-Share-Token` header to:

| Route | Needs link level |
|---|---|
| `GET /api/share`, `GET /api/share/image` | view |
| `POST /api/share/feedback` (comment) | comment |
| `POST /api/share/feedback` (approval) | approve |
| `POST /api/share/photo` | edit |

Each request checks the token exists, isn't revoked and hasn't expired, is
rate-limited per IP and per token, and is audit-logged as `share:<link name>`.
The payload is filtered server-side: identifier, photo and checkbox columns
(text columns only if the link allows notes); never Smartsheet ids, the
activity log, tech names or another link's feedback. Error messages are
generic (no internal error text). Tokens are 192-bit random and live only in
the URL fragment, so they don't reach server logs or Referer headers.

### Option A — quick start with `EDITOR_UPNS`

In the Static Web App → **Configuration** (application settings for the managed
Functions), add:

```
EDITOR_UPNS = dylanm@jetcityit.com,eric@jetcityit.com
```

Save. Those users can now change data; everyone else is read-only.

### Option B — Entra App Role (recommended long-term)

1. Entra admin center → **App registrations** → the crew-calendar app →
   **App roles** → **Create app role**:
   - Display name: `Data Editor`
   - Allowed member types: **Users/Groups**
   - Value: `DataEditor`  ← must match exactly
   - Description: "Can change dispatch/crew and clear availability."
2. **Enterprise applications** → same app → **Users and groups** → **Add user/group**
   → assign the `Data Editor` role to the few people who should have it (or a
   security group).
3. Done — their next token includes `"roles": ["DataEditor"]` and the API grants
   edit. No `EDITOR_UPNS` needed (though it still works as an override).

## Scheduled endpoints (shared secret, no sign-in)

Static Web Apps' managed Functions only run HTTP triggers, so the scheduled jobs
are plain `POST` endpoints called by GitHub Actions cron workflows
(`.github/workflows/*-schedule.yml`). They send the `SYNC_SECRET` app setting in an
`X-Sync-Secret` header, compared in constant time; a missing or wrong secret is a
401 and an unset `SYNC_SECRET` rejects everything. Anyone holding that one secret
can trigger all of these, so treat it like a password.

| Route | What it does | Workflow |
|---|---|---|
| `POST /api/smartsheet-sync` | Mirrors the Crew Calendar sheet into Cosmos | `smartsheet-sync-schedule.yml` |
| `POST /api/report-match` | Ticks "Proj Rpt Rec'd" for filed reports | `smartsheet-sync-schedule.yml` |
| `POST /api/availability-reminder` | Emails techs who haven't submitted availability (`?dry=1` reports who would be emailed, including names/emails, and sends nothing) | `availability-reminder-schedule.yml` |
| `POST /api/jobsheet/rollup` | Nightly per-tech per-day rollup of the Job Sheets / Floor Maps activity log (replies with day counts only; failure details go to the function log) | `jobsheet-rollup-schedule.yml` |
| `POST /api/feedback-digest` | Weekly (Monday) email to the team lead listing site feedback nobody has marked done; sends nothing when none is open (replies with counts only; `FEEDBACK_DIGEST_TO` overrides the recipient) | `feedback-digest-schedule.yml` |

The rollup feeds `GET /api/jobsheet/techtracking` (the Manager view's **Tech
tracking** tab), which is **Testers-only** (`requireTester`) and returns per-tech
pace and time data. The tab stays correct even if the nightly job never runs
(missing days are built on demand); the job only keeps reads fast. Reads reach back
at most two years. `GET /api/jobsheet/techday?user=&day=` (also **Testers-only**)
returns one tech's day as a time-ordered list of item visits for the tab's day
timeline; it reads that day's raw log on request and saves nothing.

**Completed By (Smartsheet).** When a tester ticks a job sheet's done checkbox
(`POST /api/jobsheet/cell`) or, on a photo-only sheet, adds the photo
(`POST /api/jobsheet/photo-upload`), the server writes their sign-in display name
to a "Completed By" text column on that row; unticking clears it, and whoever
ticks last wins. "Done" is the same column the viewer's progress bar uses. The
column is added to the sheet the first time it's needed, which needs Admin on that
sheet; if the app's Smartsheet token can't add columns the stamp is skipped (retry
after 10 minutes) and nothing is shown to the tech. A failure never fails the
tech's own save. The text column is hidden from the Job Sheets / Floor Maps viewer
and is never part of a client share link, since it holds tech names. A same-named
picklist / contact / date column that someone made by hand is left alone (not
written, still shown).

## Rate limiting (anti-scraping)

`requireUser` applies a per-user fixed-window limit (default **120 requests/min**
per signed-in identity) and returns **429** with a `Retry-After` header when
exceeded. This caps how fast any one account — or a leaked token — can pull data.
It is in-memory (per Function instance); if the app is scaled to multiple
instances, move the counter to Azure Cache for Redis or a Cosmos TTL container.
See `src/lib/ratelimit.js`.

## Audit logging

Writes, permission denials, and sensitive actions emit a structured
`AUDIT {...}` line to Application Insights (`src/lib/audit.js`) — actor + action
+ resource ids only, never the PII values. Query these to spot abnormal access,
e.g. a user reading an unusual volume of dispatch data, and alert on it.

## Optional: hide edit controls for read-only users (frontend)

A `GET /api/me` endpoint returns `{ upn, name, isEditor }`. After sign-in, the
app can call it and hide/disable "change crew" controls when `isEditor` is false,
so techs don't see a control that would 403. Sketch:

```js
const meRes = await fetch('/api/me', { headers: { 'X-Jetcity-Authorization': 'Bearer ' + await getApiToken() } });
const me = await meRes.json();
if (!me.isEditor) document.body.classList.add('read-only'); // CSS hides .editor-only controls
```

## Testing

- **As an editor** (in `EDITOR_UPNS` or with the role): reassign crew and clear a
  week → succeed (200).
- **As a plain tech**: reassign crew / clear a week → **403**; submit *own*
  availability → 200; submit *another* name's availability → **403**; read
  dispatch (phone numbers) → 200.
- Hammer any endpoint > 120x/min → **429**.
- **Access tab**: as an access admin, add someone to Testers → they get Job Sheets after a
  reload (within about a minute); remove them → the tab is gone and `/api/jobsheet/*` is 403.
  As an editor who was only added from the page: no Access tab, `/api/access` is **403**.
  As a plain tech: `/api/access` is **403**.
