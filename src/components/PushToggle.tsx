"use client";

import { useEffect, useState } from "react";
import {
  savePushSubscription,
  removePushSubscription,
  sendTestPush,
} from "@/app/actions/push";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function syncPushSubscription(sub: PushSubscription) {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) throw new Error("This browser returned an incomplete push subscription.");
  await savePushSubscription({ endpoint: sub.endpoint, keys: { p256dh, auth } });
}

type PushToggleProps = {
  mode?: "crm" | "messages";
};

type PushTestSignal = {
  type?: string;
  testId?: string;
  error?: string;
};

const ROOT_SW = "/sw.js";
const MESSAGES_SW = "/messages-sw.js";

async function registrationForMode(mode: "crm" | "messages") {
  const reg = await navigator.serviceWorker.register(
    mode === "messages" ? MESSAGES_SW : ROOT_SW,
    mode === "messages"
      ? { scope: "/messages/", updateViaCache: "none" }
      : { scope: "/", updateViaCache: "none" },
  );
  void reg.update().catch(() => {});
  return reg;
}

async function waitUntilActive(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return;
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return;
  if (worker.state === "activated") return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener("statechange", onChange);
      reject(new Error("The notification service worker did not activate in time. Close and reopen the app, then try again."));
    }, 8000);
    const onChange = () => {
      if (worker.state !== "activated") return;
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", onChange);
      resolve();
    };
    worker.addEventListener("statechange", onChange);
  });
}

async function rootSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(`${window.location.origin}/`);
  if (!reg || !reg.scope.endsWith("/")) return null;
  // A more-specific /messages/ registration also ends in '/', so identify the
  // root registration by its exact scope URL.
  if (reg.scope !== `${window.location.origin}/`) return null;
  return reg.pushManager.getSubscription();
}

async function removeLegacyRootSubscription(currentEndpoint: string): Promise<boolean> {
  const legacy = await rootSubscription();
  if (!legacy || legacy.endpoint === currentEndpoint) return false;

  // Save the dedicated Messages subscription FIRST. Only once it is durable do
  // we remove the old shared root subscription, otherwise a failed migration can
  // leave the phone with no notification channel at all.
  await removePushSubscription(legacy.endpoint);
  await legacy.unsubscribe();
  return true;
}

export default function PushToggle({ mode = "crm" }: PushToggleProps) {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [repairNeeded, setRepairNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function initialise() {
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        if (!cancelled) setSupported(false);
        return;
      }

      try {
        const reg = await registrationForMode(mode);
        await waitUntilActive(reg).catch(() => {});
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;

        const granted = Notification.permission === "granted";
        setEnabled(Boolean(sub) && granted);

        if (sub && granted) {
          try {
            await syncPushSubscription(sub);
            if (mode === "messages") {
              const cleaned = await removeLegacyRootSubscription(sub.endpoint).catch(() => false);
              if (cleaned && !cancelled) {
                setStatus("Messages notifications migrated to this app's dedicated channel ✓");
              }
            }
          } catch (error) {
            if (!cancelled) {
              setStatus(
                error instanceof Error
                  ? `Notifications exist on this device, but sync failed: ${error.message}`
                  : "Notifications exist on this device, but the server could not sync them.",
              );
            }
          }
          return;
        }

        if (mode === "messages" && !sub) {
          // Before this fix the Messages PWA borrowed the root CRM registration.
          // That made the panel say "enabled" because the origin had a subscription,
          // even though the installed Messages app had no push channel of its own.
          const legacy = await rootSubscription();
          if (legacy && !cancelled) {
            setRepairNeeded(true);
            setStatus(
              "This installation is still using the old shared CRM notification channel. Tap Repair notifications once to move Denago Messages onto its own channel.",
            );
          }
        }

        if (Notification.permission === "denied" && !cancelled) {
          setStatus(
            "Notifications are blocked by this device. Allow notifications for Denago Messages in Android/iPhone app settings, then return here and repair them.",
          );
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Could not initialise notifications.");
        }
      }
    }

    void initialise();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  async function enable() {
    setBusy(true);
    setStatus("");
    try {
      if (!("Notification" in window)) {
        setSupported(false);
        return;
      }

      // Keep this on the button click. Mobile browsers require a user gesture for
      // notification permission; doing it from the mount effect is not equivalent.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(
          mode === "messages"
            ? "Denago Messages does not have notification permission. Allow it in the phone's app notification settings, then tap Repair notifications again."
            : "Permission denied — allow notifications in your browser/phone settings.",
        );
        return;
      }

      const reg = await registrationForMode(mode);
      await waitUntilActive(reg);
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) {
        setStatus("Push keys not configured on the server.");
        return;
      }

      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        }));

      await syncPushSubscription(sub);
      if (mode === "messages") {
        await removeLegacyRootSubscription(sub.endpoint).catch(() => false);
      }
      setEnabled(true);
      setRepairNeeded(false);
      setStatus(
        mode === "messages"
          ? "Denago Messages notifications repaired and synced on this device ✓"
          : "Notifications enabled and synced on this device ✓",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await registrationForMode(mode);
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await removePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setEnabled(false);
      setRepairNeeded(false);
      setStatus("Notifications disabled on this device.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus("");
    let onMessage: ((event: MessageEvent) => void) | null = null;
    let timeoutId: number | null = null;

    try {
      if (!("Notification" in window) || Notification.permission !== "granted") {
        setEnabled(false);
        setStatus("Notifications are not allowed on this device. Enable/repair them first, then test again.");
        return;
      }

      const reg = await registrationForMode(mode);
      await waitUntilActive(reg);
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setEnabled(false);
        setRepairNeeded(mode === "messages");
        setStatus(
          mode === "messages"
            ? "Denago Messages has no dedicated push subscription yet. Tap Repair notifications, then test again."
            : "This device has no active push subscription. Enable notifications again, then test.",
        );
        return;
      }

      await syncPushSubscription(sub);

      const testId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      let resolveSignal: (signal: PushTestSignal) => void = () => {};
      const signalPromise = new Promise<PushTestSignal>((resolve) => {
        resolveSignal = resolve;
      });

      onMessage = (event: MessageEvent) => {
        const signal = event.data as PushTestSignal | null;
        if (!signal || signal.testId !== testId) return;
        if (signal.type === "push-test-displayed" || signal.type === "push-test-failed") {
          resolveSignal(signal);
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);

      // Test ONLY this endpoint. Broadcasting the test to every saved device was
      // the false-positive in the screenshot: another phone could accept it and
      // the current Messages PWA still received nothing.
      const r = await sendTestPush({ mode, testId, endpoint: sub.endpoint });
      if (r.error) {
        setStatus(r.error);
        return;
      }

      setStatus(`${r.ok ?? "This device's push service accepted the test."} Waiting for this device to confirm display…`);

      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(null), 10_000);
      });
      const signal = await Promise.race([signalPromise, timeoutPromise]);

      if (signal?.type === "push-test-displayed") {
        setStatus("Test notification reached the Denago Messages worker on this device ✓");
      } else if (signal?.type === "push-test-failed") {
        setStatus(
          `Push reached this device, but notification display failed${signal.error ? `: ${signal.error}` : "."} Allow notifications for Denago Messages in the phone's app settings.`,
        );
      } else {
        setStatus(
          "This device's push service accepted the test, but the Denago Messages worker never received it. Tap Repair notifications once. If it still fails, allow notifications for Denago Messages in the phone's app settings and remove battery restrictions for the app.",
        );
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not test notifications.");
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (onMessage) navigator.serviceWorker.removeEventListener("message", onMessage);
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <p className="text-sm text-slate-400">
        This browser doesn&apos;t support push. On iPhone: install the app to your Home Screen
        first (Share → Add to Home Screen), then enable notifications from inside the installed
        app.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {enabled ? (
          <>
            <button className="btn-secondary" onClick={disable} disabled={busy}>
              🔕 Disable on this device
            </button>
            <button className="btn-primary" onClick={test} disabled={busy}>
              Send test notification
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={enable} disabled={busy}>
            {repairNeeded ? "🔧 Repair notifications" : "🔔 Enable notifications on this device"}
          </button>
        )}
      </div>
      {status && <p className="text-sm text-slate-300">{status}</p>}
      <p className="text-xs text-slate-500">
        {mode === "messages" ? (
          <>
            Denago Messages now uses its own push channel. The test targets this phone only; another
            subscribed device can no longer make this screen report a false success.
          </>
        ) : (
          <>
            Each phone/computer enables separately. iPhone requires the installed Home-Screen app
            (iOS 16.4+). You&apos;ll get a notification whenever a new lead arrives from Facebook,
            the website or WhatsApp.
          </>
        )}
      </p>
    </div>
  );
}
