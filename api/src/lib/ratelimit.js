// Per-user rate limiting to blunt scraping / bulk harvesting of client PII.
//
// The API already requires a valid Entra token, so this is NOT about anonymous
// bots — it's about capping how fast any one signed-in identity (or a leaked/
// compromised token) can pull data. A normal user makes tens of calls; an
// enumeration script trips this quickly.
//
// Implementation is an in-memory fixed-window counter: zero extra infrastructure
// and effective for this small, typically single-instance Functions app. If the
// app is ever scaled out to multiple instances, swap this for a shared store
// (Azure Cache for Redis `INCR`/`EXPIRE`, or a Cosmos container with TTL) so the
// limit is enforced across instances. It deliberately FAILS OPEN — a limiter
// hiccup must never take the app down.
//
// Tune the threshold without a code change via the RATE_LIMIT_PER_MIN app setting.

const WINDOW_MS = 60 * 1000; // 1-minute window
const MAX_PER_WINDOW = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) > 0
  ? parseInt(process.env.RATE_LIMIT_PER_MIN, 10)
  : 120; // generous for real use; enumeration blows past it

const hits = new Map(); // key -> { count, windowStart }

function checkRateLimit(key, max = MAX_PER_WINDOW, windowMs = WINDOW_MS) {
  try {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(key, entry);
    }
    entry.count += 1;

    // Opportunistic cleanup so the map can't grow unbounded.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now - v.windowStart >= windowMs) hits.delete(k);
      }
    }

    return {
      allowed: entry.count <= max,
      retryAfterSec: Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000)),
    };
  } catch (_) {
    return { allowed: true, retryAfterSec: 0 }; // fail open
  }
}

module.exports = { checkRateLimit };
