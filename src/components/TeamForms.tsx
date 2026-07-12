"use client";

import { useActionState } from "react";
import { createUser, changeOwnPassword, type FormState } from "@/app/actions/settings";

function Feedback({ state }: { state: FormState | undefined }) {
  if (!state) return null;
  if (state.error) return <p className="text-sm text-red-400">{state.error}</p>;
  if (state.ok) return <p className="text-sm text-emerald-400">{state.ok}</p>;
  return null;
}

export function AddUserForm() {
  const [state, formAction, pending] = useActionState<FormState | undefined, FormData>(
    createUser,
    undefined
  );
  return (
    <form action={formAction} className="space-y-2">
      <input name="name" className="input" placeholder="Full name" required />
      <input name="email" type="email" className="input" placeholder="Email" required />
      <input
        name="password"
        type="password"
        className="input"
        placeholder="Password (12+ characters, letters and numbers)"
        minLength={12}
        required
      />
      <Feedback state={state} />
      <button className="btn-primary w-full" disabled={pending}>
        {pending ? "Adding…" : "Add team member"}
      </button>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<FormState | undefined, FormData>(
    changeOwnPassword,
    undefined
  );
  return (
    <form action={formAction} className="space-y-2">
      <input
        name="current"
        type="password"
        className="input"
        placeholder="Current password"
        autoComplete="current-password"
        required
      />
      <input
        name="next"
        type="password"
        className="input"
        placeholder="New password (12+ characters, letters and numbers)"
        autoComplete="new-password"
        minLength={12}
        required
      />
      <Feedback state={state} />
      <button className="btn-secondary w-full" disabled={pending}>
        {pending ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
