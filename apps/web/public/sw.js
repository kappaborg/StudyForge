// StudyForge service worker.
//
// Strategies:
//   * Static shell: cache-first via the network on first hit. The Next
//     build emits cache-busted asset URLs, so we can keep the cache
//     forever for non-HTML.
//   * Learning artifact GETs (decks, deck details, roadmaps): stale-
//     while-revalidate. The user sees the last cached version instantly
//     and we refresh in the background when online.
//   * Everything else: network-first.

const VERSION = 'studyforge-v1';
const STATIC_CACHE = `${VERSION}-static`;
const ARTIFACT_CACHE = `${VERSION}-artifacts`;

const ARTIFACT_PATTERNS = [
  /\/v1\/courses\/[^/]+\/flashcards(\?.*)?$/,
  /\/v1\/flashcards\/decks\/[^/]+(\?.*)?$/,
  /\/v1\/courses\/[^/]+\/roadmaps(\?.*)?$/,
  /\/v1\/roadmaps\/[^/]+(\?.*)?$/,
];

self.addEventListener('install', () => {
  // Activate immediately on update so users don't have to reload twice.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !name.startsWith(VERSION))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isArtifactRequest(url) {
  return ARTIFACT_PATTERNS.some((re) => re.test(url.pathname));
}

function isStaticRequest(request) {
  // Cache cross-origin third-party assets too if they look static. The
  // important case is Next's `/_next/static/*` bundles.
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icon') ||
    url.pathname === '/manifest.webmanifest'
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (isStaticRequest(request)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  const url = new URL(request.url);
  if (isArtifactRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, ARTIFACT_CACHE));
    return;
  }

  // Default: don't intercept. Let the browser hit the network.
});
