"use client";

import { useActionState } from "react";
import { Building2, ShieldAlert } from "lucide-react";
import { platformLogin, type PlatformLoginState } from "./actions";

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
