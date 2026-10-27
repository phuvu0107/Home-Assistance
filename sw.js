// Offline support: cache the app shell, always try the network first for weather.
const CACHE = 'home-dashboard-v73';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'people.js', 'schedule.js', 'alerts.js', 'firebase.js', 'account.js', 'admin.js', 'sync.js', 'social.js', 'photos.js', 'receipt.js', 'receipt-words.js', 'sync-config.js', 'health.js', 'health-config.js', 'feedback-config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'avatars/phu.svg', 'avatars/nhi.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Live data (weather, the sync database) always goes straight to the network.
  // version.txt is how open screens notice a new deploy, so it never comes from the cache.
  if (e.request.method !== 'GET' || url.pathname.endsWith('/version.txt') || url.hostname.endsWith('open-meteo.com') || url.hostname === 'firestore.googleapis.com'
    || url.hostname === 'health.googleapis.com' || url.hostname === 'accounts.google.com') return;
  // Network first so updates show up right away; fall back to cache when offline.
  // Same-site files are checked with the server every time (a quick "not modified" when
  // nothing changed), so a new deploy shows up on the next reload instead of up to 10 minutes later.
  const sameSite = url.origin === self.location.origin;
  e.respondWith(
    fetch(sameSite ? new Request(e.request.url, { cache: 'no-cache' }) : e.request)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
