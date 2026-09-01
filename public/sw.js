/* Denago CRM service worker — push, installability and secure offline shell (rev 5) */

const OFFLINE_CACHE = "denago-offline-v1";
const OFFLINE_ASSETS = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png"];

/*
 * THE CACHED SHELL NAMES A USER, SO IT CANNOT OUTLIVE THEM.
 *
 * The /offline response is server-rendered for whoever fetched it and carries
 * their tenantId and userId in the markup. OfflineProvider reads those to pick
 * an IndexedDB partition — so a shell cached for one user, served later to
 * another, points the app straight at the first user's cached CRM records. On a
 * shared device that is a cross-user disclosure, and the sign-out path cannot
 * prevent it: a session that simply EXPIRES never runs it.
 *
 * The shell is therefore stamped with its owner, and the app announces the
 * signed-in identity from every authenticated page it renders. A mismatch means
 * the device has changed hands: the shell is dropped, and re-warmed for the new
 * owner while the network is still there, so switching users does not silently
 * cost them offline mode.
 *
 * RESIDUAL, AND INHERENT: within the 72-hour data lifetime, someone holding an
 * unlocked device on which a user was signed in can read that user's cached
 * records offline, because offline there is no session to check. Bounding it
 * further needs at-rest encryption behind a device secret, which is a larger
 * change than this feature.
 */
const SHELL_KEY = "/offline";
const SHELL_OWNER_KEY = "/__offline-shell-owner";

async function cachedShellOwner(cache) {
  const stamped = await cache.match(SHELL_OWNER_KEY);
  return stamped ? stamped.text() : null;
}

async function claimShell(owner) {
  const cache = await caches.open(OFFLINE_CACHE);
  if ((await cachedShellOwner(cache)) === owner) return;
  await cache.delete(SHELL_KEY);
  await cache.put(SHELL_OWNER_KEY, new Response(owner));
  // Re-warm for the new owner. This runs from a page that has just rendered, so
  // the network is there; if it is not, /offline.html remains the fallback.
  try {
    const fresh = await fetch(SHELL_KEY, { credentials: "include" });
    // THE SAME CHECK AS THE NAVIGATION PATH, and for the same reason: if the
    // session expired while this ran, /offline redirects to /login and fetch
    // FOLLOWS it, so `ok` is true and the body is a sign-in form. Storing that
    // as the authenticated shell is the failure this whole re-warm exists to
    // avoid.
    const freshPath = (() => {
      try {
        return new URL(fresh.url || SHELL_KEY, self.location.origin).pathname;
      } catch {
        return null;
      }
    })();
    if (fresh.ok && !fresh.redirected && freshPath === SHELL_KEY) {
      await cache.put(SHELL_KEY, fresh);
    }
  } catch {
    /* offline — leave it uncached rather than storing an error page */
  }
}

async function forgetShell() {
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all([cache.delete(SHELL_KEY), cache.delete(SHELL_OWNER_KEY)]);
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "offline-shell-owner" && typeof data.owner === "string" && data.owner) {
    event.waitUntil(claimShell(data.owner));
  } else if (data.type === "offline-shell-forget") {
    event.waitUntil(forgetShell());
  }
});

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
          /*
           * A 200 IS NOT PROOF THIS IS THE SHELL.
           *
           * When the session has expired, /offline redirects to /login and fetch
           * FOLLOWS it — so `response.ok` is true and the body is the login
           * page. Caching that overwrote the authenticated shell with a sign-in
           * form, and the next time the device lost connectivity the fallback
           * served it: no workspace, no queued work reachable, and no way to
           * sign in either, because signing in needs the network.
           *
           * `redirected` catches the followed hop and the pathname check catches
           * a rewrite that did not set it.
           */
          const finalPath = (() => {
            try {
              return new URL(response.url || event.request.url).pathname;
            } catch {
              return null;
            }
          })();
          if (response.ok && !response.redirected && finalPath === SHELL_KEY) {
            const copy = response.clone();
            event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.put(SHELL_KEY, copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match(SHELL_KEY)) || (await caches.match("/offline.html")))
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
