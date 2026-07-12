"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Plus, Trash2, KeyRound } from "lucide-react";
import { removePasskey } from "@/app/actions/passkeys";

export type PasskeyRow = {
  id: string;
  nickname: string | null;
  createdAt: string; // ISO
  lastUsedAt: string | null; // ISO
};

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}

export default function PasskeyManager({ passkeys }: { passkeys: PasskeyRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const supported =
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined";

  async function enrol() {
    setError(null);
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/passkey/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("Could not start enrolment.");
      const options = await optRes.json();

      const attestation = await startRegistration({ optionsJSON: options });

      const defaultName =
        /iPhone|iPad|Android/.test(navigator.userAgent) ? "Phone" : "This device";
      const nickname = window.prompt("Name this passkey", defaultName) ?? defaultName;

      const verifyRes = await fetch("/api/auth/passkey/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: attestation, nickname }),
      });
      const data = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(data.error ?? "Enrolment failed.");
      router.refresh();
    } catch (e) {
      // User cancelling the browser prompt throws — treat that as a no-op.
      if (e instanceof Error && e.name === "NotAllowedError") return;
      setError(e instanceof Error ? e.message : "Enrolment failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        Sign in with your fingerprint, face or device PIN — no password to type or phish. Each
        device you add gets its own passkey. Great on your phone for the installed app.
      </p>

      {passkeys.length > 0 && (
        <ul className="space-y-2">
          {passkeys.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5"
            >
              <KeyRound className="size-4 shrink-0 text-orange-300" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.nickname ?? "Passkey"}</p>
                <p className="text-[11px] text-slate-500">
                  Added {when(p.createdAt)} · last used {when(p.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Remove passkey "${p.nickname ?? "Passkey"}"?`)) return;
                  startTransition(() => removePasskey(p.id).then(() => router.refresh()));
                }}
                className="text-slate-500 transition hover:text-red-400 disabled:opacity-50"
                title="Remove this passkey"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {supported ? (
        <button
          type="button"
          onClick={enrol}
          disabled={busy}
          className="btn-primary btn-sm inline-flex items-center gap-1.5"
        >
          {busy ? (
            <>
              <Fingerprint className="size-4 animate-pulse" /> Waiting for device…
            </>
          ) : (
            <>
              <Plus className="size-4" /> Add a passkey
            </>
          )}
        </button>
      ) : (
        <p className="text-xs text-amber-300/90">
          This browser doesn&apos;t support passkeys. Try Safari, Chrome or Edge on a device with
          a fingerprint reader, Face ID or a PIN.
        </p>
      )}
    </div>
  );
}
