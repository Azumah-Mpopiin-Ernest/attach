const VERSION = "v1"; // bump to force every device to drop old caches
const APP_CACHE = `app-${VERSION}`;
const REMOTE_CACHE = `remote-${VERSION}`;
const NAV_TIMEOUT_MS = 3000;

// On install, fetch the app shell and every JS/CSS file it references, so
// the very first offline visit already works.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      const response = await fetch("/", { cache: "reload" });
      const html = await response.clone().text();
      await cache.put("/", response);
      const urls = [
        ...html.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|svg|png|ico))"/g),
      ].map((match) => match[1]);
      await Promise.all(urls.map((url) => cache.add(url).catch(() => {})));
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([APP_CACHE, REMOTE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !keep.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

// Page loads: try the network briefly (so new deploys arrive), then fall
// back to the cached shell. The timeout matters on a LAN with no internet,
// where a request can hang instead of failing fast.
async function handleNavigation(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await withTimeout(fetch(request), NAV_TIMEOUT_MS);
    if (response.ok) cache.put("/", response.clone());
    return response;
  } catch {
    return (await cache.match("/")) || Response.error();
  }
}

// Hashed build files never change, so serve from cache first.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// Everything else: answer from cache, refresh it in the background.
// `ignoreVary` because storage responses can carry Vary headers that would
// otherwise make the lookup miss even though the same URL is cached.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok || response.type === "opaque") {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname === "/sw.js") return;
    event.respondWith(
      url.pathname.startsWith("/assets/")
        ? cacheFirst(request, APP_CACHE)
        : staleWhileRevalidate(request, APP_CACHE),
    );
    return;
  }

  // Doctor signature images etc. from Firebase Storage. Firestore and Auth
  // traffic is deliberately NOT handled here; the Firebase SDK does its own
  // offline handling.
  if (
    url.hostname === "firebasestorage.googleapis.com" ||
    url.hostname.endsWith(".firebasestorage.app")
  ) {
    event.respondWith(staleWhileRevalidate(request, REMOTE_CACHE));
  }
});
