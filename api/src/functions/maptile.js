const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');

// Proxies OpenStreetMap map tiles through our own origin so the parking map can
// show a real basemap WITHOUT the browser talking to an external tile host —
// keeps the page CSP unchanged (img-src 'self' blob:) and respects OSM's usage
// policy (server-side User-Agent + caching). Stays authenticated: the client
// fetches each tile with the bearer header and turns it into a blob URL, so
// this is never an open tile proxy. Tiles are public map imagery, not job data.
const UA = 'JCIT-crew-calendar/1.0 (dylanm@jetcityit.com; internal parking map)';
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE = 800;
const tileCache = new Map(); // "z/x/y" -> { buf, ts }

app.http('maptile', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'maptile',
  handler: async (request, context) => {
    try {
      await requireUser(request);
      const p = new URL(request.url).searchParams;
      const z = Number(p.get('z')), x = Number(p.get('x')), y = Number(p.get('y'));
      const n = Math.pow(2, z);
      // Only street-to-neighborhood zooms are ever needed; reject anything else
      // so this can't be driven as a general-purpose proxy.
      if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
          z < 10 || z > 19 || x < 0 || y < 0 || x >= n || y >= n) {
        return { status: 400, jsonBody: { error: 'Invalid tile coordinates' } };
      }

      const key = `${z}/${x}/${y}`;
      const now = Date.now();
      let hit = tileCache.get(key);
      if (!hit || now - hit.ts > TILE_TTL_MS) {
        const res = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { 'User-Agent': UA } });
        if (!res.ok) {
          context.log(`maptile fetch failed ${res.status} for ${key}`);
          return { status: 502, jsonBody: { error: 'Tile fetch failed' } };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        hit = { buf, ts: now };
        tileCache.set(key, hit);
        if (tileCache.size > MAX_CACHE) tileCache.delete(tileCache.keys().next().value);
      }

      return {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'X-Content-Type-Options': 'nosniff',
        },
        body: hit.buf,
      };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
