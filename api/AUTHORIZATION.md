# API Authorization, Rate Limiting & Audit

This describes the access model enforced by the `/api` Functions and how to
administer it.

## Access model

| Capability | Who |
|---|---|
| **Read** availability, crew calendar, and dispatch — **including client phone numbers** | Any signed-in `@jetcityit.com` user (techs need this to call/text on site) |
| **Submit / edit own** availability | Any signed-in tech (own record only) |
| **Reassign crew** on a job (`PUT /api/dispatch/jobs/{id}/crew`) | **Editors only** |
| **Clear a whole week's** availability (`DELETE /api/availability/{week}`) | **Editors only** |
| Edit **another** tech's availability | **Editors only** |

Enforcement is entirely server-side (in the Functions). The frontend may hide
controls for read-only users as a convenience, but that is not the security
boundary.

## Who is an "editor"?

A caller is treated as an editor if **either** is true:

1. **Entra App Role** — their token carries the `DataEditor` role (preferred;
   managed in the Entra portal, no code/redeploy to change who has it).
2. **`EDITOR_UPNS` app setting** — their email is in this comma-separated list
   (quick start / fallback; no app-registration change needed).

Everyone else is read-only. You can start with `EDITOR_UPNS` today and move to
App Roles later with no code change.

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
