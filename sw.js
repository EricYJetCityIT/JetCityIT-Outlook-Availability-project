// Minimal service worker — exists to satisfy PWA installability requirements
// (Chrome/Android requires a registered fetch handler before it'll offer the
// "Install app" prompt). Deliberately does not cache anything yet: this app's
// data changes constantly (Cosmos DB-backed availability/dispatch, frequent
// deploys), so caching HTML/JS here would risk serving stale app logic after
// an update. Every request just passes straight through to the network.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
