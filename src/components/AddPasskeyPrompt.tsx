"use client";

import { useEffect, useState } from "react";
import { Fingerprint, X } from "lucide-react";
import {
  defaultPasskeyNickname,
  dontAskForPasskey,
  passkeyOnThisDevice,
  platformAuthenticatorAvailable,
  registerPasskey,
  settlePasswordSignIn,
  stopAskingForPasskey,
} from "@/lib/passkeyDevice";

/**
 * "Add a passkey for next time?" — offered once, right after a PASSWORD
 * sign-in, on a device with a fingerprint/face/PIN reader that has no passkey
 * of theirs yet. A corner card, never a modal: the person came in to work.
 *
 * Reaching this (signed-in) layout is also what proves the password sign-in
 * worked, so this is where "remember my email" is finally written or cleared.
 */
export default function AddPasskeyPrompt() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!settlePasswordSignIn()) return;
    if (passkeyOnThisDevice() || dontAskForPasskey()) return;
    let live = true;
    void platformAuthenticatorAvailable().then((available) => {
      if (live && available) setShow(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!show) return null;

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      await registerPasskey(defaultPasskeyNickname());
      setMessage("Passkey added. Next time, sign in with your fingerprint, face or PIN.");
    } catch (e) {
      if (e instanceof Error && e.name === "NotAllowedError") return; // they cancelled the device prompt
      if (e instanceof Error && e.name === "InvalidStateError") {
        setMessage("This device already has a passkey for you. Use it next time.");
        return;
      }
      setMessage("Couldn't add a passkey. You can try again from Settings → My Account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Add a passkey"
      className="fixed bottom-20 right-4 z-[900] w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-[#111413]/95 p-4 text-sm text-slate-200 shadow-2xl backdrop-blur-xl md:bottom-4"
    >
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label="Close"
        className="absolute right-2 top-2 rounded-md p-1 text-slate-500 outline-none transition hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <X className="size-4" />
      </button>
      <div className="flex gap-3 pr-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Fingerprint className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-white">Add a passkey for next time?</p>
          <p role="status" className="mt-1 text-xs leading-5 text-slate-400">
            {message ?? "Sign in on this device with your fingerprint, face or PIN instead of a password."}
          </p>
        </div>
      </div>
      {!message && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
          <button type="button" onClick={add} disabled={busy} className="btn-primary btn-sm">
            {busy ? "Waiting for your device…" : "Add a passkey"}
          </button>
          <button type="button" onClick={() => setShow(false)} className="btn-secondary btn-sm">
            Not now
          </button>
          <button
            type="button"
            onClick={() => {
              stopAskingForPasskey();
              setShow(false);
            }}
            className="rounded px-1 text-xs text-slate-500 outline-none transition hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Don&apos;t ask again on this device
          </button>
        </div>
      )}
    </section>
  );
}
