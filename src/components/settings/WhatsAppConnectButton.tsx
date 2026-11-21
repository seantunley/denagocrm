"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseSignupHandoff } from "@/lib/whatsappSignupMessage";

/**
 * Opens Connect WhatsApp's popup (on the platform's address) and takes back ONLY its handoff — from that exact origin,
 * in that exact shape — then posts it to /finish here, behind this person's session (lib/whatsappConnect.ts).
 * The window is opened on the click itself, so pop-up blockers allow it.
 */
export function WhatsAppConnectButton({ platformOrigin, label }: { platformOrigin: string; label: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const handoff = parseSignupHandoff(event.origin, platformOrigin, event.data);
      if (!handoff) return;
      setBusy(true);
      setMessage("Connecting your number…");
      const res = await fetch("/api/integrations/whatsapp/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(handoff) }).catch(() => null);
      const body = ((await res?.json().catch(() => null)) ?? {}) as { connected?: string; error?: string };
      setBusy(false);
      if (res?.ok && body.connected) {
        setMessage(`Connected: ${body.connected}`);
        router.refresh();
      } else {
        setMessage(body.error ?? "Connect WhatsApp could not be completed. Please try again.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [platformOrigin, router]);

  const start = async () => {
    setMessage(null);
    const popup = window.open("about:blank", "honeycomb-wa-signup", "width=640,height=820");
    const res = await fetch("/api/integrations/whatsapp/start", { method: "POST" }).catch(() => null);
    const body = ((await res?.json().catch(() => null)) ?? {}) as { popupUrl?: string; error?: string };
    if (!res?.ok || !body.popupUrl) {
      popup?.close();
      setMessage(body.error ?? "Connect WhatsApp could not start. Please try again.");
      return;
    }
    if (!popup) {
      setMessage("Your browser blocked the window. Allow pop-ups for this site, then press the button again.");
      return;
    }
    popup.location.href = body.popupUrl;
  };

  return (
    <div className="space-y-2">
      <button type="button" onClick={start} disabled={busy} className="btn-primary btn-sm">{label}</button>
      {message && <p className="text-xs text-amber-300">{message}</p>}
    </div>
  );
}
