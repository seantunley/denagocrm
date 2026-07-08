"use client";

import { useActionState, useState } from "react";
import { requestPortalOtp, verifyPortalOtp } from "@/app/actions/portal";

export default function PortalLoginPage() {
  const [email, setEmail] = useState("");
  const [reqState, requestAction, reqPending] = useActionState(requestPortalOtp, undefined);
  const [verState, verifyAction, verPending] = useActionState(verifyPortalOtp, undefined);
  const sent = reqState?.sent;

  return (
    <div className="max-w-sm mx-auto mt-6">
      <h1 className="text-xl font-bold mb-1">Sign in</h1>
      <p className="text-sm text-slate-400 mb-5">
        View your carts, service history and quotes. We&apos;ll email you a one-time code.
      </p>

      {!sent ? (
        <form action={requestAction} className="card space-y-3">
          <div>
            <label className="label">Email address</label>
            <input
              name="email"
              type="email"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
            />
          </div>
          {reqState?.error && <p className="text-sm text-red-400">{reqState.error}</p>}
          <button className="btn-primary w-full" disabled={reqPending}>
            {reqPending ? "Sending…" : "Email me a code"}
          </button>
        </form>
      ) : (
        <form action={verifyAction} className="card space-y-3">
          <p className="text-sm text-slate-400">
            If <b>{email}</b> is on file, a 6-digit code is on its way. Enter it below.
          </p>
          <input type="hidden" name="email" value={email} />
          <div>
            <label className="label">Code</label>
            <input
              name="code"
              inputMode="numeric"
              maxLength={6}
              required
              className="input text-center text-lg tracking-[0.4em]"
              placeholder="000000"
            />
          </div>
          {verState?.error && <p className="text-sm text-red-400">{verState.error}</p>}
          <button className="btn-primary w-full" disabled={verPending}>
            {verPending ? "Checking…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}
