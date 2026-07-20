"use client";

import { useEffect, useState } from "react";

/**
 * The (Chromium-only) beforeinstallprompt event. Not in the standard DOM lib, so
 * we describe the shape we use.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * "Install app" affordance for the Denago Messages PWA.
 * - Chromium (Android/desktop): captures beforeinstallprompt and offers a button
 *   that triggers the native install prompt.
 * - iOS Safari (no beforeinstallprompt): shows a short Share → Add to Home Screen hint.
 * - Renders nothing once the app is already running standalone (installed).
 */
export default function InstallAppButton() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());
    // iPhone/iPod still report their own UA, but modern iPadOS Safari
    // masquerades as desktop macOS ("Macintosh…"). Detect that case by a Mac UA
    // *with* touch points — real Macs report maxTouchPoints 0 — so the Add to
    // Home Screen hint still shows on iPads.
    const ua = navigator.userAgent;
    const iosPhone = /iPad|iPhone|iPod/.test(ua);
    const iPadOSAsDesktop = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    setIsIOS((iosPhone || iPadOSAsDesktop) && !("MSStream" in window));

    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setInstallEvent(null);
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Already installed / running as an app — nothing to offer.
  if (standalone || installed) return null;

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    // Regardless of accept/dismiss the event can only be used once.
    setInstallEvent(null);
  }

  // Chromium: real install button.
  if (installEvent) {
    return (
      <button
        type="button"
        onClick={install}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm font-medium text-foreground transition hover:bg-primary/20"
      >
        <span aria-hidden>📲</span>
        Install Messages app
      </button>
    );
  }

  // iOS Safari: no programmatic prompt — guide the user.
  if (isIOS) {
    return (
      <p className="rounded-xl border border-sidebar-border bg-sidebar/60 px-4 py-3 text-xs text-muted-foreground">
        <span aria-hidden>📲</span> Install this app: tap{" "}
        <span className="font-medium text-foreground">Share</span> →{" "}
        <span className="font-medium text-foreground">Add to Home Screen</span>.
      </p>
    );
  }

  // Other browsers / already-eligible-but-not-yet-fired: render nothing.
  return null;
}
