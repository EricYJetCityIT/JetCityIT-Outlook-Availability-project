# Jet City IT — Team Availability App: Project Notes

---

## ✅ Completed Features
- Tech slot submission with drag-to-paint (8am–6pm, Mon–Fri)
- Manager heatmap view + individual per-user color-coded view
- Compact sticky week picker bar with year button and week label
- Single-month Google Calendar-style dropdown picker
- Week selection highlights Mon–Fri with circular cap styling
- Today button
- Jet City IT logo centered above tabs (160px)
- localStorage persistence per week per user
- Responsive layout, mobile touch support

---

## 🔧 Pending Features

### Admin Accounts
- Add **4 admin account slots**
- Each admin account should support **2FA**, with the following options:
  - **Option 1:** Outlook email authentication
  - **Option 2:** Phone number authentication

### Holiday Highlighting
- Add the ability to **highlight days that are Holidays**
  - Holidays should be visually distinct on the calendar/schedule grid
  - (To be decided: US federal holidays auto-populated, or manual entry by admin?)

---

## 🚀 Deployment / Integration (Pending)

### Microsoft Login (Azure AD / Entra ID)
- Requires: App Registration in Azure Portal, Client ID, Tenant ID, Redirect URI (Netlify URL)
- Implementation: MSAL.js embedded in HTML — no backend needed
- Will auto-fill tech name from logged-in account

### Cross-Device Data Sharing
- Current: `localStorage` = per-device only
- Options: Firebase Realtime DB (free tier), or Supabase

### Netlify Deployment
- Steps: Go to netlify.com → drag-and-drop `index.html` → get free HTTPS URL

---

## 🖥️ Hosting Plan — Office Mini PC

The app will be self-hosted on a mini computer in the office.

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

---

## 🔗 Shareable Employee Link

Two options depending on whether employees are office-only or also remote:

### Option A — Office/LAN Only (Simpler & More Secure)
- Employees connect to office Wi-Fi and visit:
  - `http://jetcity-schedule.local` (friendly name via mDNS/Bonjour)
  - or `http://192.168.1.50:3000` (direct IP)
- No internet exposure at all
- Best if staff always submit from the office

### Option B — Remote Access (For Work-From-Home/On-the-Road)
- Use **Tailscale** (free for small teams)
  - Employees install the Tailscale app on any device
  - Creates a secure tunnel back to the office network
  - They visit the same local URL from anywhere
  - No firewall ports need to be opened
  - Works on Windows / Mac / iOS / Android
