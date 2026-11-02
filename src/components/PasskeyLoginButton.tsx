"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";
import { dropPasswordSignIn, markPasskeyOnThisDevice } from "@/lib/passkeyDevice";

/** Passkey support never changes while the page is open: nothing to subscribe to. */
const noSubscribe = () => () => {};

export type PasskeySignIn = ReturnType<typeof usePasskeySignIn>;

/**
 * Discoverable passkey sign-in, no email needed. A hook so the login page can
 * start it from more than one place (the button, the timeout banner, the hint
 * under a failed password) while there is still one sign-in in flight.
 */
export function usePasskeySignIn(pwa: boolean) {
  const router = useRouter();
  // "Not supported" on the server, the truth once in the browser — same as PasskeyManager.
  const supported = useSyncExternalStore(noSubscribe, () => typeof window.PublicKeyCredential !== "undefined", () => false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (busy) return;
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
      // This device really does hold a passkey: show it first next time.
      markPasskeyOnThisDevice();
      dropPasswordSignIn();
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

  return { supported, busy, error, signIn };
}

export default function PasskeyLoginButton({ passkey, disabled = false }: { passkey: PasskeySignIn; disabled?: boolean }) {
  if (!passkey.supported) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={passkey.signIn}
        disabled={passkey.busy || disabled}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-slate-700/70 bg-slate-900/40 px-4 py-3 text-sm font-medium text-slate-200 outline-none transition hover:border-primary/40 hover:text-white focus-visible:ring-4 focus-visible:ring-primary/25 disabled:opacity-60"
      >
        <Fingerprint className={`size-4 text-primary ${passkey.busy ? "animate-pulse" : ""}`} />
        {passkey.busy ? "Waiting for your device…" : "Sign in with a passkey"}
      </button>
      {passkey.error && (
        <p role="alert" className="text-center text-xs text-red-400">
          {passkey.error}
        </p>
      )}
    </div>
  );
}
