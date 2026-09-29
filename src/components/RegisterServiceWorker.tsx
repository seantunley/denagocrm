"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that belongs to the installed Messages PWA.
 *
 * Do not register the root CRM worker here. The two PWAs live on the same origin,
 * but a PushSubscription belongs to a ServiceWorkerRegistration. Giving Messages
 * the more-specific /messages registration means it no longer borrows the CRM's
 * subscription/worker and then reports the root channel as "enabled".
 *
 * The scope deliberately has no trailing slash: the main inbox route is exactly
 * `/messages`, so `/messages/` would fail to control the screen shown in the PWA.
 */
export default function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/messages-sw.js", { scope: "/messages", updateViaCache: "none" })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {
        /* registration is best-effort; PushToggle surfaces an actionable error */
      });
  }, []);

  return null;
}
