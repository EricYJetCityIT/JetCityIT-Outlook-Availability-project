import { useState } from "react";

// ─── Hardcoded admin accounts ──────────────────────────────────────────────
// TODO before go-live:
//   1. Replace placeholder passwords with strong unique ones
//   2. Replace phone numbers with real numbers
//   3. Swap the simulated SMS (generateCode) for a real Twilio call
//   4. Move credentials out of source code into a config file or env vars

const ACCOUNTS = [
  { username: "admin1", password: "JetCity!1", phone: "***-***-1001", name: "Admin 1" },
  { username: "admin2", password: "JetCity!2", phone: "***-***-1002", name: "Admin 2" },
  { username: "admin3", password: "JetCity!3", phone: "***-***-1003", name: "Admin 3" },
  { username: "admin4", password: "JetCity!4", phone: "***-***-1004", name: "Admin 4" },
];

// ─── Non-admin user slots ──────────────────────────────────────────────────
// 20 placeholder tech accounts. Admins can activate and rename these from
// the dashboard. Inactive accounts cannot log in to the schedule app.
// username / password follow the same pattern — swap before go-live.

const INITIAL_USERS = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  username: `user${String(i + 1).padStart(2, "0")}`,
  password: `JetCity#${String(i + 1).padStart(2, "0")}`,
  name: `User ${String(i + 1).padStart(2, "0")}`,
  active: false,
}));

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── Login step ────────────────────────────────────────────────────────────
function LoginStep({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  function handleLogin() {
    const acct = ACCOUNTS.find(
      (a) => a.username === username.trim().toLowerCase() && a.password === password
    );
    if (!acct) {
      setError(true);
      return;
    }
    setError(false);
    const code = generateCode();
    onSuccess(acct, code);
  }

  return (
    <div style={styles.stepWrap}>
      <div style={styles.title}>Admin sign in</div>
      <div style={styles.subtitle}>Enter your credentials to access admin tools</div>

      {error && <div style={styles.errorBox}>Incorrect username or password.</div>}

      <label style={styles.label}>Username</label>
      <input
        style={styles.input}
        type="text"
        value={username}
        onChange={(e) => { setUsername(e.target.value); setError(false); }}
        onKeyDown={(e) => e.key === "Enter" && handleLogin()}
        placeholder="e.g. admin1"
        autoComplete="off"
      />

      <label style={styles.label}>Password</label>
      <input
        style={styles.input}
        type="password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); setError(false); }}
        onKeyDown={(e) => e.key === "Enter" && handleLogin()}
        placeholder="••••••••"
        autoComplete="off"
      />

      <button style={styles.btnPrimary} onClick={handleLogin}>
        Continue →
      </button>
    </div>
  );
}

// ─── SMS verification step ─────────────────────────────────────────────────
function SmsStep({ code, onSuccess, onBack }) {
  const [entered, setEntered] = useState("");
  const [error, setError] = useState(false);

  function handleVerify() {
    if (entered.trim() !== code) {
      setError(true);
      return;
    }
    setError(false);
    onSuccess();
  }

  return (
    <div style={styles.stepWrap}>
      <div style={styles.title}>Verify your identity</div>
      <div style={styles.subtitle}>A code has been sent to the phone number on file.</div>

      {/* Dev-mode code display — remove or hide in production */}
      <div style={styles.smsBox}>
        <div style={styles.smsLabel}>Your verification code (dev mode)</div>
        <div style={styles.smsCode}>{code.split("").join(" ")}</div>
        <div style={styles.smsHint}>
          In production, this would be sent by SMS. Shown here for testing.
        </div>
      </div>

      {error && <div style={styles.errorBox}>Incorrect code. Please try again.</div>}

      <label style={styles.label}>Enter 6-digit code</label>
      <input
        style={styles.input}
        type="tel"
        value={entered}
        onChange={(e) => { setEntered(e.target.value); setError(false); }}
        onKeyDown={(e) => e.key === "Enter" && handleVerify()}
        placeholder="123456"
        maxLength={6}
        autoComplete="off"
      />

      <button style={styles.btnPrimary} onClick={handleVerify}>
        Verify &amp; sign in
      </button>
      <button style={styles.btnGhost} onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}

// ─── Admin dashboard ───────────────────────────────────────────────────────
function Dashboard({ currentUser, onLogout }) {
  const [users, setUsers] = useState(INITIAL_USERS);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");

  function toggleActive(id) {
    setUsers((prev) =>
      prev.map((u) => (u.id === id ? { ...u, active: !u.active } : u))
    );
  }

  function startRename(user) {
    setEditingId(user.id);
    setEditName(user.name);
  }

  function commitRename(id) {
    const trimmed = editName.trim();
    if (trimmed) {
      setUsers((prev) =>
        prev.map((u) => (u.id === id ? { ...u, name: trimmed } : u))
      );
    }
    setEditingId(null);
  }

  const activeCount = users.filter((u) => u.active).length;

  return (
    <div style={{ ...styles.stepWrap, maxWidth: 560 }}>
      <button style={styles.logoutBtn} onClick={onLogout}>
        Sign out
      </button>

      <div style={styles.badge}>
        <span style={styles.badgeDot} />
        Signed in as {currentUser.username}
      </div>

      <div style={styles.title}>Admin panel</div>
      <div style={styles.subtitle}>Manage team accounts and settings</div>

      {/* ── Admin accounts ── */}
      <div style={styles.sectionLabel}>Admin accounts</div>
      <div style={styles.accountGrid}>
        {ACCOUNTS.map((acct) => (
          <div
            key={acct.username}
            style={{
              ...styles.accountCard,
              ...(acct.username === currentUser.username ? styles.accountCardActive : {}),
            }}
          >
            <div style={styles.accountName}>{acct.name}</div>
            <div style={styles.accountUsername}>{acct.username}</div>
            <div style={styles.accountPhone}>{acct.phone}</div>
            <div style={styles.accountStatus}>
              <span style={styles.statusDot} />
              {acct.username === currentUser.username ? "Signed in" : "Active"}
            </div>
          </div>
        ))}
      </div>

      {/* ── Tech user slots ── */}
      <div style={{ ...styles.sectionLabel, marginTop: 24 }}>
        Tech user slots
        <span style={styles.sectionCount}>{activeCount} / {users.length} active</span>
      </div>

      <div style={styles.userTable}>
        {/* header */}
        <div style={styles.userRowHeader}>
          <span style={{ flex: "0 0 36px" }}>#</span>
          <span style={{ flex: 1 }}>Display name</span>
          <span style={{ flex: "0 0 80px", textAlign: "center" }}>Status</span>
          <span style={{ flex: "0 0 110px", textAlign: "right" }}>Actions</span>
        </div>

        {users.map((user) => (
          <div
            key={user.id}
            style={{
              ...styles.userRow,
              ...(user.active ? styles.userRowActive : styles.userRowInactive),
            }}
          >
            <span style={{ flex: "0 0 36px", color: "#8A93A2", fontSize: 12 }}>
              {String(user.id).padStart(2, "0")}
            </span>

            {/* name / rename input */}
            <span style={{ flex: 1 }}>
              {editingId === user.id ? (
                <input
                  style={styles.renameInput}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(user.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  autoFocus
                />
              ) : (
                <span style={{ fontSize: 13, color: user.active ? "#0F1724" : "#8A93A2" }}>
                  {user.name}
                </span>
              )}
            </span>

            {/* status badge */}
            <span style={{ flex: "0 0 80px", textAlign: "center" }}>
              <span style={user.active ? styles.pillActive : styles.pillInactive}>
                {user.active ? "Active" : "Inactive"}
              </span>
            </span>

            {/* actions */}
            <span style={{ flex: "0 0 110px", textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
              {editingId === user.id ? (
                <>
                  <button style={styles.actionBtn} onClick={() => commitRename(user.id)}>Save</button>
                  <button style={styles.actionBtnGhost} onClick={() => setEditingId(null)}>✕</button>
                </>
              ) : (
                <>
                  <button style={styles.actionBtnGhost} onClick={() => startRename(user)}>Rename</button>
                  <button
                    style={user.active ? styles.actionBtnDeactivate : styles.actionBtn}
                    onClick={() => toggleActive(user.id)}
                  >
                    {user.active ? "Deactivate" : "Activate"}
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      <div style={styles.infoNote}>
        <strong>Before go-live:</strong> Replace placeholder passwords and phone numbers,
        enable real SMS via Twilio, and move credentials out of the source file.
        Renaming and activation changes here are in-memory only — wire them to your
        database (SQLite / Firebase) when you add persistence.
      </div>
    </div>
  );
}

// ─── Admin button + modal ─────────────────────────────────────────────────
// Drop <AdminPanel /> once inside your root component. It renders a floating
// button fixed to the top-right of the page that opens the admin panel as a
// modal overlay — no tab integration required.
//
// Usage: import AdminPanel from "./admin-panel";
//        <AdminPanel /> inside your root App component.

export default function AdminPanel() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState("login");
  const [currentUser, setCurrentUser] = useState(null);
  const [smsCode, setSmsCode] = useState(null);

  function handleOpen() { setOpen(true); }
  function handleClose() { setOpen(false); }

  function handleLoginSuccess(acct, code) {
    setCurrentUser(acct);
    setSmsCode(code);
    setStep("sms");
  }

  function handleVerifySuccess() { setStep("dashboard"); }
  function handleBack() { setStep("login"); }

  function handleLogout() {
    setCurrentUser(null);
    setSmsCode(null);
    setStep("login");
    setOpen(false);
  }

  return (
    <>
      {/* ── Floating button (top-right) ── */}
      <button
        style={styles.floatBtn}
        onClick={handleOpen}
        title="Admin panel"
        aria-label="Open admin panel"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="8" r="4"/>
          <path d="M6 20v-2a6 6 0 0 1 12 0v2"/>
          <path d="M18 14l2 2 4-4"/>
        </svg>
        Admin
      </button>

      {/* ── Modal overlay — click outside to close ── */}
      {open && (
        <div
          style={styles.overlay}
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div style={styles.modal}>
            {/* Header */}
            <div style={styles.modalHeader}>
              <div style={styles.modalHeaderLeft}>
                <div style={styles.modalLogo}>
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
                    <rect x="3" y="4" width="18" height="18" rx="2" stroke="white" strokeWidth="2"/>
                    <path d="M3 9h18M9 4v5M15 4v5" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                <span style={styles.modalTitle}>Jet City IT — Admin</span>
              </div>
              <button style={styles.closeBtn} onClick={handleClose} aria-label="Close">✕</button>
            </div>

            {/* Body */}
            <div style={styles.modalBody}>
              {step === "login" && (
                <LoginStep onSuccess={handleLoginSuccess} />
              )}
              {step === "sms" && (
                <SmsStep
                  code={smsCode}
                  onSuccess={handleVerifySuccess}
                  onBack={handleBack}
                />
              )}
              {step === "dashboard" && (
                <Dashboard currentUser={currentUser} onLogout={handleLogout} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────
const GREEN = "#16A37F";
const GREEN_DARK = "#0D6E56";
const GREEN_LIGHT = "#E6F7F3";
const GREEN_MID = "#52C9A8";
const RED = "#F04438";
const TEXT = "#0F1724";
const TEXT2 = "#4B5565";
const TEXT3 = "#8A93A2";
const BORDER = "#E4E7EC";
const BORDER2 = "#D0D5DD";
const SURFACE = "#FFFFFF";
const SURFACE2 = "#F0F2F5";

const styles = {
  container: {
    display: "flex",
    justifyContent: "center",
    padding: "32px 16px",
    background: "#F7F8FA",
    minHeight: 400,
  },
  stepWrap: {
    width: "100%",
    maxWidth: 380,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: TEXT,
    marginBottom: 6,
    letterSpacing: "-0.3px",
  },
  subtitle: {
    fontSize: 13,
    color: TEXT3,
    marginBottom: 24,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: TEXT2,
    display: "block",
    marginBottom: 5,
  },
  input: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: `1.5px solid ${BORDER2}`,
    background: SURFACE,
    color: TEXT,
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    marginBottom: 14,
    display: "block",
  },
  btnPrimary: {
    width: "100%",
    padding: "11px 0",
    background: GREEN,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    marginTop: 4,
    display: "block",
  },
  btnGhost: {
    width: "100%",
    padding: "11px 0",
    background: "transparent",
    color: TEXT2,
    border: `1.5px solid ${BORDER2}`,
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    marginTop: 8,
    display: "block",
  },
  errorBox: {
    background: "#FFF2F2",
    border: "1px solid #FECACA",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13,
    color: RED,
    marginBottom: 14,
  },
  smsBox: {
    background: GREEN_LIGHT,
    border: `1px solid ${GREEN_MID}`,
    borderRadius: 8,
    padding: "14px 16px",
    marginBottom: 20,
  },
  smsLabel: {
    fontSize: 12,
    color: GREEN_DARK,
    fontWeight: 500,
    marginBottom: 4,
  },
  smsCode: {
    fontSize: 28,
    fontWeight: 700,
    color: GREEN_DARK,
    letterSpacing: 8,
    fontFamily: "monospace",
  },
  smsHint: {
    fontSize: 11,
    color: TEXT3,
    marginTop: 6,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    background: GREEN_LIGHT,
    color: GREEN_DARK,
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: 20,
    marginBottom: 16,
  },
  badgeDot: {
    width: 6,
    height: 6,
    background: GREEN,
    borderRadius: "50%",
    display: "inline-block",
  },
  logoutBtn: {
    background: "transparent",
    color: TEXT3,
    border: `1.5px solid ${BORDER2}`,
    borderRadius: 8,
    padding: "7px 14px",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    float: "right",
    marginBottom: 16,
  },
  accountGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    marginBottom: 16,
  },
  accountCard: {
    background: SURFACE,
    border: `1.5px solid ${BORDER}`,
    borderRadius: 8,
    padding: "14px 16px",
  },
  accountCardActive: {
    borderColor: GREEN,
  },
  accountName: {
    fontWeight: 600,
    fontSize: 14,
    color: TEXT,
    marginBottom: 2,
  },
  accountUsername: {
    fontSize: 12,
    color: TEXT3,
  },
  accountPhone: {
    fontSize: 11,
    color: TEXT3,
    marginTop: 4,
  },
  accountStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 500,
    marginTop: 8,
    color: GREEN_DARK,
  },
  statusDot: {
    width: 5,
    height: 5,
    background: GREEN,
    borderRadius: "50%",
    display: "inline-block",
  },
  infoNote: {
    background: SURFACE2,
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 12,
    color: TEXT3,
    marginTop: 16,
    lineHeight: 1.6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: TEXT3,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: 500,
    color: GREEN,
    textTransform: "none",
    letterSpacing: 0,
  },
  userTable: {
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    overflow: "hidden",
  },
  userRowHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    background: SURFACE2,
    fontSize: 11,
    fontWeight: 600,
    color: TEXT3,
    borderBottom: `1px solid ${BORDER}`,
  },
  userRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 12px",
    borderBottom: `1px solid ${BORDER}`,
    transition: "background .1s",
  },
  userRowActive: {
    background: SURFACE,
  },
  userRowInactive: {
    background: "#FAFAFA",
  },
  pillActive: {
    display: "inline-block",
    background: GREEN_LIGHT,
    color: GREEN_DARK,
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 20,
  },
  pillInactive: {
    display: "inline-block",
    background: SURFACE2,
    color: TEXT3,
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 20,
    border: `1px solid ${BORDER}`,
  },
  actionBtn: {
    background: GREEN,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  actionBtnGhost: {
    background: "transparent",
    color: TEXT2,
    border: `1px solid ${BORDER2}`,
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  actionBtnDeactivate: {
    background: "transparent",
    color: RED,
    border: `1px solid #FECACA`,
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  renameInput: {
    padding: "3px 6px",
    borderRadius: 6,
    border: `1.5px solid ${GREEN}`,
    background: SURFACE,
    color: TEXT,
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
    width: "90%",
  },

  // ── Floating button ──
  floatBtn: {
    position: "fixed",
    top: 14,
    right: 20,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 14px",
    background: SURFACE,
    color: TEXT2,
    border: `1.5px solid ${BORDER2}`,
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 1px 4px rgba(15,23,36,.08)",
    transition: "border-color .15s, color .15s",
  },

  // ── Modal overlay ──
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1100,
    background: "rgba(15,23,36,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },

  modal: {
    background: SURFACE,
    borderRadius: 14,
    width: "100%",
    maxWidth: 600,
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 8px 40px rgba(15,23,36,.18)",
  },

  modalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: `1px solid ${BORDER}`,
    flexShrink: 0,
  },

  modalHeaderLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  modalLogo: {
    width: 28,
    height: 28,
    background: GREEN,
    borderRadius: 7,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  modalTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: TEXT,
    letterSpacing: "-0.2px",
  },

  closeBtn: {
    background: "transparent",
    border: "none",
    color: TEXT3,
    fontSize: 16,
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 6,
    fontFamily: "inherit",
    lineHeight: 1,
  },

  modalBody: {
    overflowY: "auto",
    padding: "24px 20px",
    flex: 1,
  },

  // ── container no longer needed as standalone page ──
  container: {
    display: "flex",
    justifyContent: "center",
    padding: "0",
  },
};
