import { useState, useEffect } from "react";

const SLOT_HEIGHT = 28;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const COLORS = {
  navy: "#1E2A3A",
  navyLight: "#253447",
  blue: "#2B6CB0",
  teal: "#38B2AC",
  mist: "#E8EEF4",
  cloud: "#F7F9FC",
  free: "#C6F6D5",
  busy: "#FC8181",
  tentative: "#FAF089",
  text: "#1A202C",
  textMuted: "#718096",
};

function getWeekDates() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  return DAYS.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseEvents(rawEvents, weekDates) {
  const grid = weekDates.map(() => Array(24 * 2).fill("free")); // 30-min slots
  if (!rawEvents?.length) return grid;

  rawEvents.forEach((ev) => {
    const start = new Date(ev.start?.dateTime || ev.start?.date);
    const end = new Date(ev.end?.dateTime || ev.end?.date);
    const status = ev.showAs === "tentative" ? "tentative" : "busy";

    weekDates.forEach((dayDate, dayIdx) => {
      const dayStart = new Date(dayDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayDate);
      dayEnd.setHours(23, 59, 59, 999);

      if (start <= dayEnd && end >= dayStart) {
        const slotStart = Math.max(0, Math.floor((Math.max(start, dayStart) - dayStart) / 1800000));
        const slotEnd = Math.min(48, Math.ceil((Math.min(end, dayEnd) - dayStart) / 1800000));
        for (let s = slotStart; s < slotEnd; s++) {
          grid[dayIdx][s] = status;
        }
      }
    });
  });

  return grid;
}

function SlotColor(status) {
  if (status === "busy") return COLORS.busy;
  if (status === "tentative") return COLORS.tentative;
  return COLORS.free;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState([]);
  const [grid, setGrid] = useState(null);
  const [error, setError] = useState(null);
  const [userInfo, setUserInfo] = useState(null);
  const [shareMsg, setShareMsg] = useState("");
  const [workHoursOnly, setWorkHoursOnly] = useState(true);
  const [showWeekend, setShowWeekend] = useState(false);
  const weekDates = getWeekDates();

  const displayDays = showWeekend
    ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    : DAYS;
  const displayDates = showWeekend
    ? (() => {
        const all = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(weekDates[0]);
          d.setDate(weekDates[0].getDate() + i);
          return d;
        });
        return all;
      })()
    : weekDates;

  const startHour = workHoursOnly ? 8 : 0;
  const endHour = workHoursOnly ? 18 : 24;
  const visibleSlots = (endHour - startHour) * 2;

  async function fetchCalendar() {
    setLoading(true);
    setError(null);
    try {
      const startDate = weekDates[0].toISOString().split("T")[0] + "T00:00:00Z";
      const endDate = new Date(weekDates[4]);
      endDate.setHours(23, 59, 59);
      const endDateStr = endDate.toISOString();

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: `You are a calendar assistant. When asked to fetch calendar events, use the Microsoft 365 tools to:
1. First call outlook_calendar_search to get this week's events
2. Also try to get the user's display name using read_resource for /me
Return ONLY a JSON object with this shape (no markdown, no explanation):
{"events": [...raw events array...], "userName": "display name or null"}
Each event should have: id, subject, start (with dateTime), end (with dateTime), showAs (free/busy/tentative/oof).`,
          messages: [
            {
              role: "user",
              content: `Fetch my Outlook calendar events from ${startDate} to ${endDateStr} and return them as JSON.`,
            },
          ],
          mcp_servers: [
            {
              type: "url",
              url: "https://microsoft365.mcp.claude.com/mcp",
              name: "microsoft365",
            },
          ],
        }),
      });

      const data = await response.json();

      // Extract text from all content blocks
      const allText = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      // Also check mcp_tool_result blocks for raw data
      const toolResults = data.content
        .filter((b) => b.type === "mcp_tool_result")
        .map((b) => b.content?.[0]?.text || "")
        .join("\n");

      let parsed = null;
      // Try parsing from text blocks first
      try {
        const clean = allText.replace(/```json|```/g, "").trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {}

      // Fallback: try tool results
      if (!parsed && toolResults) {
        try {
          const tr = JSON.parse(toolResults);
          const evs = tr.value || tr.events || [];
          parsed = { events: evs, userName: null };
        } catch {}
      }

      if (parsed) {
        const evs = parsed.events || [];
        setEvents(evs);
        setUserInfo(parsed.userName);
        const g = parseEvents(evs, displayDates.slice(0, 5));
        setGrid(g);
        setConnected(true);
      } else {
        throw new Error("Could not parse calendar response. Please check your Microsoft 365 connection.");
      }
    } catch (e) {
      setError(e.message || "Failed to connect. Make sure Microsoft 365 is connected.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (connected) {
      const g = parseEvents(events, displayDates.slice(0, 5));
      setGrid(g);
    }
  }, [workHoursOnly, showWeekend]);

  function handleShare() {
    const url = window.location.href;
    navigator.clipboard?.writeText(url).catch(() => {});
    setShareMsg("Link copied!");
    setTimeout(() => setShareMsg(""), 2500);
  }

  const busyCount = events.filter((e) => e.showAs === "busy" || !e.showAs).length;
  const freeBlocks = grid
    ? grid.flat().filter((s) => s === "free").length
    : 0;
  const totalBlocks = grid ? grid.flat().length : 0;
  const freePct = totalBlocks ? Math.round((freeBlocks / totalBlocks) * 100) : 0;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.cloud, fontFamily: "'Inter', system-ui, sans-serif", color: COLORS.text }}>
      {/* Header */}
      <header style={{ background: COLORS.navy, padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, boxShadow: "0 2px 12px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: COLORS.teal, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="18" rx="2" stroke="white" strokeWidth="2"/>
              <path d="M3 9h18M9 4v5M15 4v5" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <span style={{ color: "white", fontWeight: 700, fontSize: 17, letterSpacing: "-0.3px" }}>Availability</span>
        </div>
        {connected && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.teal }} />
            <span style={{ color: "#A0AEC0", fontSize: 13 }}>
              {userInfo ? `Connected as ${userInfo}` : "Outlook connected"}
            </span>
          </div>
        )}
      </header>

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "40px 24px" }}>
        {!connected ? (
          /* Connect panel */
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 480 }}>
            <div style={{ background: "white", borderRadius: 20, padding: "52px 48px", boxShadow: "0 4px 32px rgba(30,42,58,0.10)", maxWidth: 420, width: "100%", textAlign: "center" }}>
              <div style={{ width: 64, height: 64, background: COLORS.mist, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <rect x="4" y="5" width="24" height="24" rx="3" fill={COLORS.blue} opacity="0.15"/>
                  <rect x="4" y="5" width="24" height="24" rx="3" stroke={COLORS.blue} strokeWidth="2"/>
                  <path d="M4 12h24" stroke={COLORS.blue} strokeWidth="2"/>
                  <rect x="9" y="17" width="4" height="4" rx="1" fill={COLORS.blue}/>
                  <rect x="19" y="17" width="4" height="4" rx="1" fill={COLORS.teal} opacity="0.7"/>
                </svg>
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12, color: COLORS.navy, letterSpacing: "-0.5px" }}>
                Show your availability
              </h1>
              <p style={{ color: COLORS.textMuted, fontSize: 15, lineHeight: 1.6, marginBottom: 32 }}>
                Connect your Outlook calendar to generate a shareable view of when you're free this week — no meeting times exposed.
              </p>
              {error && (
                <div style={{ background: "#FFF5F5", border: "1px solid #FC8181", borderRadius: 10, padding: "12px 16px", marginBottom: 20, color: "#C53030", fontSize: 13, textAlign: "left" }}>
                  {error}
                </div>
              )}
              <button
                onClick={fetchCalendar}
                disabled={loading}
                style={{ width: "100%", padding: "14px 0", background: loading ? COLORS.navyLight : COLORS.navy, color: "white", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", transition: "background 0.2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}
              >
                {loading ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                      <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="3" strokeOpacity="0.3"/>
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="3" strokeLinecap="round"/>
                    </svg>
                    Fetching calendar…
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" stroke="white" strokeWidth="2"/>
                      <path d="M16 3v4M8 3v4M3 11h18" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    Connect Outlook Calendar
                  </>
                )}
              </button>
              <p style={{ marginTop: 16, fontSize: 12, color: COLORS.textMuted }}>
                Requires Microsoft 365 connected in Claude settings
              </p>
            </div>
          </div>
        ) : (
          /* Availability view */
          <div>
            {/* Stats row */}
            <div style={{ display: "flex", gap: 16, marginBottom: 28, flexWrap: "wrap" }}>
              {[
                { label: "Meetings this week", value: busyCount, color: COLORS.busy },
                { label: "Free time", value: `${freePct}%`, color: COLORS.free },
                { label: "Week of", value: `${formatDate(weekDates[0])} – ${formatDate(weekDates[4])}`, color: COLORS.teal },
              ].map((stat) => (
                <div key={stat.label} style={{ flex: "1 1 160px", background: "white", borderRadius: 12, padding: "16px 20px", boxShadow: "0 1px 6px rgba(30,42,58,0.07)", borderLeft: `4px solid ${stat.color}` }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy }}>{stat.value}</div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{stat.label}</div>
                </div>
              ))}
            </div>

            {/* Controls */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: COLORS.textMuted, cursor: "pointer" }}>
                <input type="checkbox" checked={workHoursOnly} onChange={(e) => setWorkHoursOnly(e.target.checked)} style={{ accentColor: COLORS.blue }} />
                Work hours only (8am–6pm)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: COLORS.textMuted, cursor: "pointer" }}>
                <input type="checkbox" checked={showWeekend} onChange={(e) => setShowWeekend(e.target.checked)} style={{ accentColor: COLORS.blue }} />
                Show weekend
              </label>
              <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                <button onClick={fetchCalendar} style={{ padding: "8px 16px", background: "white", border: `1px solid ${COLORS.mist}`, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", color: COLORS.navy }}>
                  ↻ Refresh
                </button>
                <button onClick={handleShare} style={{ padding: "8px 16px", background: COLORS.navy, border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "white" }}>
                  {shareMsg || "Share link"}
                </button>
              </div>
            </div>

            {/* Calendar grid */}
            <div style={{ background: "white", borderRadius: 16, boxShadow: "0 2px 16px rgba(30,42,58,0.08)", overflow: "hidden" }}>
              {/* Day headers */}
              <div style={{ display: "grid", gridTemplateColumns: `48px repeat(${displayDays.length}, 1fr)`, borderBottom: `1px solid ${COLORS.mist}` }}>
                <div style={{ padding: "14px 0", textAlign: "center" }} />
                {displayDays.map((day, i) => (
                  <div key={day} style={{ padding: "14px 8px", textAlign: "center" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{day}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.navy, marginTop: 2 }}>
                      {displayDates[i] ? displayDates[i].getDate() : ""}
                    </div>
                  </div>
                ))}
              </div>

              {/* Time slots */}
              <div style={{ overflowY: "auto", maxHeight: 520 }}>
                {Array.from({ length: visibleSlots }, (_, slotIdx) => {
                  const absoluteSlot = (startHour * 2) + slotIdx;
                  const hour = Math.floor(absoluteSlot / 2);
                  const min = absoluteSlot % 2 === 0 ? "00" : "30";
                  const showLabel = min === "00";

                  return (
                    <div
                      key={slotIdx}
                      style={{ display: "grid", gridTemplateColumns: `48px repeat(${displayDays.length}, 1fr)`, borderBottom: slotIdx < visibleSlots - 1 ? `1px solid ${COLORS.mist}` : "none", height: SLOT_HEIGHT }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8, fontSize: 11, color: COLORS.textMuted, fontVariantNumeric: "tabular-nums" }}>
                        {showLabel ? `${hour === 0 ? 12 : hour > 12 ? hour - 12 : hour}${hour < 12 ? "a" : "p"}` : ""}
                      </div>
                      {displayDays.map((_, dayIdx) => {
                        const status = grid?.[dayIdx]?.[absoluteSlot] || "free";
                        return (
                          <div
                            key={dayIdx}
                            title={status === "busy" ? "Busy" : status === "tentative" ? "Tentative" : "Free"}
                            style={{ background: SlotColor(status), borderLeft: `1px solid ${COLORS.mist}`, opacity: status === "free" ? 0.55 : 1, transition: "opacity 0.15s" }}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 20, marginTop: 16, justifyContent: "center" }}>
              {[
                { color: COLORS.free, label: "Free" },
                { color: COLORS.busy, label: "Busy" },
                { color: COLORS.tentative, label: "Tentative" },
              ].map((l) => (
                <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: COLORS.textMuted }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: l.color }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #CBD5E0; border-radius: 3px; }
      `}</style>
    </div>
  );
}
