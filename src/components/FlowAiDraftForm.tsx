"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { generateFlowDraftAction, type FlowAiDraftState } from "@/app/actions/flowAi";

const initial: FlowAiDraftState = {};

export default function FlowAiDraftForm({ flowId }: { flowId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(generateFlowDraftAction.bind(null, flowId), initial);

  useEffect(() => {
    if (state.ok) {
      toast.success(state.ok);
      router.refresh();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, router]);

  return (
    <details className="rounded-xl border border-orange-400/20 bg-orange-500/[0.04] p-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-orange-200 [&::-webkit-details-marker]:hidden">
        <Sparkles className="size-4" />
        Ask AI to revise this draft
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <p className="text-xs leading-5 text-slate-400">
          This replaces the <b>saved draft only</b>. Save any canvas changes first. The generated graph must pass the same channel compiler, and it still needs your review, simulator run and separate Publish action.
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
          <Sparkles className="size-3.5" />{pending ? "Generating draft…" : "Generate replacement draft"}
        </button>
      </form>
    </details>
  );
}
