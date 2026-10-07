"use client";

import { useActionState } from "react";
import { saveSigningAutoReminders } from "@/app/actions/signingSecuritySettings";

export function SigningRemindersForm({ initial }: { initial: boolean }) {
  const [state, action, saving] = useActionState(saveSigningAutoReminders, {});
  return (
    <form action={action} className="mt-5 space-y-4">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3.5 hover:bg-muted/30">
        <input type="checkbox" name="autoReminders" defaultChecked={initial} className="mt-1" />
        <span>
          <span className="block text-sm font-medium">Send signers an automatic reminder</span>
          <span className="block text-xs text-muted-foreground">
            One reminder, by email and WhatsApp, three days after a signer receives a document they
            haven&apos;t signed. Off: nothing goes out unless someone presses Resend.
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
        {state?.error && <p role="alert" className="text-sm text-red-400">{state.error}</p>}
        {state?.ok && <p className="text-sm text-emerald-500">{state.ok}</p>}
      </div>
    </form>
  );
}
