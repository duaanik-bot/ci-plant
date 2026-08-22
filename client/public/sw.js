// Colour Impressions — the service worker that carries a push to the screen.
//
// It is deliberately tiny and does NOT cache anything. A caching service worker
// on a plant ERP is a way to serve yesterday's board figures to somebody making
// a decision on them; this file exists for one job only — receiving a push when
// the app is closed and putting it on the lock screen.

// Take over immediately rather than waiting for every tab to close. A plant
// phone can sit on one page for a whole shift, and a worker stuck "waiting"
// receives nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  // A push with no readable payload still deserves to reach the reader — better
  // a bare "something needs you" than silence.
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = d.title || 'Colour Impressions';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/favicon-32.png',
    // Same request → same tag → the new buzz REPLACES the old one on the lock
    // screen. Three alerts about one job should read as one job.
    tag: d.tag || 'ci-note',
    renotify: true,
    // The deep link travels with the notification, so the tap below knows where
    // to go without asking the server anything.
    data: { link: d.link || '/', kind: d.kind || 'note' },
    // An approval is somebody standing still waiting for an answer; it stays on
    // screen until it is dealt with. Everything else can time out on its own.
    requireInteraction: d.kind === 'mgt_request' || d.kind === 'xs_request',
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = event.notification.data?.link || '/';
  event.waitUntil((async () => {
    const url = new URL(link, self.location.origin);
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a tab that is already on this app rather than opening a second copy
    // of the ERP beside the one the reader already has open. The in-app router
    // handles the route change, so the deep link lands the same way it does
    // from the bell — on the job, with Approve and Reject under it.
    for (const c of tabs) {
      if (new URL(c.url).origin === url.origin && 'navigate' in c) {
        await c.focus();
        try { await c.navigate(url.href); } catch { /* a cross-document navigate can be refused; the focus still helped */ }
        return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
