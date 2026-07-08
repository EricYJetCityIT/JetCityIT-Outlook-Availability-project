# Jet City IT — Team Availability App: Project Notes

---

## ✅ Completed Features

- Tech slot submission with drag-to-paint (6am–9pm, Mon–Fri)
- Manager heatmap view + individual per-user color-coded view
- Compact sticky week picker bar with year button and week label
- Single-month Google Calendar-style dropdown picker
- Week selection highlights Mon–Fri with circular cap styling
- Today button
- Jet City IT logo centered above tabs (160px)
- localStorage persistence per week per user
- Responsive layout, mobile touch support
- Holiday highlighting (e.g. Independence Day auto-marked pink/unavailable on July 3–4)
- Microsoft Login via MSAL.js (Azure AD / Entra ID) — techs sign in with their @jetcityit.com account
- Auto-fill tech name from Microsoft account on login
- Calendar sync to shared mailbox `crewavailability@jetcityit.com` via Microsoft Graph API
  - Available blocks → `[JCIT] {Name} — Available` events (green category)
  - Unavailable blocks → `[JCIT] {Name} — Unavailable` events (red category)
  - Old events for the tech/week are deleted and replaced on each save
  - Contiguous blocks merged into single events (no per-slot spam)
  - Events created one at a time (sequential, not parallel) to prevent throttling/partial failures
  - calendarView deletion query uses explicit UTC timestamps covering full Mon–Sun to ensure Friday evening events (which land in UTC on Saturday) are always found and cleaned up
  - Always syncs exactly 5 days (Mon–Fri) regardless of what is in localStorage, preventing missing Friday events from stale saved data

---

## 🚀 Live Deployment

- **GitHub Pages URL:** https://ericyjetcityit.github.io/JetCityIT-Outlook-Availability-project/
- **Repo:** https://github.com/EricYJetCityIT/JetCityIT-Outlook-Availability-project
- Deploy from: `main` branch / root — auto-deploys on every push

---

## 🔷 Azure AD App Registration

| Field | Value |
|---|---|
| Client ID | `b367d366-39f5-4fdc-a5e9-9d634ca37b5e` |
| Tenant ID | `a2b534e7-8d8b-4c5f-ae4b-5076fd677ff4` |
| Redirect URI | `https://ericyjetcityit.github.io/JetCityIT-Outlook-Availability-project/` |

### API Permissions (Delegated — Admin Consent Granted)

| Permission | Purpose |
|---|---|
| `User.Read` | Get signed-in user's name/email |
| `Calendars.ReadWrite` | Read/write signed-in user's own calendar |
| `Calendars.ReadWrite.Shared` | Read/write shared mailbox calendar (`crewavailability@jetcityit.com`) |

### Category Colors (green/red) — Status
- The app attempts to auto-create `JetCityIT-Available` (green, preset4) and `JetCityIT-Unavailable` (red, preset0) categories on the shared mailbox at save time
- If `MailboxSettings.ReadWrite` is granted via Azure (see below), colors apply automatically
- If not granted, events still show correctly with correct labels — just may appear in default Outlook grey instead of green/red

### Optional: Add MailboxSettings.ReadWrite for automatic color setup
- Steps: Azure Portal → App Registrations → the app → API Permissions → Add permission → Microsoft Graph → Delegated → `MailboxSettings.ReadWrite` → Grant admin consent

---

## 📬 Shared Mailbox Setup

- **Shared mailbox:** `crewavailability@jetcityit.com`
- Exchange Full Access granted to all techs (set in Exchange Admin Center)
- Calendar folder permission set via PowerShell (Exchange Online):
  ```powershell
  Add-MailboxFolderPermission -Identity "crewavailability@jetcityit.com:\Calendar" -User ericy@jetcityit.com -AccessRights Editor
  ```
- View the shared calendar in Outlook Web: File → Open another mailbox → `crewavailability@jetcityit.com`

---

## 🐛 Bug Fixes Log (Calendar Sync)

| Commit | What was fixed |
|---|---|
| `b65b538` | Logic inversion: code was creating "Available" events for *unavailable* slots and vice versa — one character fix (`!daySlots.has`) |
| `6582143` | Available blocks for fully-available days never terminated — loop reached `s=N` with `inBlock=true` so the block never closed and no event was created; also changed `showAs` back to `'busy'` so events show as solid blocks |
| `0036bb9` | Added Unavailable (red) events — previously only Available events were pushed; now both types are created per save |
| `0db9d8e` | calendarView query used bare `T00:00:00` (no timezone) causing Friday evening events (which are Saturday UTC) to fall outside the cleanup range and pile up; also switched all event DELETEs and POSTs from `Promise.all` (parallel) to sequential `for` loops to prevent partial failures from API throttling |
| `9ca14d0` | Friday events silently skipped when localStorage had stale data with fewer than 5 days — `forEach` would stop before Friday; fixed by always forcing exactly 5 days with `Array.from({length:5})` and using UTC-offset date math instead of local `setDate()` |

---

## 🔧 Pending Features

### Admin Accounts
- Add **4 admin account slots**
- Each admin account should support **2FA**, with the following options:
  - **Option 1:** Outlook email authentication
  - **Option 2:** Phone number authentication

### Green/Red Category Colors in Outlook
- Requires Dylan to add `MailboxSettings.ReadWrite` permission to the Azure App (see above)
- Once granted, the app will auto-create `JetCityIT-Available` (green) and `JetCityIT-Unavailable` (red) categories on the shared mailbox on first save

### Cross-Device Data Sharing
- Current: `localStorage` = per-device only
- Options: Firebase Realtime DB (free tier), Supabase, or SQLite on office PC

---

## 🖥️ Hosting Plan — Office Mini PC (Future)

The app can be self-hosted on a mini computer in the office instead of GitHub Pages.

### Suggested Stack

| Layer | Tool | Why |
|---|---|---|
| Web server | **Caddy** | Auto HTTPS, simple config |
| Database | **SQLite** | Lightweight, no setup, runs locally |
| Backend | **Node.js** or **Python/Flask** | Small footprint, runs well on mini PCs |
| Remote access | **Tailscale** | Free VPN, zero config, very secure |
| Backups | **Windows Task Scheduler** or cron | Automated, hands-off |

---

## 🔒 Security Recommendations

### Network & Hosting
- Keep the app on the **local network (LAN) only** — do not expose directly to the internet without protection
- Use a **reverse proxy** (Nginx or Caddy) on the mini PC — handles HTTPS, rate limiting, hides raw port
- **Enable HTTPS** with a self-signed cert, or use Caddy (handles this automatically)
- Set a **static local IP** for the mini PC (e.g. `192.168.1.50`) so the link never changes

### Access Control
- Build the **4 admin accounts with 2FA** before going live
- **Lock the manager view behind a password** — currently anyone with the link can see the heatmap
- **Whitelist by IP** — configure the server to only accept connections from the office Wi-Fi/LAN range

### Data
- **Move away from localStorage** before go-live — it's per-device and has no access control
- Use **SQLite + a small Node/Python server** on the mini PC for secure, persistent storage
- **Schedule automatic backups** of availability data to a USB drive or cloud folder

### Physical Security
- Run the mini PC under a **limited service account** (not an admin user)
- **Keep the OS updated** — enable auto-updates for security patches
