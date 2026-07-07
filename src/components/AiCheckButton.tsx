"use client";

import { useActionState } from "react";
import { checkDraft, type AiCheckState } from "@/app/actions/ai";

/** ✨ proofread-my-draft button — suggestions only, never auto-corrects. */
export default function AiCheckButton({
  getDraft,
  contactId,
  leadId,
  configured,
}: {
  getDraft: () => string;
  contactId?: string | null;
  leadId?: string | null;
  configured: boolean;
}) {
  const [state, formAction, pending] = useActionState<AiCheckState | undefined, FormData>(
    checkDraft,
    undefined
  );
  if (!configured) return null;

  return (
    <div>
      <form
        action={(fd) => {
          fd.set("draft", getDraft());
          if (contactId) fd.set("contactId", contactId);
          if (leadId) fd.set("leadId", leadId);
          return formAction(fd);
        }}
        className="inline"
      >
        <button
          className="text-xs text-slate-400 hover:text-orange-300 underline cursor-pointer"
          disabled={pending}
          title="AI proofread: spelling, wrong names, odd numbers"
        >
          {pending ? "✨ Checking…" : "✨ Check my message"}
        </button>
      </form>
      {state?.ok && <span className="text-xs text-emerald-400 ml-2">Looks good ✓</span>}
      {state?.error && <span className="text-xs text-red-400 ml-2">{state.error}</span>}
      {state?.issues && (
        <ul className="mt-1.5 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
          {state.issues.map((issue, i) => (
            <li key={i} className="text-xs text-amber-200">
              ⚠ {issue}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
