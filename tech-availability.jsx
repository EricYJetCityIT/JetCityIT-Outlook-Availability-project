import { useState, useEffect, useCallback } from "react";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const START_HOUR = 8;
const END_HOUR = 18;
const NUM_SLOTS = (END_HOUR - START_HOUR) * 2;

const GREEN = "#1D9E75";
const GREEN_BORDER = "#0F6E56";

function getWeekMeta() {
  const now = new Date();
  const d = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (d === 0 ? 6 : d - 1));
  const fri = new Date(mon);
  fri.setDate(mon.getDate() + 4);
  const key = `wk:${mon.toISOString().split("T")[0]}`;
  const label = `${mon.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${fri.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return { key, label };
}

function slotLabel(absSlot) {
  const h = Math.floor(absSlot / 2);
  const m = absSlot % 2 === 0 ? "00" : "30";
  if (m !== "00") return "";
  return `${h > 12 ? h - 12 : h === 0 ? 12 : h}${h < 12 ? "a" : "p"}`;
}

function initials(name) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

// ─── Tech View ────────────────────────────────────────────────────────────────
function TechView() {
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [slots, setSlots] = useState(() =>
    Object.fromEntries(DAYS.map((_, i) => [i, new Set()]))
  );
  const [status, setStatus] = useState(null); // { type: "ok"|"err", msg }
  const [saving, setSaving] = useState(false);
  const week = getWeekMeta();

  async function handleLoad() {
    if (!name.trim()) return;
    const key = `av:${week.key}:${name.trim().toLowerCase().replace(/\s+/g, "-")}`;
    const fresh = Object.fromEntries(DAYS.map((_, i) => [i, new Set()]));
    try {
      const res = await window.storage.get(key, true);
      if (res && res.value) {
        const saved = JSON.parse(res.value);
        saved.forEach((arr, i) => { fresh[i] = new Set(arr); });
      }
    } catch (_) {}
    setSlots(fresh);
    setLoaded(true);
    setStatus(null);
  }

  function toggle(day, slot) {
    setSlots((prev) => {
      const next = { ...prev, [day]: new Set(prev[day]) };
      next[day].has(slot) ? next[day].delete(slot) : next[day].add(slot);
      return next;
    });
  }

  function clearAll() {
    setSlots(Object.fromEntries(DAYS.map((_, i) => [i, new Set()])));
  }

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const key = `av:${week.key}:${name.trim().toLowerCase().replace(/\s+/g, "-")}`;
      const data = DAYS.map((_, i) => Array.from(slots[i] || []));
      const result = await window.storage.set(key, JSON.stringify(data), true);
      if (!result) throw new Error("Storage returned null");

      // Update name index
      const idxKey = `index:${week.key}`;
      let names = [];
      try {
        const ir = await window.storage.get(idxKey, true);
        if (ir && ir.value) names = JSON.parse(ir.value);
      } catch (_) {}
      const trimmed = name.trim();
      if (!names.includes(trimmed)) names.push(trimmed);
      await window.storage.set(idxKey, JSON.stringify(names), true);

      setStatus({ type: "ok", msg: `Saved for week of ${week.label}` });
    } catch (e) {
      setStatus({ type: "err", msg: "Couldn't save. Try again." });
    } finally {
      setSaving(false);
    }
  }

  const totalFree = Object.values(slots).reduce((acc, s) => acc + s.size, 0);

  return (
    <div>
      {/* Name entry */}
      <div style={styles.card}>
        <div style={styles.label}>Your name</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => { setName(e.target.value); setLoaded(false); }}
            onKeyDown={(e) => e.key === "Enter" && handleLoad()}
            placeholder="e.g. Alex Rivera"
          />
          <button style={styles.btn} onClick={handleLoad}>
            Load my slots
          </button>
        </div>
      </div>

      {/* Grid */}
      {loaded && (
        <div style={styles.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <div>
              <span style={{ fontWeight: 500, fontSize: 15 }}>Select available slots</span>
              {totalFree > 0 && (
                <span style={{ marginLeft: 10, fontSize: 12, color: GREEN }}>
                  {(totalFree * 0.5).toFixed(1)} hrs marked
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={styles.btn} onClick={clearAll}>Clear all</button>
              <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save availability"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 16, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={styles.hint}>
              Work hours: 8 am – 6 pm &nbsp;·&nbsp;
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ ...styles.dot, background: GREEN }} /> Available
              </span>
              &nbsp;
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ ...styles.dot, background: "#2a2a2a", border: "0.5px solid #444" }} /> Unavailable
              </span>
            </span>
          </div>

          {/* Day headers */}
          <div style={{ ...styles.gridRow, marginBottom: 4 }}>
            <div style={styles.timeCell} />
            {DAYS.map((d) => (
              <div key={d} style={{ textAlign: "center", fontSize: 12, color: "#aaa", fontWeight: 500 }}>{d}</div>
            ))}
          </div>

          {/* Slots */}
          {Array.from({ length: NUM_SLOTS }, (_, s) => {
            const absSlot = START_HOUR * 2 + s;
            const lbl = slotLabel(absSlot);
            return (
              <div key={s} style={{ ...styles.gridRow, marginBottom: 2 }}>
                <div style={styles.timeCell}>{lbl}</div>
                {DAYS.map((_, di) => {
                  const on = slots[di]?.has(absSlot);
                  return (
                    <div
                      key={di}
                      onClick={() => toggle(di, absSlot)}
                      style={{
                        height: 22,
                        borderRadius: 3,
                        cursor: "pointer",
                        background: on ? GREEN : "#2a2a2a",
                        border: `0.5px solid ${on ? GREEN_BORDER : "#444"}`,
                        transition: "background 0.1s",
                      }}
                    />
                  );
                })}
              </div>
            );
          })}

          {status && (
            <div style={{ marginTop: 10, fontSize: 12, color: status.type === "ok" ? GREEN : "#fc8181" }}>
              {status.type === "ok" ? "✓ " : "⚠ "}{status.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Manager View ─────────────────────────────────────────────────────────────
function ManagerView() {
  const [techData, setTechData] = useState(null);
  const [loading, setLoading] = useState(true);
  const week = getWeekMeta();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const idxKey = `index:${week.key}`;
      let names = [];
      try {
        const ir = await window.storage.get(idxKey, true);
        if (ir && ir.value) names = JSON.parse(ir.value);
      } catch (_) {}

      const results = [];
      for (const name of names) {
        const key = `av:${week.key}:${name.toLowerCase().replace(/\s+/g, "-")}`;
        try {
          const r = await window.storage.get(key, true);
          if (r && r.value) {
            const saved = JSON.parse(r.value);
            results.push({ name, slotSets: saved.map((a) => new Set(a)) });
          }
        } catch (_) {}
      }
      setTechData(results);
    } catch (_) {
      setTechData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function clearAll() {
    if (!window.confirm("Clear all submissions for this week?")) return;
    try {
      const idxKey = `index:${week.key}`;
      const ir = await window.storage.get(idxKey, true);
      if (ir && ir.value) {
        const names = JSON.parse(ir.value);
        for (const name of names) {
          const key = `av:${week.key}:${name.toLowerCase().replace(/\s+/g, "-")}`;
          try { await window.storage.delete(key, true); } catch (_) {}
        }
      }
      await window.storage.delete(idxKey, true);
      load();
    } catch (_) {}
  }

  if (loading) return <div style={styles.empty}>Loading…</div>;
  if (!techData || techData.length === 0)
    return <div style={styles.empty}>No techs have submitted availability yet.</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <span style={{ fontWeight: 500, fontSize: 15 }}>Team availability</span>
          <span style={{ marginLeft: 10, fontSize: 12, color: "#aaa" }}>
            Week of {week.label} · {techData.length} tech{techData.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.btn} onClick={load}>↻ Refresh</button>
          <button style={{ ...styles.btn, color: "#fc8181", borderColor: "#7a3333" }} onClick={clearAll}>
            Clear all
          </button>
        </div>
      </div>

      {techData.map(({ name, slotSets }) => {
        const totalFree = slotSets.reduce((acc, s) => acc + s.size, 0);
        return (
          <div key={name} style={{ ...styles.card, marginBottom: 12 }}>
            {/* Tech header */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={styles.avatar}>{initials(name)}</div>
              <div>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{name}</div>
                <div style={{ fontSize: 12, color: "#aaa" }}>
                  {(totalFree * 0.5).toFixed(1)} hrs available this week
                </div>
              </div>
            </div>

            {/* Day headers */}
            <div style={{ ...styles.gridRow, marginBottom: 4 }}>
              <div style={styles.timeCell} />
              {DAYS.map((d) => (
                <div key={d} style={{ textAlign: "center", fontSize: 11, color: "#aaa" }}>{d}</div>
              ))}
            </div>

            {/* Slots */}
            {Array.from({ length: NUM_SLOTS }, (_, s) => {
              const absSlot = START_HOUR * 2 + s;
              const lbl = slotLabel(absSlot);
              return (
                <div key={s} style={{ ...styles.gridRow, marginBottom: 2 }}>
                  <div style={styles.timeCell}>{lbl}</div>
                  {DAYS.map((_, di) => {
                    const on = slotSets[di]?.has(absSlot);
                    return (
                      <div
                        key={di}
                        style={{
                          height: 18,
                          borderRadius: 2,
                          background: on ? GREEN : "#2a2a2a",
                          border: `0.5px solid ${on ? GREEN_BORDER : "#3a3a3a"}`,
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
        <span style={styles.hint}><span style={{ ...styles.dot, background: GREEN }} /> Available</span>
        <span style={styles.hint}><span style={{ ...styles.dot, background: "#2a2a2a", border: "0.5px solid #444" }} /> Unavailable</span>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const styles = {
  card: {
    background: "#1e1e1e",
    border: "0.5px solid #333",
    borderRadius: 12,
    padding: "16px 20px",
    marginBottom: 12,
  },
  label: { fontSize: 12, color: "#aaa", marginBottom: 6 },
  input: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 8,
    border: "0.5px solid #444",
    background: "#2a2a2a",
    color: "#fff",
    fontSize: 14,
    outline: "none",
    minWidth: 0,
  },
  btn: {
    padding: "8px 16px",
    borderRadius: 8,
    border: "0.5px solid #444",
    background: "#2a2a2a",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnPrimary: {
    background: GREEN,
    borderColor: GREEN_BORDER,
    color: "#fff",
  },
  hint: {
    fontSize: 12,
    color: "#888",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  },
  dot: {
    display: "inline-block",
    width: 12,
    height: 12,
    borderRadius: 2,
  },
  gridRow: {
    display: "grid",
    gridTemplateColumns: "44px repeat(5, 1fr)",
    gap: 2,
  },
  timeCell: {
    fontSize: 11,
    color: "#666",
    display: "flex",
    alignItems: "center",
    paddingRight: 4,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "#0c447c",
    color: "#b5d4f4",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 500,
    flexShrink: 0,
  },
  empty: {
    textAlign: "center",
    color: "#666",
    fontSize: 14,
    padding: "40px 0",
  },
};

// ─── App shell ────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("tech");

  return (
    <div style={{ minHeight: "100vh", background: "#141414", color: "#fff", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ background: "#1a1a1a", borderBottom: "0.5px solid #333", padding: "0 28px", display: "flex", alignItems: "center", height: 56, gap: 12 }}>
        <div style={{ width: 28, height: 28, background: GREEN, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="15" height="15" fill="none" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2" stroke="white" strokeWidth="2" />
            <path d="M3 9h18M9 4v5M15 4v5" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.2px" }}>Availability</span>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px" }}>
        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, background: "#1e1e1e", border: "0.5px solid #333", borderRadius: 10, padding: 4, marginBottom: 24, width: "fit-content" }}>
          {[{ id: "tech", label: "My availability" }, { id: "manager", label: "Manager view" }].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                padding: "7px 18px",
                borderRadius: 7,
                border: "none",
                fontSize: 13,
                fontWeight: tab === id ? 500 : 400,
                cursor: "pointer",
                background: tab === id ? "#2e2e2e" : "transparent",
                color: tab === id ? "#fff" : "#888",
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "tech" ? <TechView /> : <ManagerView />}
      </div>
    </div>
  );
}
