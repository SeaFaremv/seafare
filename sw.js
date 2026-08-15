// SeaFare Super Admin push notification service worker.
//
// This only ever handles push notifications for the Super Admin dashboard
// -- it doesn't do anything else (no offline caching, no asset
// interception). It has to be served from the site's root (same level as
// index.html) because a service worker can only control pages within its
// own scope, and registration happens as navigator.serviceWorker.register
// ('/sw.js') from index.html.

self.addEventListener('push', (event) => {
  let data = { title: 'SeaFare Super Admin', body: 'You have a new notification.' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    // Payload wasn't JSON for some reason -- fall back to the default text
    // above rather than failing to show anything at all.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'seafare-admin-push', // replaces any still-showing push notification instead of stacking endlessly
      data: { url: '/#admin' },
    })
  );
});

// Tapping the notification focuses an already-open SeaFare tab if there is
// one, or opens a new one straight to the admin dashboard if not.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/#admin';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
