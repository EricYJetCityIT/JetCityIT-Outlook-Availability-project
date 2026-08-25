# Invoice tab + QuickBooks — integration plan

Planning doc (2026-08-25). No code written yet. Goal: turn the placeholder
**Invoice** tab into an "invoiced vs not-invoiced" board that mirrors the
Manager **Project reports** view, but sourced from QuickBooks instead of a
Smartsheet checkbox.

The Invoice tab and its data endpoints stay gated to the **financial group**
(`FINANCE_UPNS` / `requireFinance`, already wired in `api/src/lib/auth.js`).

## The end result (what we're building toward)

For the selected week, render the same job-card board as Project reports, but
each card tinted by **invoice status** instead of report status:

| Tint | Meaning |
|---|---|
| 🔴 Red | Job done, **no invoice** found in QuickBooks yet |
| 🟡 Amber | Invoice exists but **still open** (unpaid balance) |
| 🟢 Green | Invoice exists and **paid** (balance = 0) |

A pie/summary above the board (reuse `reportPieSvg`, extended to 3 slices)
shows the period's split. Clicking a job shows its invoice detail (customer,
invoice #, date, amount, balance, link back to QBO). This is strictly
**read-only** — we surface QB data, we never write invoices from the app.

The paid/open dimension is a bonus the Project reports view doesn't have — it
comes free from the invoice's `Balance` field.

**UI decisions (confirmed 2026-08-25, mockup approved):**
- **Period toggle: Week / Month.** Default is fine either way; Month rolls the
  jobs up under weekly section headers (a full month-calendar grid is too dense
  at the app's width) with a monthly summary + dollar totals. Both periods hit
  the same `/api/invoices?from=&to=` with a wider range for Month.
- **"Not invoiced only" filter** — a toggle that collapses the board to just the
  🔴 jobs (with a live count). This is the billing punch-list; consider making it
  the **default on** for the finance group.
- **No dollar amounts on the job cards.** Cards show name, date, status pill
  only. Amounts appear in the **summary strip** and the **detail panel** — so a
  glance at the board doesn't broadcast per-job revenue.
- Detail panel for a 🔴 job shows "— none found —" for the invoice and offers a
  **"Create in QuickBooks"** deep link (opens QBO's new-invoice screen prefilled
  where possible; we still never write from the app).

## Step 0 — confirm the QuickBooks edition (blocks everything)

- **QuickBooks Online** — browser login at `qbo.intuit.com`, subscription.
  Has a first-class REST API. **Direct integration works.** (Plan below assumes
  this.)
- **QuickBooks Desktop** — installed Windows app, company `.QBW` file. **No
  cloud API.** Would need the QB Web Connector (SOAP, on the machine running QB)
  or a paid middleware (e.g. Codat/Rutter) to expose invoices. Much heavier.
  If we're on Desktop, the realistic path is a nightly export of open/closed
  invoices to a Smartsheet/CSV that the app reads — same UI, different pipe.

Everything below is the **QuickBooks Online** path.

## Step 1 — QuickBooks Online app + OAuth (the plumbing)

QBO's API is OAuth2, server-to-server. One-time setup:

1. In the **Intuit Developer** portal, create an app → get **Client ID** +
   **Client Secret**. Enable the `com.intuit.quickbooks.accounting` scope.
2. Do the OAuth **authorization-code** dance **once** (I can host a tiny local
   callback for this) to mint the first **refresh token** and capture the
   **Realm ID** (the QBO company id).
3. Store in **Azure app settings** (never the repo — per the privacy rule):
   `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REFRESH_TOKEN`, `QBO_REALM_ID`,
   `QBO_ENV` (`sandbox`|`production`).

**Token lifecycle (the one gotcha):**
- Access token lives ~1 hour → the Function refreshes it on demand from the
  refresh token; cache it in-memory like the Graph token in `graph.js`.
- **Refresh token rotates** on each refresh and expires after ~100 days of
  disuse. Because Azure app settings are read-only at runtime, we can't easily
  persist the rotated refresh token back. Two options:
  - **A (simplest):** stash the current refresh token in **Cosmos** (we already
    have `cosmos.js`) and update it on every refresh. Survives restarts.
  - **B:** re-mint by hand every few months. Fine for low volume, but it *will*
    silently break the tab when it lapses. Prefer A.

Build against the **sandbox** company first, flip `QBO_ENV` to production later.

## Step 2 — the matching problem (job → invoice)

Smartsheet jobs are keyed `ss-<rowid>` with `client`, `project`, `date`
(see `smartsheet.js` transform). QBO invoices have `CustomerRef`, `TxnDate`,
`DocNumber`, `TotalAmt`, `Balance`, plus `CustomerMemo` / `PrivateNote` /
`LinkedTxn`. **There is no shared key today.** Pick the linking strategy:

- **Customer + service date (zero process change, fuzzy).** Match QBO Customer
  name ≈ Smartsheet `client`, invoice `TxnDate` within ±N days of the job date.
  Cheapest to ship; breaks on same-week repeat customers and name spelling
  drift. Good enough for a v1 "is *anything* invoiced for this client this week"
  signal.
- **Stamp the Job # on the invoice (exact, recommended long-term).** Staff put
  the job's `project` name (or the `ss-<rowid>`) into the invoice **Memo** or
  **PO/Custom field** when they create it. The Function matches on that string.
  Reliable, but needs a small billing habit change. Best to adopt this from day
  one if the team will do it.
- **Whatever the current habit is.** If invoices already reference the job
  (a PO number, a memo convention), match on that — tell me the convention and
  I'll target it.

Recommendation: ship v1 on **Customer + date** so there's something usable
immediately, and layer in **Memo/Job#** matching as the team adopts it — the
two can coexist (prefer an exact Job# hit, fall back to customer+date).

## Step 3 — backend `GET /api/invoices`

New Function, modeled on `report.js`:

- `authLevel: 'anonymous'` → `requireUser` then **`requireFinance(user)`**.
- Params: `from`/`to` range — the frontend passes a 7-day span for Week and the
  full-month span for Month, so the same endpoint serves both period toggles.
- Get a fresh QBO access token (refresh + in-memory cache).
- Query invoices:
  `SELECT Id, DocNumber, TxnDate, CustomerRef, TotalAmt, Balance, PrivateNote
   FROM Invoice WHERE TxnDate >= '<from>' AND TxnDate <= '<to>'` (QBO's
  SQL-ish query endpoint; paginate if needed — a month can exceed the 1000-row
  page cap).
- Return a slim list: `{ customer, docNumber, date, amount, balance,
  status: 'paid'|'open', memo }`. No raw QBO payloads to the client. (Amounts
  are still returned — the board just doesn't *render* them; the summary totals
  and detail panel need them.)
- Cache each range's result in-memory ~5–15 min (like `/api/directory`).

New lib `api/src/lib/quickbooks.js` (parallel to `smartsheet.js`): token
refresh, the `query()` helper, and the job↔invoice matcher.

## Step 4 — frontend (Invoice tab)

Reuse the Project-reports machinery in `index.html` (`JCITDispatch` module):

- Replace the placeholder in `#view-invoice` (currently `index.html:646-649`).
- Add an invoice `colorMode` to `jobCardHtml`/`boardHtml` (red/amber/green from
  invoice status). In this mode the card renders **no amount** — name, date, and
  a status pill only. Reuse `reportPieSvg` (extended to 3 slices) for the summary.
- **Period toggle (Week / Month):** Week reuses `weekDates()`/`boardHtml` as-is;
  Month groups the range's jobs under weekly section headers (don't attempt a
  dense month-calendar grid). One shared range-fetch feeds both.
- **"Not invoiced only" toggle:** a client-side filter that renders only 🔴 jobs
  (all data's already loaded — no refetch) with a live count. Consider defaulting
  it **on**. Amounts stay hidden here too.
- Fetch `/api/invoices?from=&to=` with the same bearer-header pattern as the
  other authed calls; cross-reference against the dispatch jobs already loaded.
- Job click → invoice detail panel (customer, #, date, **amount, balance** — the
  one place amounts show), a deep link
  `https://qbo.intuit.com/app/invoice?txnId=<Id>` for invoiced jobs, and a
  **"Create in QuickBooks"** deep link for 🔴 not-invoiced jobs.

The tab visibility is already handled: `body.is-finance #tab-invoice` +
the `switchTab`/`currentUserIsFinance` guard (`index.html:1172`).

## Rollout order

1. Confirm Online vs Desktop.
2. (Online) Register Intuit app, run one-time OAuth, load Azure settings,
   test token refresh against **sandbox**.
3. Ship `/api/invoices` returning raw invoices for a week (no matching yet) —
   verify the finance group can read it.
4. Add job↔invoice matching (customer+date first).
5. Wire the Invoice tab UI (board + 3-slice pie + detail; Week/Month toggle;
   "Not invoiced only" filter; amounts off the board).
6. Decide on the Job#-on-invoice habit; add exact matching.
7. Flip `QBO_ENV=production`.

## Open questions for later

- Online or Desktop? (gates the whole approach)
- Matching key: customer+date, or adopt a Job#/memo convention?
- Do you want the **paid/open** dimension, or just invoiced/not?
- Refresh-token persistence: Cosmos (recommended) vs manual re-mint.
