"use client";

import { useActionState } from "react";
import { changeOwnPasswordAction } from "@/app/actions/platformAdmins";

type State = { error?: string; ok?: string };

/**
 * Own-password change. A client component so the result can be shown inline —
 * the action returns a message rather than throwing, because "current password is
 * incorrect" is an ordinary outcome, not an error page.
 */
export default function ChangeOwnPasswordForm() {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_prev, formData) => changeOwnPasswordAction(formData),
    {},
  );

  return (
    <form action={formAction} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="currentPassword">Current password</label>
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            className="input"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="newPassword">New password</label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            className="input"
            required
            minLength={12}
          />
        </div>
      </div>

      {state.error && (
        <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {state.ok}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-secondary btn-sm">
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
