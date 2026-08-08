"use client";

import { useActionState, useState } from "react";
import {
  saveSigningSecuritySettings,
  type SigningSecuritySettings,
} from "@/app/actions/signingSecuritySettings";

const OPTIONS = [
  {
    value: "money",
    label: "Documents with money attached",
    detail:
      "A quote asks the signer for a one-time code. Job cards, delivery notes and anything with no value attached do not.",
  },
  {
    value: "always",
    label: "Every document",
    detail: "Every signer proves who they are. Safest, and the most friction for routine paperwork.",
  },
  {
    value: "off",
    label: "Never, unless chosen per document",
    detail:
      "Possession of the emailed link is the whole check by default. Anyone preparing a document can still turn verification on for it.",
  },
] as const;

export function SigningSecurityForm({ initial }: { initial: SigningSecuritySettings }) {
  const [state, action, saving] = useActionState(saveSigningSecuritySettings, {});
  const [policy, setPolicy] = useState<string>(initial.policy);

  return (
    <form action={action} className="mt-5 space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">When to ask a signer for a one-time code</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3.5 hover:bg-muted/30"
          >
            <input
              type="radio"
              name="policy"
              value={option.value}
              checked={policy === option.value}
              onChange={(event) => setPolicy(event.target.value)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Shown only where it applies — a threshold means nothing under the other
          two policies, and an input that silently does nothing is worse than one
          that is absent. */}
      {policy === "money" && (
        <div className="rounded-xl border border-border p-3.5">
          <label htmlFor="minValue" className="block text-sm font-medium">
            Only above this amount
          </label>
          <p className="mb-2 text-xs text-muted-foreground">
            Leave as 0 to verify every document that carries a value.
          </p>
          <input
            id="minValue"
            name="minValue"
            inputMode="decimal"
            defaultValue={String(initial.minValue)}
            className="input w-40"
          />
        </div>
      )}

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
