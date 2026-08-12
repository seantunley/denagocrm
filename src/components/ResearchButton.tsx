"use client";

import { useActionState } from "react";
import { Search, LoaderCircle } from "lucide-react";
import { researchRecord, type ResearchState } from "@/app/actions/ai";
import { ResearchBriefingView } from "@/components/ResearchBriefing";

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
        <button className="btn-secondary btn-sm gap-1.5" disabled={pending} title="AI web research: company + person synopsis, including LinkedIn">
          {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          {pending ? "Researching…" : "Research"}
        </button>
      </form>
      {state?.error && <p className="text-xs text-red-400 mt-1.5">{state.error}</p>}
      {state?.summary && (
        <div className="mt-2 max-w-xl rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
          <p className="mb-2 text-xs font-semibold text-sky-300">🔎 Saved to Research tab</p>
          <ResearchBriefingView text={state.summary} compact />
        </div>
      )}
    </div>
  );
}
