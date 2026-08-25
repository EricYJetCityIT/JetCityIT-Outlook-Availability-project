const { app } = require('@azure/functions');
const { requireUser, authErrorResponse } = require('../lib/auth');
const { getContainer } = require('../lib/cosmos');

// Finds parking near a job address and ranks it by straight-line distance from
// that address, so crews can see which lot is closest to the site. Uses only
// FREE OpenStreetMap services (Nominatim to geocode, Overpass for parking) —
// no API key, no cost. All external calls happen here on the server, so the
// browser only ever talks to /api (no CSP change, nothing sent to Google).
// Results are cached in Cosmos (parking rarely changes and the OSM services are
// rate-limited), reusing the existing `dispatch` container whose partition key
// is /id, with ids namespaced `parking:<address>` so they never collide with
// the jobs `state` doc or the report-match cursor.

const CACHE_CONTAINER = 'dispatch';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Bump whenever the parking result shape/sources/logic change, so old cached
// entries are treated as stale instead of masking the change for 30 days.
const CACHE_VERSION = 4; // 2 = +Seattle; 3 = +rates/hours; 4 = drop permit-only
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
// Seattle's official Public Garages and Parking Lots layer (ArcGIS
// FeatureServer, free, no key) — augments OSM with garages it misses.
const SEATTLE_GARAGES = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Public_Garages_and_Parking_Lots/FeatureServer/1/query';
const UA = 'JCIT-crew-calendar/1.0 (dylanm@jetcityit.com; internal parking lookup)';
const RADIUS_M = 800; // ~0.5 mi
const MAX_RESULTS = 40; // map view — show many; dense areas have 100+ lots

function normAddr(a) {
  return String(a).trim().toLowerCase().replace(/\s+/g, ' ');
}
function cacheId(a) {
  return 'parking:' + normAddr(a).replace(/[^a-z0-9]+/g, '-').slice(0, 120);
}
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocode(address) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode HTTP ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
}

async function findParking(lat, lon) {
  // node + way (buildings/areas tagged as parking); `out center` gives ways a
  // representative point so we can measure distance to them too.
  const q =
    `[out:json][timeout:20];(` +
    `node["amenity"="parking"](around:${RADIUS_M},${lat},${lon});` +
    `way["amenity"="parking"](around:${RADIUS_M},${lat},${lon});` +
    `);out center tags;`;
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error('overpass HTTP ' + res.status);
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const el of data.elements || []) {
    const plat = el.lat != null ? el.lat : el.center && el.center.lat;
    const plon = el.lon != null ? el.lon : el.center && el.center.lon;
    if (plat == null || plon == null) continue;
    const t = el.tags || {};
    if (/permit/i.test(t.access || '')) continue; // permit-only — crews can't use it
    const name = t.name || (t.parking ? t.parking.replace(/_/g, ' ') + ' parking' : 'Parking');
    // Dedupe lots that appear as both a node and an enclosing way.
    const key = (t.name || '') + '|' + plat.toFixed(4) + '|' + plon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      lat: plat,
      lon: plon,
      distanceMi: Math.round(haversineMi(lat, lon, plat, plon) * 100) / 100,
      type: t.parking || '',
      access: t.access || '',
      fee: t.fee || '',
      source: 'osm',
    });
  }
  out.sort((a, b) => a.distanceMi - b.distanceMi);
  return out;
}

// Seattle's official garages/lots (ArcGIS FeatureServer). Has garages OSM
// misses (e.g. building garages like Amazon's) plus stall counts. Seattle-city
// only — returns [] elsewhere or on error, so it purely augments OSM.
async function seattleParking(lat, lon) {
  const params = new URLSearchParams({
    f: 'geojson', where: '1=1',
    outFields: 'DEA_FACILITY_NAME,FAC_NAME,DEA_STALLS,FAC_TYPE,RTE_1HR,RTE_ALLDAY,HRS_MONFRI',
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    distance: String(RADIUS_M), units: 'esriSRUnit_Meter',
    spatialRel: 'esriSpatialRelIntersects', outSR: '4326', returnGeometry: 'true',
  });
  const res = await fetch(`${SEATTLE_GARAGES}?${params.toString()}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('seattle HTTP ' + res.status);
  const data = await res.json();
  const out = [];
  for (const f of data.features || []) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || c.length < 2) continue;
    const plon = c[0], plat = c[1];
    const p = f.properties || {};
    // Drop permit-only facilities (reserved for permit holders — crews can't use them).
    const permit = /permit only/i;
    if (permit.test(String(p.RTE_1HR || '')) || permit.test(String(p.RTE_ALLDAY || '')) || permit.test(String(p.HRS_MONFRI || ''))) continue;
    const name = String(p.DEA_FACILITY_NAME || p.FAC_NAME || 'Public parking').trim().replace(/\s+LOT\s+\d+$/i, '');
    out.push({
      name,
      lat: plat,
      lon: plon,
      distanceMi: Math.round(haversineMi(lat, lon, plat, plon) * 100) / 100,
      type: p.FAC_TYPE || '',
      stalls: Number(p.DEA_STALLS) || null,
      rate1: p.RTE_1HR || null,
      rateAll: p.RTE_ALLDAY || null,
      hours: p.HRS_MONFRI || null,
      source: 'seattle',
    });
  }
  return out;
}

app.http('parking', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'parking',
  handler: async (request, context) => {
    try {
      await requireUser(request);
      const address = (new URL(request.url).searchParams.get('address') || '').trim();
      if (address.length < 4) return { status: 400, jsonBody: { error: 'Missing or too-short address' } };

      const id = cacheId(address);
      const container = getContainer(CACHE_CONTAINER);

      try {
        const { resource } = await container.item(id, id).read();
        if (resource && resource.version === CACHE_VERSION && resource.cachedAt && Date.now() - resource.cachedAt < CACHE_TTL_MS) {
          return { jsonBody: { ...resource.data, cached: true } };
        }
      } catch (e) {
        if (e.code !== 404) context.log('parking cache read failed: ' + e.message);
      }

      const geo = await geocode(address);
      if (!geo) {
        return { jsonBody: { address, point: null, parking: [], error: 'Could not locate that address.' } };
      }
      const [osm, seattle] = await Promise.all([
        findParking(geo.lat, geo.lon).catch((e) => { context.log('osm parking failed: ' + e.message); return []; }),
        seattleParking(geo.lat, geo.lon).catch((e) => { context.log('seattle parking failed: ' + e.message); return []; }),
      ]);
      // Seattle facilities are vetted/richer, so drop any OSM lot that duplicates
      // one within ~40m (0.025mi), then merge and rank by distance from the site.
      const dupOfSeattle = (o) => seattle.some((s) => haversineMi(o.lat, o.lon, s.lat, s.lon) < 0.025);
      const mergedAll = seattle.concat(osm.filter((o) => !dupOfSeattle(o)));
      mergedAll.sort((a, b) => a.distanceMi - b.distanceMi);
      // Keep the nearest MAX_RESULTS, but always include garages / large lots
      // even if farther (they're the usable option past the nearest tiny lots).
      const isKeeper = (p) => /multi-storey|underground/.test(p.type || '') || /garage/i.test(p.name || '') || (p.stalls && p.stalls >= 200);
      const nearest = mergedAll.slice(0, MAX_RESULTS);
      const extras = mergedAll.slice(MAX_RESULTS).filter(isKeeper);
      const parking = nearest.concat(extras);
      const data = {
        address,
        point: { lat: geo.lat, lon: geo.lon },
        radiusMi: Math.round((RADIUS_M / 1609.34) * 100) / 100,
        parking,
      };

      try {
        await container.items.upsert({ id, version: CACHE_VERSION, cachedAt: Date.now(), data });
      } catch (e) {
        context.log('parking cache write failed: ' + e.message);
      }

      return { jsonBody: { ...data, cached: false } };
    } catch (e) {
      return authErrorResponse(e, context);
    }
  },
});
