"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";

/** "Sign in with a passkey" — discoverable login, no email needed. */
export default function PasskeyLoginButton({ pwa }: { pwa: boolean }) {
  const router = useRouter();
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(typeof window.PublicKeyCredential !== "undefined");
  }, []);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/passkey/auth/options", { method: "POST" });
      if (!optRes.ok) throw new Error("Could not start passkey sign-in.");
      const options = await optRes.json();

      const assertion = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: assertion, pwa }),
      });
      const data = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(data.error ?? "Passkey sign-in failed.");
      router.replace("/");
      router.refresh();
    } catch (e) {
      if (e instanceof Error && e.name === "NotAllowedError") {
        setBusy(false);
        return; // user dismissed the prompt
      }
      setError(e instanceof Error ? e.message : "Passkey sign-in failed.");
      setBusy(false);
    }
  }

  if (!supported) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-slate-600">
        <span className="h-px flex-1 bg-slate-800" />
        or
        <span className="h-px flex-1 bg-slate-800" />
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-700/70 bg-slate-900/40 px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-orange-400/40 hover:text-white disabled:opacity-60"
      >
        <Fingerprint className={`size-4 ${busy ? "animate-pulse text-orange-300" : "text-orange-400"}`} />
        {busy ? "Waiting for your device…" : "Sign in with a passkey"}
      </button>
      {error && (
        <p role="alert" className="text-center text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
