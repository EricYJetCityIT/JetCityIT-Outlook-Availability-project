// Service worker: keeps the app shell available when the phone has no signal
// (a tech in a basement or server room reloading the page), without ever
// serving stale app code while there IS a connection.
//
// Strategy is NETWORK-FIRST for same-origin GETs: always try the network (so a
// fresh deploy is picked up immediately, exactly as before this file cached
// anything) and store the good response; only if the network fails or takes
// longer than NET_TIMEOUT_MS do we fall back to the last copy we stored.
// /api/* and every non-GET request are left completely alone -- they are live
// data and writes, never cached here (the Floor Maps tab keeps its own offline
// copy of the data in IndexedDB). Cross-origin requests (Microsoft sign-in,
// Graph, Google Fonts) are also untouched.
const CACHE = 'jcit-shell-v1';
const NET_TIMEOUT_MS = 6000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older versions of this file, then take over open pages.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  // Every navigation (/, /?source=pwa, /?x=1 ...) is the same single-page app,
  // so they share one cache entry instead of piling up a 3 MB copy per URL.
  // Only the app's own root document shares the '/' entry; any other page a
  // tech navigates to is kept under its own key so it can never overwrite the
  // saved app shell.
  const p = new URL(req.url).pathname;
  const key = (req.mode === 'navigate' && (p === '/' || p === '/index.html')) ? '/' : req;
  const net = fetch(req).then((res) => {
    // Only keep good same-origin responses (never errors or redirects).
    if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {}); // a failure that lands after we've answered from cache is not an error
  let timer;
  const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('slow')), NET_TIMEOUT_MS); });
  try {
    const res = await Promise.race([net, slow]);
    // The host answered but with a server error / transient 404 (seen briefly
    // after deploys): prefer a saved good copy over showing that error.
    if (res && !res.ok && res.type === 'basic' && (res.status >= 500 || res.status === 404)) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    return res;
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;
    return net; // nothing saved yet: wait for the network (or fail the same way it always did)
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(networkFirst(req));
});
