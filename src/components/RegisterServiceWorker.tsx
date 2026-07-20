"use client";

import { useEffect } from "react";

/**
 * Registers the app service worker (/sw.js) on mount. This is what makes the
 * Messages PWA installable: without an active worker (with a fetch handler)
 * Chrome never fires `beforeinstallprompt`. Registration is idempotent, so it is
 * safe alongside PushToggle's own register call. Renders nothing.
 */
export default function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* registration is best-effort; ignore failures (e.g. unsupported/insecure) */
    });
  }, []);

  return null;
}
