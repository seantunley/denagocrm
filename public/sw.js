/* Denago CRM service worker — push notifications + installability (rev 3) */

// Take over as soon as a new worker is deployed, instead of waiting for every
// tab to close — otherwise notification icon/badge changes never reach an
// installed PWA that's always open.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Chrome only fires beforeinstallprompt (and considers the app installable) when
// a service worker with a fetch handler is present. This is a deliberate no-op
// pass-through: we do NOT call event.respondWith, so every request is handled by
// the browser exactly as if no worker existed — no caching, no offline, no change
// to network behaviour. Its mere presence is what unlocks installability.
self.addEventListener("fetch", (event) => {
  /* pass-through: let the browser handle the request normally */
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Denago CRM", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      // Android tints the badge to a flat silhouette from its alpha, so this
      // must be a transparent D mark (a solid image renders as a white block).
      badge: "/icons/badge-96.png",
      data: { url: data.url || "/" },
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
