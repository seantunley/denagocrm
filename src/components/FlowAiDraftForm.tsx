"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, GitCompareArrows, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { applyFlowDraftProposalAction, generateFlowDraftAction, type FlowAiDraftState, type FlowAiProposalView } from "@/app/actions/flowAi";

const initial: FlowAiDraftState = {};

export default function FlowAiDraftForm({ flowId }: { flowId: string }) {
  const [state, action, pending] = useActionState(generateFlowDraftAction.bind(null, flowId), initial);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success(state.ok);
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state.error, state.ok]);

  const proposal = state.proposal?.token === dismissed ? undefined : state.proposal;

  return (
    <details className="rounded-xl border border-orange-400/20 bg-orange-500/[0.04] p-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-orange-200 [&::-webkit-details-marker]:hidden">
        <Sparkles className="size-4" />
        Ask AI to revise this draft
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <p className="text-xs leading-5 text-slate-400">
          This creates a reviewable proposal and does <b>not</b> change the draft. Save any canvas changes first. Apply is a separate action after you inspect the node diff.
        </p>
        <textarea
          name="instruction"
          className="input"
          rows={4}
          minLength={8}
          maxLength={3000}
          required
          placeholder="Example: Add a menu option for warranty questions. Ask which model they own, then use the AI answer node. If the AI hands off, collect their phone number before the human handoff. Keep the current price and service paths."
        />
        {state.warnings?.length ? (
          <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 p-2 text-xs text-amber-200">
            <p className="font-medium">Compiler warnings in the generated draft</p>
            <ul className="mt-1 list-disc pl-4">{state.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </div>
        ) : null}
        <button type="submit" className="btn-secondary btn-sm" disabled={pending}>
          <Sparkles className="size-3.5" />{pending ? "Generating proposal…" : "Generate proposal"}
        </button>
      </form>
      {proposal ? <ProposalReview flowId={flowId} proposal={proposal} onReject={() => setDismissed(proposal.token)} /> : null}
    </details>
  );
}

function ProposalReview({ flowId, proposal, onReject }: { flowId: string; proposal: FlowAiProposalView; onReject: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(applyFlowDraftProposalAction.bind(null, flowId), initial);

  useEffect(() => {
    if (state.ok) {
      toast.success(state.ok);
      router.refresh();
    } else if (state.error) toast.error(state.error);
  }, [router, state.error, state.ok]);

  if (state.ok) return null;
  const total = proposal.added.length + proposal.removed.length + proposal.changed.length + Number(proposal.startChanged);
  return (
    <div className="mt-4 rounded-xl border border-orange-400/25 bg-[#111614] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="flex items-center gap-2 text-sm font-semibold text-orange-100"><GitCompareArrows className="size-4" />Review AI proposal</p><p className="mt-1 text-xs text-slate-400">{total ? `${total} structural change${total === 1 ? "" : "s"}` : "No structural changes"} · expires {new Date(proposal.expiresAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}</p></div>
        <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300">Compiler clean</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <DiffList label="Added" tone="text-emerald-300" values={proposal.added} empty="No nodes added" />
        <DiffList label="Changed" tone="text-amber-300" values={proposal.changed} empty="No nodes changed" />
        <DiffList label="Removed" tone="text-red-300" values={proposal.removed} empty="No nodes removed" />
      </div>
      {proposal.startChanged ? <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">The flow start node will change.</p> : null}
      {state.error ? <p className="mt-3 text-xs text-red-300">{state.error}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <form action={action}><input type="hidden" name="proposalToken" value={proposal.token} /><button className="btn-primary btn-sm" disabled={pending}><Check className="size-3.5" />{pending ? "Applying…" : "Apply proposal"}</button></form>
        <button type="button" onClick={onReject} className="btn-secondary btn-sm"><X className="size-3.5" />Reject</button>
      </div>
      <p className="mt-3 text-[10px] leading-4 text-slate-500">Apply is refused if the saved draft, enabled channels, referenced Journeys or signed proposal changed since generation. Publishing remains separate.</p>
    </div>
  );
}

function DiffList({ label, values, tone, empty }: { label: string; values: string[]; tone: string; empty: string }) {
  return <div className="rounded-lg border border-white/8 bg-white/[0.025] p-3"><p className={`text-xs font-semibold ${tone}`}>{label} · {values.length}</p>{values.length ? <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto font-mono text-[10px] text-slate-300">{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p className="mt-2 text-[10px] text-slate-500">{empty}</p>}</div>;
}
