"use client";

import { useEffect, useRef, useState } from "react";

/** How often, at most, activity on the page refreshes the session. */
const PING_EVERY_MS = 5 * 60 * 1000;

/**
 * Keeps a working person signed in, and says so when they aren't.
 *
 * Typing into a form makes no request, so the 60-minute idle timeout used to
 * run out underneath someone filling in a long form, and the Save that followed
 * bounced to /login and threw the page away. Now:
 *  - activity (typing, clicking) pings /api/session at most every 5 minutes,
 *    which slides the idle window, so an attended page never times out;
 *  - coming back to the tab checks straight away, and if the session did lapse
 *    (tab left alone past the timeout) a banner says so BEFORE they press Save,
 *    with a sign-in that opens in a new tab so this page and its typing survive.
 */
export default function SessionKeeper() {
  const [expired, setExpired] = useState(false);
  const lastActivity = useRef(0);
  const lastPing = useRef(0);

  useEffect(() => {
    lastPing.current = Date.now(); // the page load itself just refreshed the session
    const check = async () => {
      lastPing.current = Date.now();
      try {
        const res = await fetch("/api/session", { cache: "no-store" });
        setExpired(res.status === 401);
      } catch {
        // Offline or a blip: say nothing rather than claim a sign-out.
      }
    };
    const onActivity = () => {
      lastActivity.current = Date.now();
    };
    const tick = () => {
      if (lastActivity.current > lastPing.current && Date.now() - lastPing.current >= PING_EVERY_MS) void check();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const events = ["keydown", "pointerdown", "input"] as const;
    for (const e of events) window.addEventListener(e, onActivity, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(tick, 60 * 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  if (!expired) return null;
  return (
    <div role="alert" className="fixed inset-x-0 top-0 z-[1000] flex flex-wrap items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-950/95 px-4 py-2 text-sm text-amber-100">
      <span>You&apos;ve been signed out. Nothing on this page is lost: sign in in a new tab, then come back here and save.</span>
      <a href="/login" target="_blank" rel="noopener" className="rounded-md bg-amber-500 px-3 py-1 font-medium text-black hover:bg-amber-400">
        Sign in (new tab)
      </a>
    </div>
  );
}
