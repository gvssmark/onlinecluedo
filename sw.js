// Cluedo Online — service worker
// Only caches the static app shell. Never caches Firebase requests — the game
// needs a live connection to actually play, this just makes the app installable
// and lets the shell load instantly on repeat visits.
const CACHE_NAME = "cluedo-shell-v20";
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./link.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept Firebase / Google network calls — those must always hit the network live.
  if (url.origin !== self.location.origin) return;
  // Network-first for the app shell: always try to get the latest build; only fall
  // back to the cache if genuinely offline. Prevents a stale early build from getting
  // stuck being served forever (this caused real problems on mobile browsers).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
