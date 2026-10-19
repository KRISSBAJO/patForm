/*
 * The console's service worker.
 *
 * Two jobs. It receives push messages and shows them, and a tap on one opens
 * the record the message is about, in the console tab that is already open
 * if there is one. It also lets the console be installed: a manifest and a
 * worker are what a browser wants before it offers "Add to Home Screen".
 *
 * It does not cache the console. The console is a live view of records
 * and approvals, and a cached page that says "nothing waiting" when
 * something is would be worse than a page that says it is offline. Only the
 * offline page itself is kept, so a tap with no signal says so plainly.
 *
 * The one exception is the field checklist page (/field.html), which is
 * built to work without signal: it keeps its own job list and queue on the
 * phone and says when the list was last updated. It and its script are
 * fetched fresh when there is signal and served from the cache when not.
 */
const OFFLINE = '/offline.html';
const FIELD = ['/field.html', '/field.js'];
const CACHE = 'patform-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, ...FIELD])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.origin === self.location.origin && FIELD.includes(url.pathname)) {
    // Network first, so a new version arrives when there is signal.
    event.respondWith(
      fetch(event.request)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); } return res; })
        .catch(() => caches.match(url.pathname)),
    );
    return;
  }
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

self.addEventListener('push', (event) => {
  let data = { title: 'Patform', body: 'Something is waiting for you.', url: '/console', tag: undefined };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* a message we cannot read still deserves a generic notice */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/console', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.startsWith(self.location.origin + '/console'));
      if (existing) return existing.navigate(url).then((c) => (c || existing).focus());
      return self.clients.openWindow(url);
    }),
  );
});
