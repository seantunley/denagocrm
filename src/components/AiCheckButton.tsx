"use client";

import { startTransition, useActionState } from "react";
import { checkDraft, type AiCheckState } from "@/app/actions/ai";

/**
 * ✨ proofread-my-draft button — suggestions only, never auto-corrects.
 *
 * A plain type="button", NOT a form: it sits inside the email composer's and the
 * inbox reply's own forms, and a <form> inside a <form> is invalid HTML — the
 * browser may drop the inner one, and then this button submits the OUTER form,
 * which sends the message (seen 2026-10-07 as a hydration error on the lead page).
 */
export default function AiCheckButton({
  getDraft,
  getAttachments,
  contactId,
  leadId,
  configured,
  label = "Check my message",
}: {
  getDraft: () => string;
  /**
   * The files going with the message, by name. Without them the proofreader only
   * sees the text, so "please see attached" read as a missing attachment even
   * with the PDF right there (Sean, 2026-11-10). Omitted where a surface has none.
   */
  getAttachments?: () => string[];
  contactId?: string | null;
  leadId?: string | null;
  configured: boolean;
  label?: string;
}) {
  const [state, check, pending] = useActionState<AiCheckState | undefined, FormData>(
    checkDraft,
    undefined
  );
  if (!configured) return null;

  const run = () => {
    const fd = new FormData();
    fd.set("draft", getDraft());
    for (const name of getAttachments?.() ?? []) fd.append("attachment", name);
    if (getAttachments) fd.set("attachmentsKnown", "1");
    if (contactId) fd.set("contactId", contactId);
    if (leadId) fd.set("leadId", leadId);
    startTransition(() => check(fd));
  };

  return (
    <div>
      <button
        type="button"
        onClick={run}
        className="text-xs text-slate-400 hover:text-orange-300 underline cursor-pointer"
        disabled={pending}
        title="AI proofread: spelling, wrong names, odd numbers"
      >
        {pending ? "✨ Checking…" : label}
      </button>
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
