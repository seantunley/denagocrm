"use client";

import { useActionState } from "react";
import { Building2, KeyRound, ShieldAlert } from "lucide-react";
import { platformLogin, platformVerifyTotp, type PlatformLoginState } from "./actions";

/**
 * Platform-console login. A separate surface from the CRM's /login: it
 * authenticates a PlatformAdmin, sets a cookie scoped to /platform, and never
 * touches the CRM session. Kept visually distinct so it is obvious which
 * credential is being used.
 */
export default function PlatformLoginPage() {
  const [state, formAction, pending] = useActionState<PlatformLoginState, FormData>(
    platformLogin,
    {},
  );

  // The password step is REPLACED rather than added to once a second factor is
  // required, so the email and password inputs leave the DOM entirely. A hidden
  // first step would keep the typed password in the page for the life of the
  // second, which is the part of a two-step login most worth not doing.
  if (state?.need2fa) return <SecondFactor />;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <div className="card p-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Building2 className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Platform Console</h1>
            <p className="text-xs text-muted-foreground">
              Cross-tenant administration
            </p>
          </div>
        </div>

        <p className="mb-6 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          This is a separate login from the CRM. Your CRM account will not work
          here.
        </p>

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="platform-email" className="mb-1.5 block text-xs font-medium">
              Email
            </label>
            <input
              id="platform-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className="input w-full"
            />
          </div>

          <div>
            <label htmlFor="platform-password" className="mb-1.5 block text-xs font-medium">
              Password
            </label>
            <input
              id="platform-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="input w-full"
            />
          </div>

          {state?.error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              <ShieldAlert className="mt-px size-3.5 shrink-0" />
              {state.error}
            </p>
          )}

          <button type="submit" disabled={pending} className="btn-primary w-full">
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The second step. Its own component with its own action state, so a failed code
 * cannot be rendered by the password form and vice versa.
 *
 * One field, accepting either an authenticator code or a backup code — the
 * server tries both. Asking the user to declare WHICH they are typing is a
 * choice they should not have to make while locked out of an admin console.
 */
function SecondFactor() {
  const [state, formAction, pending] = useActionState<PlatformLoginState, FormData>(
    platformVerifyTotp,
    {},
  );

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <div className="card p-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Two-factor authentication</h1>
            <p className="text-xs text-muted-foreground">Enter the code from your authenticator</p>
          </div>
        </div>

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="platform-code" className="mb-1.5 block text-xs font-medium">
              Authentication code
            </label>
            <input
              id="platform-code"
              name="code"
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              required
              className="input w-full text-center tracking-[0.3em]"
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Lost your authenticator? Enter one of your backup codes instead.
            </p>
          </div>

          {state?.error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              <ShieldAlert className="mt-px size-3.5 shrink-0" />
              {state.error}
            </p>
          )}

          <button type="submit" disabled={pending} className="btn-primary w-full">
            {pending ? "Verifying…" : "Verify"}
          </button>
        </form>
      </div>
    </div>
  );
}
