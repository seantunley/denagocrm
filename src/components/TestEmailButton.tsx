"use client";

import { useActionState } from "react";
import { sendTestEmail, type SendEmailState } from "@/app/actions/emails";

export default function TestEmailButton() {
  const [state, formAction, pending] = useActionState<SendEmailState | undefined>(
    sendTestEmail,
    undefined
  );
  return (
    <form action={formAction} className="flex items-center gap-3">
      <button className="btn-secondary" disabled={pending}>
        {pending ? "Sending…" : "Send test email to me"}
      </button>
      {state?.ok && <span className="text-sm text-emerald-400">{state.ok}</span>}
      {state?.error && <span className="text-sm text-red-400">{state.error}</span>}
    </form>
  );
}
