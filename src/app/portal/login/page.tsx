"use client";

import { useActionState, useState } from "react";
import { ArrowRight, KeyRound, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { requestPortalOtp, verifyPortalOtp } from "@/app/actions/portal";

export default function PortalLoginPage() {
  const [email, setEmail] = useState("");
  const [reqState, requestAction, reqPending] = useActionState(requestPortalOtp, undefined);
  const [verState, verifyAction, verPending] = useActionState(verifyPortalOtp, undefined);
  const sent = reqState?.sent;

  return (
    <div className="mx-auto max-w-md py-6 sm:py-12">
      <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-orange-400/20 bg-orange-400/10 text-orange-400 shadow-[0_0_35px_rgba(249,115,22,.1)]">
        <ShieldCheck className="size-6" />
      </div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-400">Your Denago</p>
      <h1 className="text-3xl font-semibold tracking-[-0.04em]">Welcome back.</h1>
      <p className="mb-7 mt-2 text-sm leading-6 text-slate-400">
        View your carts, service history and quotes using a secure email code.
      </p>

      {!sent ? (
        <form action={requestAction} className="space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-6">
          <div>
            <label className="label" htmlFor="portal-email">Email address</label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
              <input id="portal-email" name="email" type="email" required autoComplete="email" className="input pl-10" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@email.com" />
            </div>
          </div>
          {reqState?.error && <p role="alert" className="rounded-xl border border-red-400/15 bg-red-400/8 px-3 py-2 text-sm text-red-300">{reqState.error}</p>}
          <button className="btn-primary h-11 w-full" disabled={reqPending}>
            {reqPending ? "Sending…" : "Email me a code"}<ArrowRight className="size-4" />
          </button>
        </form>
      ) : (
        <form action={verifyAction} className="space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-6">
          <p className="text-sm leading-6 text-slate-400">If <strong className="font-medium text-slate-200">{email}</strong> is on file, your six-digit code is on its way.</p>
          <input type="hidden" name="email" value={email} />
          <div>
            <label className="label" htmlFor="portal-code">Verification code</label>
            <input id="portal-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus className="input h-12 text-center font-mono text-lg tracking-[0.4em]" placeholder="000000" />
          </div>
          {verState?.error && <p role="alert" className="rounded-xl border border-red-400/15 bg-red-400/8 px-3 py-2 text-sm text-red-300">{verState.error}</p>}
          <button className="btn-primary h-11 w-full" disabled={verPending}>
            {verPending ? "Checking…" : "Open my portal"}<KeyRound className="size-4" />
          </button>
        </form>
      )}

      <p className="mt-5 flex items-center justify-center gap-2 text-[11px] text-slate-600"><LockKeyhole className="size-3.5" />No password needed. Codes expire after ten minutes.</p>
    </div>
  );
}
