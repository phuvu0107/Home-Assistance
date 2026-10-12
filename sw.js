// Offline support: cache the app shell, always try the network first for weather.
const CACHE = 'home-dashboard-v16';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'sync.js', 'sync-config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'avatars/phu.svg', 'avatars/nhi.svg'];

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
  if (e.request.method !== 'GET' || url.hostname.endsWith('open-meteo.com') || url.hostname === 'firestore.googleapis.com') return;
  // Network first so updates show up right away; fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
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
