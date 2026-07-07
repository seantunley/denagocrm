"use client";

import { Suspense, useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import { login, verifySecondFactor, requestEmailCode, type LoginState } from "./actions";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const [state, formAction, pending] = useActionState<LoginState | undefined, FormData>(
    login,
    undefined
  );
  const timedOut = useSearchParams().get("timeout") === "1";

  if (state?.need2fa) {
    return <TwoFactorStep methods={state.methods ?? []} />;
  }

  return (
    <Shell>
      {timedOut && (
        <p className="text-sm text-amber-300 mb-4 text-center">
          You were signed out for security. Please sign in again.
        </p>
      )}
      <form action={formAction} className="card space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" className="input" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            autoComplete="current-password"
            required
          />
        </div>
        {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Shell>
  );
}

function TwoFactorStep({ methods }: { methods: string[] }) {
  const [state, formAction, pending] = useActionState<{ error?: string } | undefined, FormData>(
    verifySecondFactor,
    undefined
  );
  const [sent, setSent] = useState(false);
  const hasTotp = methods.includes("totp");
  const hasEmail = methods.includes("email");

  return (
    <Shell>
      <form action={formAction} className="card space-y-4">
        <div>
          <h2 className="font-semibold text-white">Two-factor verification</h2>
          <p className="text-sm text-slate-400 mt-1">
            {hasTotp
              ? "Enter the 6-digit code from your authenticator app."
              : "Enter the code we emailed you."}
          </p>
        </div>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          className="input text-center tracking-[0.3em] text-lg"
          placeholder="••••••"
          required
        />
        {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? "Verifying…" : "Verify"}
        </button>
        {hasEmail && (
          <button
            type="button"
            onClick={async () => {
              await requestEmailCode();
              setSent(true);
            }}
            className="text-xs text-slate-400 hover:text-slate-200 underline w-full text-center cursor-pointer"
          >
            {sent
              ? "Code sent — check your email"
              : hasTotp
              ? "Lost your phone? Email me a code instead"
              : "Resend the email code"}
          </button>
        )}
        {hasTotp && (
          <p className="text-[11px] text-slate-500 text-center">
            You can also enter one of your backup codes.
          </p>
        )}
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/branding/denago-cape-town-logo.png"
            alt="Denago Cape Town"
            className="mx-auto h-16 w-auto object-contain"
          />
          <p className="text-slate-400 text-sm mt-3">Sales &amp; EV Service Management</p>
        </div>
        {children}
      </div>
    </div>
  );
}
