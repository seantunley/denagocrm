"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal shape of the bits of the Telegram WebApp SDK we touch.
type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme?: "light" | "dark";
  themeParams?: { bg_color?: string };
  MainButton?: { hide: () => void };
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
};
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const SDK_SRC = "https://telegram.org/js/telegram-web-app.js";

type Phase = "loading" | "outside" | "needsLink" | "linking" | "success" | "error";

function loadSdk(): Promise<TelegramWebApp | null> {
  return new Promise((resolve) => {
    if (window.Telegram?.WebApp) return resolve(window.Telegram.WebApp);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_SRC}"]`);
    const done = () => resolve(window.Telegram?.WebApp ?? null);
    if (existing) {
      existing.addEventListener("load", done, { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => resolve(null), { once: true });
    document.head.appendChild(script);
  });
}

export default function TelegramLauncher() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("Verifying your Telegram sign-in…");
  const [code, setCode] = useState("");
  const initDataRef = useRef<string>("");

  const goToApp = useCallback(() => {
    // Full navigation so the freshly-set session cookie is sent and the CRM
    // shell renders server-side.
    window.location.assign("/");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tg = await loadSdk();
      if (cancelled) return;
      if (!tg || !tg.initData) {
        setPhase("outside");
        return;
      }
      tg.ready();
      tg.expand();
      initDataRef.current = tg.initData;

      try {
        const res = await fetch("/api/telegram/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: tg.initData }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.linked) {
          setPhase("success");
          setMessage("Signed in — opening your CRM…");
          goToApp();
        } else if (res.ok && data.linked === false) {
          setPhase("needsLink");
        } else {
          setPhase("error");
          setMessage(data.error ?? "Could not verify your Telegram sign-in.");
        }
      } catch {
        if (!cancelled) {
          setPhase("error");
          setMessage("Network error — check your connection and try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goToApp]);

  const submitCode = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (code.trim().length < 6) return;
      setPhase("linking");
      try {
        const res = await fetch("/api/telegram/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: initDataRef.current, code: code.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setPhase("success");
          setMessage("Linked — opening your CRM…");
          goToApp();
        } else {
          setPhase("needsLink");
          setMessage(data.error ?? "That code didn't work. Try again.");
        }
      } catch {
        setPhase("needsLink");
        setMessage("Network error — try again.");
      }
    },
    [code, goToApp],
  );

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 py-10 text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/branding/denago-mark.png" alt="Denago" className="size-14 rounded-2xl" />
        <div>
          <h1 className="text-lg font-semibold">Denago CRM</h1>
          <p className="mt-1 text-sm text-muted-foreground">Telegram sign-in</p>
        </div>
      </div>

      {(phase === "loading" || phase === "success" || phase === "linking") && (
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      )}

      {phase === "outside" && (
        <div className="max-w-sm rounded-2xl border border-border bg-card p-5 text-center text-sm text-muted-foreground">
          Open this page from inside Telegram — tap the Denago bot’s <span className="text-foreground">Open</span> button
          or its Mini App link. It can’t verify you in a normal browser.
        </div>
      )}

      {phase === "error" && (
        <div className="max-w-sm rounded-2xl border border-destructive/40 bg-destructive/10 p-5 text-center text-sm text-foreground">
          {message}
        </div>
      )}

      {phase === "needsLink" && (
        <form onSubmit={submitCode} className="w-full max-w-sm space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              First time here? In the CRM on your computer, open{" "}
              <span className="text-foreground">Settings → Telegram</span>, tap{" "}
              <span className="text-foreground">Generate link code</span>, and type it below.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="LINK CODE"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={12}
              className="input mt-4 text-center text-lg font-semibold tracking-[0.3em]"
            />
            {message && phase === "needsLink" && message !== "Verifying your Telegram sign-in…" && (
              <p className="mt-2 text-center text-xs text-destructive">{message}</p>
            )}
          </div>
          <button type="submit" disabled={code.trim().length < 6} className="btn-primary w-full">
            Link &amp; sign in
          </button>
        </form>
      )}
    </div>
  );
}
