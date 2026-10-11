"use client";

import { useEffect } from "react";

const HEARTBEAT_MS = 15_000;

/**
 * Tells the workspace that the signer has the document open: for how long it
 * has actually been IN VIEW, and the furthest page that came into view.
 *
 * - Time counts only while the tab is visible. A tab left open behind another
 *   window is not time spent reading.
 * - The furthest page is measured, from the page wrappers on the signing page
 *   (`[data-sign-page]`), not assumed.
 * - Fire-and-forget: a failed report never blocks or delays signing.
 */
export function ViewBeacon({ token }: { token: string }) {
  useEffect(() => {
    const url = `/api/signing/${token}/view`;
    let viewId: string | null = null;
    let stopped = false;
    let visibleMs = 0;
    let visibleSince: number | null = document.visibilityState === "visible" ? Date.now() : null;
    let maxPage = 1;

    const seconds = () => Math.round((visibleMs + (visibleSince === null ? 0 : Date.now() - visibleSince)) / 1000);
    const send = (event: "heartbeat" | "close") => {
      if (!viewId) return;
      const body = JSON.stringify({ event, viewId, seconds: seconds(), page: maxPage });
      // sendBeacon survives the page going away; fetch is the fallback where it is missing or refuses.
      if (event === "close" && navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
      void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    };

    void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "open" }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { viewId?: string } | null) => { if (!stopped && data?.viewId) viewId = data.viewId; })
      .catch(() => {});

    // The furthest page that has been (at least a third) in view.
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const n = Number((entry.target as HTMLElement).dataset.signPage);
        if (Number.isFinite(n) && n > maxPage) maxPage = n;
      }
    }, { threshold: 0.33 });
    document.querySelectorAll("[data-sign-page]").forEach((el) => seen.observe(el));

    const tick = window.setInterval(() => { if (document.visibilityState === "visible") send("heartbeat"); }, HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") { visibleSince = Date.now(); return; }
      if (visibleSince !== null) { visibleMs += Date.now() - visibleSince; visibleSince = null; }
      send("close");
    };
    const onPageHide = () => send("close");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      stopped = true;
      window.clearInterval(tick);
      seen.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      send("close");
    };
  }, [token]);

  return null;
}
