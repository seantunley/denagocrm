"use client";

import { useActionState, useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  setEmailOtp,
  type SecurityState,
} from "@/app/actions/security";

export default function SecurityPanel({
  totpEnabled,
  emailOtpEnabled,
}: {
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
}) {
  const [enrol, setEnrol] = useState<{ qr: string; secret: string } | null>(null);
  const [confirmState, confirmAction] = useActionState<SecurityState | undefined, FormData>(
    confirmTotpEnrolment,
    undefined
  );
  const [disableState, disableAction] = useActionState<SecurityState | undefined, FormData>(
    disableTotp,
    undefined
  );
  const [emailOn, setEmailOn] = useState(emailOtpEnabled);
  // Without this the checkbox stayed live while a save was in flight, so rapid
  // toggles could complete out of order and leave the box disagreeing with what
  // was stored.
  const [emailSaving, setEmailSaving] = useState(false);
  const codes = confirmState?.backupCodes;

  return (
    <div>
      <p className="text-xs text-slate-400 mb-4">
        Adds a second step at sign-in — protects your account even if your password leaks.
      </p>

      {codes && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 mb-4">
          <p className="text-sm font-semibold text-amber-200 mb-2">
            ✓ 2FA is on. Save these backup codes now — each works once if you lose your phone:
          </p>
          <div className="grid grid-cols-2 gap-2 font-mono text-sm text-amber-100">
            {codes.map((c) => (
              <span key={c} className="bg-slate-900/60 rounded px-2 py-1 text-center">
                {c}
              </span>
            ))}
          </div>
          <p className="text-xs text-amber-300/80 mt-2">
            They won&apos;t be shown again. Store them somewhere safe.
          </p>
        </div>
      )}

      {totpEnabled && !codes ? (
        <div>
          <p className="text-sm text-emerald-400 mb-3">✓ Authenticator app is enabled.</p>
          <form action={disableAction} className="flex items-end gap-2">
            <div>
              <label className="label">Turn off — enter a current code</label>
              <input name="code" inputMode="numeric" className="input w-40" placeholder="••••••" />
            </div>
            <button className="btn-secondary">Disable 2FA</button>
          </form>
          {disableState?.error && <p className="text-sm text-red-400 mt-2">{disableState.error}</p>}
          {disableState?.ok && <p className="text-sm text-emerald-400 mt-2">{disableState.ok}</p>}
        </div>
      ) : !enrol && !codes ? (
        <button
          className="btn-primary"
          onClick={async () => {
            // A throw here used to leave the button looking like it did nothing.
            try {
              const r = await beginTotpEnrolment();
              setEnrol({ qr: r.qr, secret: r.secret });
            } catch (error) {
              unstable_rethrow(error);
              toast.error("Could not start setup. Please try again.");
            }
          }}
        >
          Set up authenticator app
        </button>
      ) : enrol && !codes ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            1. Scan this with Google Authenticator, Authy or 1Password:
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrol.qr} alt="2FA QR code" className="rounded-lg bg-white p-2 w-48 h-48" />
          <p className="text-xs text-slate-400">
            Or enter this key manually:{" "}
            <span className="font-mono text-slate-200 break-all">{enrol.secret}</span>
          </p>
          <form action={confirmAction} className="flex items-end gap-2">
            <div>
              <label className="label">2. Enter the 6-digit code it shows</label>
              <input name="code" inputMode="numeric" className="input w-40" placeholder="••••••" required />
            </div>
            <button className="btn-primary">Verify &amp; enable</button>
          </form>
          {confirmState?.error && <p className="text-sm text-red-400">{confirmState.error}</p>}
        </div>
      ) : null}

      <div className="mt-5 pt-4 border-t border-slate-800">
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={emailOn}
            disabled={emailSaving}
            onChange={async (e) => {
              // The toggle flipped optimistically and the result was discarded,
              // so a failed save left the box showing a setting that was never
              // stored. It now reports, and reverts when the save is refused.
              if (emailSaving) return;
              const next = e.target.checked;
              const before = emailOn;
              setEmailOn(next);
              setEmailSaving(true);
              try {
                const result = await setEmailOtp(next);
                if (result?.error) {
                  toast.error(result.error);
                  setEmailOn(before);
                  return;
                }
                toast.success(next ? "Email sign-in codes are on." : "Email sign-in codes are off.");
              } catch (error) {
                unstable_rethrow(error);
                toast.error("Something went wrong. Please try again.");
                setEmailOn(before);
              } finally {
                setEmailSaving(false);
              }
            }}
            className="h-4 w-4 disabled:opacity-50"
          />
          Also allow email sign-in codes as a backup
        </label>
        <p className="text-xs text-slate-500 mt-1 ml-6">
          Sends a code to your email at sign-in. Useful as a fallback, but your email inbox becomes
          part of your account security.
        </p>
      </div>
    </div>
  );
}
