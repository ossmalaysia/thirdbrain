// Third Brain service worker: makes the portal installable and shows an offline page when the laptop is not reachable.
// Rules (GBrain shares this origin):
//  - Only the static shell below is cached. The portal HTML is never cached: it carries a per-start control token.
//  - Shell files: network first (a reload shows a new version at once), the cached copy only when the network fails.
//  - Navigations: network first, offline.html when the network fails.
//  - Never respond for GBrain or portal API paths, or for any non-GET request: those go straight to the network.
const VERSION = 'v1';
const CACHE = `third-brain-shell-${VERSION}`;
const SHELL = ['/style.css', '/portal.js', '/view.js', '/favicon.svg', '/empty-state.png', '/manifest.webmanifest',
  '/offline.html', '/offline.js', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
const PASS_PREFIXES = ['/api/', '/auth/', '/admin', '/.well-known/'];
const PASS_PATHS = ['/mcp', '/authorize', '/token', '/register', '/revoke', '/health', '/sw.js'];

/** True when the worker must leave the request alone: the browser then sends it to the network as usual. */
const passThrough = (request, url) => request.method !== 'GET' || url.origin !== self.location.origin
  || PASS_PATHS.includes(url.pathname) || PASS_PREFIXES.some(p => url.pathname.startsWith(p));

self.addEventListener('install', event => {
  // One failed file must not stop the install: cache what loads.
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(path =>
    fetch(path, { cache: 'no-store' }).then(r => r.ok ? cache.put(path, r) : null).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('third-brain-shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (passThrough(request, url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/offline.html', { cacheName: CACHE })) ?? Response.error()));
    return;
  }
  if (!SHELL.includes(url.pathname) || url.search) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(url.pathname, copy)); }
    return response;
  }).catch(async () => (await caches.match(url.pathname, { cacheName: CACHE })) ?? Response.error()));
});
