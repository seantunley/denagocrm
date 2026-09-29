/* Denago Messages service worker — dedicated /messages push channel (rev 1) */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The Messages PWA needs its own registration rather than borrowing the root CRM
// worker. A PushSubscription belongs to a ServiceWorkerRegistration, so this gives
// the installed Messages app a distinct subscription and a worker whose scope is
// /messages/. The no-op fetch handler also keeps the nested PWA installable.
self.addEventListener("fetch", () => {
  /* pass-through */
});

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
  const url = data.url || "/messages";
  const testId = testIdFromUrl(url);

  const display = self.registration.showNotification(
    data.title || (messaging ? "Denago Messages" : "Denago CRM"),
    {
      body: data.body || "",
      icon: messaging ? "/icons/messages-192.png" : "/icons/icon-192.png",
      badge: messaging ? "/icons/messages-badge-96.png" : "/icons/badge-96.png",
      data: { url },
      vibrate: [100, 50, 100],
    },
  );

  event.waitUntil(
    display
      .then(async () => {
        if (testId) await notifyOpenClients({ type: "push-test-displayed", testId });
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
  const url = (event.notification.data && event.notification.data.url) || "/messages";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Prefer the installed Messages window when one exists. Do not focus the
      // first unrelated CRM tab and make a message notification appear broken.
      const messagesClient = list.find((client) => {
        try {
          return new URL(client.url).pathname.startsWith("/messages");
        } catch {
          return false;
        }
      });
      const target = messagesClient || list[0];
      if (target && "focus" in target) {
        target.focus();
        if ("navigate" in target) target.navigate(url);
        return;
      }
      return clients.openWindow(url);
    }),
  );
});
