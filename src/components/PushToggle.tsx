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
  /** Messages uses the DM notification kind, icon and landing page for its test. */
  mode?: "crm" | "messages";
};

type PushTestSignal = {
  type?: string;
  testId?: string;
  error?: string;
};

export default function PushToggle({ mode = "crm" }: PushToggleProps) {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
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
        const reg = await navigator.serviceWorker.register("/sw.js");
        // Do not leave an installed PWA on an old worker until every window has
        // eventually been closed. The worker itself uses skipWaiting/claim; this
        // asks the browser to check for the new script while this screen is open.
        void reg.update().catch(() => {});
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;

        const granted = Notification.permission === "granted";
        setEnabled(Boolean(sub) && granted);

        if (sub && granted) {
          // A local PushSubscription can survive a DB restore, a pruned server row,
          // or a deployment. The old UI only looked at the browser and therefore
          // said "Disable on this device" even when the server had forgotten this
          // endpoint. Re-upsert it whenever the notification panel is opened.
          try {
            await syncPushSubscription(sub);
          } catch (error) {
            if (!cancelled) {
              setStatus(
                error instanceof Error
                  ? `Notifications exist on this device, but sync failed: ${error.message}`
                  : "Notifications exist on this device, but the server could not sync them.",
              );
            }
          }
        } else if (sub && Notification.permission === "denied") {
          setStatus(
            "Notifications are blocked by this device. Allow notifications for the installed app/browser in system settings, then enable them here again.",
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
  }, []);

  async function enable() {
    setBusy(true);
    setStatus("");
    try {
      if (!("Notification" in window)) {
        setSupported(false);
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("Permission denied — allow notifications in your browser/phone settings.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
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
      setEnabled(true);
      setStatus("Notifications enabled and synced on this device ✓");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await removePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setEnabled(false);
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
        setStatus("Notifications are not allowed on this device. Enable them first, then test again.");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setEnabled(false);
        setStatus("This device has no active push subscription. Enable notifications again, then test.");
        return;
      }

      // Heal a missing/stale server row before testing. This is the current device,
      // not an inference from how many other endpoints happen to exist in the DB.
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

      const r = await sendTestPush({ mode, testId });
      if (r.error) {
        setStatus(r.error);
        return;
      }

      setStatus(`${r.ok ?? "Push service accepted the test."} Waiting for this device to confirm display…`);

      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(null), 10_000);
      });
      const signal = await Promise.race([signalPromise, timeoutPromise]);

      if (signal?.type === "push-test-displayed") {
        setStatus("Test notification displayed on this device ✓");
      } else if (signal?.type === "push-test-failed") {
        setStatus(
          `Push reached this device, but the browser/OS could not display it${signal.error ? `: ${signal.error}` : "."} Check the installed app's notification permission in system settings.`,
        );
      } else {
        setStatus(
          `${r.ok ?? "The push service accepted the test."} This device did not confirm receipt. Re-enable notifications on this device and check the installed app's notification permission/battery restrictions.`,
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
            🔔 Enable notifications on this device
          </button>
        )}
      </div>
      {status && <p className="text-sm text-slate-300">{status}</p>}
      <p className="text-xs text-slate-500">
        {mode === "messages" ? (
          <>
            This device is synced automatically. The test uses the same notification kind as
            Messenger/Instagram DMs. If a push is accepted but not displayed, allow notifications
            for the installed Denago Messages app/browser in your phone&apos;s system settings.
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
