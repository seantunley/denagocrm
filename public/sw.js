/* Denago CRM service worker — push notifications + installability (rev 5) */

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
self.addEventListener("fetch", () => {
  /* pass-through: let the browser handle the request normally */
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
