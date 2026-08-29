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
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      }))
    );
    return;
  }
  if (event.request.mode !== "navigate") return;
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
 * notification is ABOUT, and the server sends `kind` for exactly that.
 */
const MESSAGING_KINDS = new Set(["dm", "whatsapp", "bot_handoff", "email_in", "portal_case"]);

function testIdFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, self.location.origin).searchParams.get("push-test");
  } catch {
    return null;
  }
}

async function notifyOpenClients(message) {
  const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of list) client.postMessage(message);
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const messaging = MESSAGING_KINDS.has(data.kind);
  const url = data.url || "/";
  const testId = testIdFromUrl(url);

  const display = self.registration.showNotification(
    data.title || (messaging ? "Denago Messages" : "Denago CRM"),
    {
      body: data.body || "",
      icon: messaging ? "/icons/messages-192.png" : "/icons/icon-192.png",
      // Android tints a flat silhouette from the alpha channel for the status-bar
      // badge, so use the transparent mark rather than the full app tile.
      badge: messaging ? "/icons/messages-badge-96.png" : "/icons/badge-96.png",
      data: { url },
      vibrate: [100, 50, 100],
    },
  );

  event.waitUntil(
    display
      .then(async () => {
        if (testId) {
          // The provider accepting a push only proves that it reached Google's /
          // Apple's service. This acknowledgement proves the service worker on
          // THIS device also received the event and showNotification resolved.
          await notifyOpenClients({ type: "push-test-displayed", testId });
        }
      })
      .catch(async (error) => {
        if (testId) {
          await notifyOpenClients({
            type: "push-test-failed",
            testId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }),
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
    }),
  );
});
