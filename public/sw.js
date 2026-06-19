// Claude Companion Service Worker — keeps the HTML entrypoint always-fresh so
// an app/daemon update is never shadowed by a stale bundle, while still caching
// the content-hashed assets for fast repeat loads.
//
// Staleness fix (ai_todo 119): the navigation document (index.html) is served
// NETWORK-ONLY and never cached. A cached index.html points at the previous
// build's hashed JS, which no longer exists after an update — so a single
// network blip (e.g. the daemon restarting mid-update) used to leave the phone
// pinned to dead code until the cache was manually cleared. Hashed assets
// (/assets/index-<hash>.js) self-bust by filename, so they are safe to cache
// forever; only the HTML that references them must always be fetched fresh.
//
// This is a tailnet remote-control client: with no reachable daemon it has no
// data to show, so a network-only HTML entrypoint costs no real offline
// capability.

const CACHE_NAME = "claude-companion-v2";

self.addEventListener("install", () => {
  // Activate immediately so the first browser visit gets this SW.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove caches from old SW versions (incl. the v1 cache that may hold a
  // stale index.html).
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isNavigationRequest(req) {
  return (
    req.mode === "navigate" ||
    req.destination === "document" ||
    new URL(req.url).pathname === "/"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // HTML entrypoint: NETWORK-ONLY, never cached, so updates are never shadowed.
  if (isNavigationRequest(req)) {
    event.respondWith(fetch(req));
    return;
  }

  // Hashed/static assets: cache-first (immutable names), revalidating in the
  // background and falling back to the network on a cache miss.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fromNetwork = fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fromNetwork;
    })
  );
});
