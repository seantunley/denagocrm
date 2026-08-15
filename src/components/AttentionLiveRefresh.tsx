"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 60_000;

export default function AttentionLiveRefresh() {
  const router = useRouter();
  const [pendingRefresh, setPendingRefresh] = useState(false);
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      setPendingRefresh(true);
      router.refresh();
      window.setTimeout(() => setPendingRefresh(false), 800);
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    const visibility = () => {
      if (document.visibilityState === "hidden") hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > REFRESH_MS) tick();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [router]);

  return (
    <button type="button" className="btn-ghost btn-sm" onClick={() => router.refresh()} aria-live="polite">
      {pendingRefresh ? "Checking…" : "Refresh"}
    </button>
  );
}
