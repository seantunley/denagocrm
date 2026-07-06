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

export default function PushToggle() {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      return;
    }
    navigator.serviceWorker.register("/sw.js").then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      setEnabled(Boolean(sub));
    });
  }, []);

  async function enable() {
    setBusy(true);
    setStatus("");
    try {
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
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const json = sub.toJSON();
      await savePushSubscription({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
      });
      setEnabled(true);
      setStatus("Notifications enabled on this device ✓");
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
    const r = await sendTestPush();
    setStatus(r.ok ?? r.error ?? "");
    setBusy(false);
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
        Each phone/computer enables separately. iPhone requires the installed Home-Screen app
        (iOS 16.4+). You&apos;ll get a notification whenever a new lead arrives from Facebook,
        the website or WhatsApp.
      </p>
    </div>
  );
}
