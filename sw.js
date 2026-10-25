/* Quarter Hour service worker: offline copy of the app + notification clicks */
const CACHE = 'quarter-hour-v3';
const ASSETS = [
  './', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './lib/xlsx.full.min.js', './icons/icon-192.png', './icons/icon-512.png', './icons/msf-logo-square-navy.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates arrive), cached copy when offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

self.addEventListener('notificationclick', (e) => {
  const key = (e.notification.data && e.notification.data.key) || '';
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      const c = all[0];
      await c.focus();
      c.postMessage({ type: 'open-picker', key });
      return;
    }
    await self.clients.openWindow('./?slot=' + encodeURIComponent(key));
  })());
});
