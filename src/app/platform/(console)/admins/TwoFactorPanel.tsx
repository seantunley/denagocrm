"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  beginPlatformTotpEnrolment,
  confirmPlatformTotpEnrolment,
  disablePlatformTotp,
  type PlatformSecurityState,
} from "@/app/actions/platformSecurity";

/**
 * Enrolling the console's own second factor.
 *
 * The account this protects can create, brand and suspend every tenant on the
 * platform, and until now a password was the only thing in front of it — while
 * an ordinary sales rep inside a tenant could enrol an authenticator and a
 * passkey. The columns existed; nothing ever wrote them.
 *
 * The QR is fetched on demand rather than rendered with the page. Putting a
 * secret in the markup of a page that is loaded on every visit means it sits in
 * the browser cache and in any screenshot of this screen, for an admin who was
 * not enrolling.
 */
export default function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirmState, confirmAction, confirming] = useActionState<PlatformSecurityState, FormData>(
    confirmPlatformTotpEnrolment,
    {},
  );
  const [disableState, disableAction, disabling] = useActionState<PlatformSecurityState, FormData>(
    disablePlatformTotp,
    {},
  );

  // Shown ONCE, on the response that created them. They are stored hashed, so
  // there is no second chance to display them and no screen that can list them
  // later — which is worth saying on the screen itself rather than only here.
  const backupCodes = confirmState?.backupCodes;

  if (backupCodes?.length) {
    return (
      <section className="card border-l-4 border-l-emerald-500 p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-emerald-500" />
          Two-factor authentication is on
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Save these backup codes somewhere safe. Each one signs you in once if you lose your
          authenticator. <strong>They are not shown again</strong> — only their hashes are stored,
          and a platform admin has nobody who can reset them.
        </p>
        <ul className="mt-4 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-4">
          {backupCodes.map((code) => (
            <li key={code} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-center">
              {code}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (enabled) {
    return (
      <section className="card p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-emerald-500" />
          Two-factor authentication
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          On. You are asked for a code from your authenticator after your password.
        </p>
        {/* A current code is required to turn it OFF — otherwise 2FA is
            removable by exactly the attacker it exists to stop: someone holding
            a stolen password and a live session. */}
        <form action={disableAction} className="mt-4 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="disable-code" className="mb-1.5 block text-xs font-medium">
              Current code
            </label>
            <input id="disable-code" name="code" required className="input w-40 tracking-[0.2em]" />
          </div>
          <button type="submit" disabled={disabling} className="btn-secondary">
            {disabling ? "Turning off…" : "Turn off"}
          </button>
        </form>
        {disableState?.error && <Alert>{disableState.error}</Alert>}
        {disableState?.ok && <p className="mt-2 text-xs text-emerald-500">{disableState.ok}</p>}
      </section>
    );
  }

  return (
    <section className="card border-l-4 border-l-amber-500 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <KeyRound className="size-4 text-amber-500" />
        Two-factor authentication
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Off. This account can create, brand and suspend every tenant on the platform, and a
        password is currently the only thing protecting it.
      </p>

      {!setup ? (
        <button
          type="button"
          disabled={starting}
          className="btn-primary mt-4"
          onClick={async () => {
            setStarting(true);
            try {
              const started = await beginPlatformTotpEnrolment();
              setSetup({ qr: started.qr, secret: started.secret });
            } finally {
              setStarting(false);
            }
          }}
        >
          {starting ? "Preparing…" : "Set up"}
        </button>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-start gap-5">
            <Image src={setup.qr} alt="" width={160} height={160} className="rounded-lg bg-white p-2" unoptimized />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm">Scan this with your authenticator app, then enter the code it shows.</p>
              <p className="text-xs text-muted-foreground">
                Cannot scan? Enter this key by hand:
              </p>
              <code className="block break-all rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
                {setup.secret}
              </code>
            </div>
          </div>

          {/* Not enabled until a code proves the secret actually arrived. A scan
              that silently failed would otherwise lock this account out of the
              console with no way back. */}
          <form action={confirmAction} className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="confirm-code" className="mb-1.5 block text-xs font-medium">
                Code from your app
              </label>
              <input id="confirm-code" name="code" required autoFocus className="input w-40 tracking-[0.2em]" />
            </div>
            <button type="submit" disabled={confirming} className="btn-primary">
              {confirming ? "Verifying…" : "Turn on"}
            </button>
          </form>
          {confirmState?.error && <Alert>{confirmState.error}</Alert>}
        </div>
      )}
    </section>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
    >
      <ShieldAlert className="mt-px size-3.5 shrink-0" />
      {children}
    </p>
  );
}
