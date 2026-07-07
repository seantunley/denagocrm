"use client";

import { useActionState } from "react";
import { researchRecord, type ResearchState } from "@/app/actions/ai";

/** 🔎 on-demand company/person research; result files onto the timeline. */
export default function ResearchButton({
  leadId,
  contactId,
  configured,
}: {
  leadId?: string;
  contactId?: string;
  configured: boolean;
}) {
  const [state, formAction, pending] = useActionState<ResearchState | undefined, FormData>(
    researchRecord,
    undefined
  );
  if (!configured) return null;

  return (
    <div className="inline-block">
      <form action={formAction} className="inline">
        {leadId && <input type="hidden" name="leadId" value={leadId} />}
        {contactId && <input type="hidden" name="contactId" value={contactId} />}
        <button className="btn-secondary btn-sm" disabled={pending} title="AI web research: company + person synopsis">
          {pending ? "🔎 Researching…" : "🔎 Research"}
        </button>
      </form>
      {state?.error && <p className="text-xs text-red-400 mt-1">{state.error}</p>}
      {state?.summary && (
        <div className="mt-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 max-w-xl">
          <p className="text-xs font-semibold text-sky-300 mb-1">🔎 AI research (saved to timeline)</p>
          <p className="text-xs text-sky-100/90 whitespace-pre-wrap">{state.summary}</p>
        </div>
      )}
    </div>
  );
}
