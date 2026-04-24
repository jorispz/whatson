// Minimal service worker. Its only job is to exist (with a fetch handler)
// so Chrome / Brave on Android will treat whatson as an installable PWA
// and skip the browser-badged home-screen shortcut. No caching, no offline.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
