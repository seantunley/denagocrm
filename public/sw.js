/* Denago CRM service worker — push notifications + installability (rev 4) */

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

/**
 * ONE worker, TWO installed apps.
 *
 * The CRM and Denago Messages share this service worker — a browser allows one
 * per scope, and Messages is scoped under the CRM's origin. So the notification
 * cannot ask "which app am I?"; there is only one. What it can ask is what the
 * notification is ABOUT, and the server now sends `kind` for exactly that.
 *
 * These are the conversation kinds — the ones a person reading the Messages app
 * is there for. Everything else (backups, system errors, quotes, reviews) is CRM
 * work and keeps the CRM mark, so a backup failure never arrives dressed as a
 * customer message.
 */
const MESSAGING_KINDS = new Set(["dm", "whatsapp", "bot_handoff", "email_in", "portal_case"]);

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const messaging = MESSAGING_KINDS.has(data.kind);
  event.waitUntil(
    self.registration.showNotification(data.title || (messaging ? "Denago Messages" : "Denago CRM"), {
      body: data.body || "",
      icon: messaging ? "/icons/messages-192.png" : "/icons/icon-192.png",
      // Android throws the colour away and tints a flat silhouette from the ALPHA
      // channel, so both of these must be a transparent mark on nothing — a solid
      // image renders as a white block. messages-badge-96 is the D lifted off its
      // field for that reason; it is not the app icon scaled down.
      badge: messaging ? "/icons/messages-badge-96.png" : "/icons/badge-96.png",
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
