// Anne's Lens service worker: makes the web app (and the ChromeOS / desktop-browser install) work
// offline. The build writes the list of its own files into PRECACHE and names the cache after them,
// so every script and stylesheet of a release is stored at install (offline works after one visit)
// and the cache of the previous release is removed when this one takes over. Pages are network-first
// so an update shows on the next visit; other same-origin files are served from the cache and
// refreshed in the background. Only successful answers are stored.
const PRECACHE = /* precache */ ['./', './index.html', './manifest.webmanifest'];
const CACHE = /* cache */ 'quilllens-dev';

self.addEventListener('install', (e) => {
  // One missing file must not leave the whole release uncached: each is stored on its own.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) => fetch(u, { cache: 'reload' }).then((res) => (res.ok ? c.put(u, res) : undefined)).catch(() => undefined)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('quilllens-')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      // A 404 or a server error page is shown as it is, never stored as the app's page.
      if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put('./index.html', copy)); }
      return res;
    }).catch(async () => (await caches.match('./index.html', { ignoreVary: true })) || Response.error()));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreVary: true }); // the precached copy was fetched without the Origin header a module script request carries
    const fresh = fetch(req).then((res) => { if (res.ok) void c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || fresh;
  }));
});
