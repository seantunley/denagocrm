"use client";

import { useEffect } from "react";

const HEARTBEAT_MS = 15_000;

/**
 * Reports that the signer has the document open. Fire-and-forget: a failed
 * beacon never blocks signing. Heartbeats only run while the tab is visible.
 */
export function ViewBeacon({ token }: { token: string }) {
  useEffect(() => {
    let viewId: string | null = null;
    let seconds = 0;
    let stopped = false;
    const started = Date.now();

    const send = (event: "open" | "heartbeat" | "close", keepalive = false) => {
      const body = JSON.stringify({
        event,
        viewId,
        seconds: Math.round((Date.now() - started) / 1000),
        page: 1,
        sections: [...document.querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section")).filter(Boolean),
      });
      if (keepalive && navigator.sendBeacon) {
        navigator.sendBeacon(`/api/signing/${token}/view`, new Blob([body], { type: "application/json" }));
        return;
      }
      void fetch(`/api/signing/${token}/view`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive }).catch(() => {});
    };

    void fetch(`/api/signing/${token}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "open" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { viewId?: string } | null) => {
        if (!stopped && data?.viewId) viewId = data.viewId;
      })
      .catch(() => {});

    const tick = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !viewId) return;
      seconds = Math.round((Date.now() - started) / 1000);
      send("heartbeat");
    }, HEARTBEAT_MS);

    const close = () => send("close", true);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") close();
    });
    window.addEventListener("pagehide", close);

    return () => {
      stopped = true;
      window.clearInterval(tick);
      close();
    };
  }, [token]);

  return null;
}
