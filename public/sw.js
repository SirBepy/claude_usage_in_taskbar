// Claude Companion Service Worker — network-first, minimal.
// Satisfies PWA installability without risking stale JS bundles after an
// app update. Cache is used only as a fallback when the network is offline.

const CACHE_NAME = "claude-companion-v1";

// Assets to pre-cache on install (empty: we cache lazily on fetch instead).
const PRECACHE = [];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      if (PRECACHE.length > 0) return cache.addAll(PRECACHE);
    })
  );
  // Activate immediately so the first browser visit gets this SW.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove caches from old SW versions.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Only handle GET requests; skip cross-origin, WS, and /api/* calls.
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Network-first: try the network, fall back to cache on failure.
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache a clone of successful responses for offline fallback.
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
