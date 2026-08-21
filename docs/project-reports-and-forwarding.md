# Project Reports tab & report forwarding

Reference for the Manager-view **Project reports** feature and the
forward-report-by-email flow. Added 2026-08-18.

## What it does

In **Manager view → Project reports** (editor-only):

- The selected week's jobs render on the same board layout, each card tinted
  **green** (Daily Project Report received) or **red** (missing), with a status
  pill. Cancelled jobs are dimmed and excluded from the counts.
- A **pie chart** above the board shows submitted vs missing for the week.
- Clicking a job whose report is in exposes **View report** — the submitted
  report rendered inline (empty fields omitted).
- From View report, **Forward to POC** emails a formatted copy:
  - Each field has a **checkbox** (all ticked by default, with All/None) so you
    choose which fields to include.
  - A **searchable recipient box** lists known **client contacts** (from the
    "Client Mover" column) and **JCIT staff** (company directory), or type any
    address. Prefilled with the job's client email when there is one.
  - The **job photos are attached** (auto-downscaled so they fit).
  - The email is sent **from the signed-in editor's own mailbox**, laid out like
    the Smartsheet report.

## Key dependency: the hidden Job ID

Auto-check, View report, and Forward all rely on the report being linked to its
calendar job. That link is the hidden **"Job ID"** field (`ss-<rowid>`) that the
app's **"📝 Daily report"** button stamps onto the form. Reports filed from a
bookmarked blank form carry no Job ID, so they are **not** viewable/forwardable
and won't auto-tick. Push crews to file via the in-app button.

Green vs viewable: a card is green when the sheet's "Proj Rpt Rec'd" box is
ticked (however it got ticked); View report only finds reports that carry the
Job ID. A manually-ticked green may show "No submitted report is linked."

## How it's built

Frontend: `index.html` (all inside the `JCITDispatch` module) —
`reportsViewHtml`/`reportPieSvg` (tab + pie), `viewReport` (modal + per-field
checkboxes), `forwardReport` (recipient picker), `fetchReport`/`sendReportEmail`/
`fetchDirectory`/`allClientEmails`. Job cards get report tint via a `colorMode`
arg to `jobCardHtml`/`boardHtml`.

Backend (`api/src/functions` + `lib`):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/report?jobId=ss-<id>` | any signed-in | Fetch a job's submitted report (Smartsheet search + rowIds read, matched on Job ID). Returns ordered `{label,value}` fields (+ attachment metadata). |
| `POST /api/send-report` `{jobId,to,include?}` | **editor** | Build the HTML, attach compressed photos, send from `user.upn`'s mailbox. `include[]` = field labels to keep. |
| `GET /api/directory` | **editor** | Company user list (name+email) for the recipient picker. In-memory cached 1h. |

- `smartsheet.js`: `reportReceived` (from "Proj Rpt Rec'd") and `clientMover`
  (`{name,email}`, from the "Client Mover" contact) added to each job in the
  dispatch transform; `fetchReportByJobId` and `fetchAttachmentBytes` added.
- `graph.js`: `sendMail` takes optional inline `attachments`; `listUsers` powers
  the directory.
- Photos are compressed with **jimp** (≤1600px, JPEG q72) and attached **inline**
  so the whole send stays under Graph's ~4MB `/sendMail` cap. This keeps the app
  on **Mail.Send only** — no `Mail.ReadWrite` (which the draft+upload-session
  path would have needed).

## Permissions & config (Azure)

- App registration "JetCity Availability App": app-only **Mail.Send** and
  **User.Read.All** (both already granted; shared with the availability
  reminder). No delegated Graph scopes were added.
- App settings: `REPORT_SHEET_ID`, `MAIL_CLIENT_SECRET` (client secret for the
  app-only Graph token), plus the existing `SMARTSHEET_*`, `AAD_*`, `EDITOR_UPNS`.

## Notes / limits

- `reportReceived` and `clientMover` only populate in Cosmos after a Smartsheet
  sync runs the transform — force a sync (`/api/smartsheet-sync?force=true`)
  after deploying transform changes.
- Photos are downscaled (fine for a report); bump the size in
  `sendReport.js` `compressPhoto` if sharper is needed, at the cost of fewer
  fitting per email.
- Recipient search filters mostly on the email text (native `<datalist>`).
