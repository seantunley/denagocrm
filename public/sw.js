/* Denago CRM service worker — push, installability and secure offline shell (rev 5) */

const OFFLINE_CACHE = "denago-offline-v1";
const OFFLINE_ASSETS = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png"];

// Take over as soon as a new worker is deployed, instead of waiting for every
// tab to close — otherwise notification icon/badge changes never reach an
// installed PWA that's always open.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("denago-offline-") && key !== OFFLINE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Dynamic CRM pages remain network-only. The one authenticated offline workspace
// shell may be cached after a successful visit; its customer records are never in
// CacheStorage — they live in the tenant/user-partitioned IndexedDB store.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.mode !== "navigate") return;
  if (url.pathname === "/offline") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.put("/offline", copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match("/offline")) || (await caches.match("/offline.html")))
    );
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
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
