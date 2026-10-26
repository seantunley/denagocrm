"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, RotateCw } from "lucide-react";
import { runAssistantPlan } from "@/app/actions/assistantPlans";
import { setAssistantTaskOpen } from "@/app/actions/assistantTasks";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import type { PlanView } from "@/lib/assistantPlanRules";

const MARK = { done: "✓", failed: "✗", refused: "✗", running: "…", waiting: "•" } as const;

/**
 * A multi-step plan: every step listed, what ran and what didn't. One Confirm
 * runs the internal steps in order; Retry carries on from where it stopped.
 * The plan is named by its id only — the steps run are the ones the server kept.
 * A message to a customer is never in it: it has its own card, with Send.
 */
export default function AssistantPlanCard({ plan }: { plan: PlanView }) {
  const [view, setView] = useState(plan);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const started = view.steps.some((s) => s.status !== "waiting");
  const open = view.status === "waiting" || view.status === "paused" || view.status === "running";

  const run = () =>
    startTransition(async () => {
      const result = await runAssistantPlan(view.taskId).catch(() => ({ ok: false, message: "Couldn't reach the server — press it again: a step already done is never run twice.", plan: null }));
      if (result.plan) setView(result.plan);
      setMessage(result.message);
    });

  return (
    <div className={`rounded-lg border p-3 text-sm ${view.status === "done" ? "border-emerald-500/40" : "border-border"}`}>
      <p className="font-medium">📋 {view.title}</p>
      <p className="text-xs text-muted-foreground">{view.summary}</p>
      <ol className="mt-2 space-y-1">
        {view.steps.map((s) => (
          <li key={s.n} className="text-xs">
            <span className={s.status === "failed" || s.status === "refused" ? "text-destructive" : s.status === "done" ? "text-emerald-600" : "text-muted-foreground"}>
              {MARK[s.status]} {s.n}. {s.title}
            </span>
            {s.message && s.status !== "waiting" && <span className="block pl-4 text-muted-foreground">{s.message}</span>}
            {s.href && <Link href={s.href} className="pl-4 text-primary underline">Open it</Link>}
          </li>
        ))}
      </ol>
      {view.sends.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Not part of the plan — each is its own card with a Send button you press yourself: {view.sends.join("; ")}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {view.canRun && (
          <button type="button" onClick={run} disabled={pending} className="btn-primary btn-sm inline-flex items-center gap-1">
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : started ? <RotateCw className="size-3.5" /> : <Check className="size-3.5" />}
            {started ? "Retry" : "Confirm"}
          </button>
        )}
        {open && !pending && (
          <ConfirmActionDialog
            trigger={<button type="button" className="btn-secondary btn-sm">Close</button>}
            title="Close this plan?"
            description="Steps that haven't run won't run. Nothing that already ran is undone."
            confirmLabel="Close"
            onConfirm={async () => {
              const result = await setAssistantTaskOpen(view.taskId, false);
              if (!result?.error) setView({ ...view, status: "closed", canRun: false, summary: "Closed — the steps that hadn't run won't." });
              return result;
            }}
          />
        )}
        {view.quoteId && <Link href={`/quotes?edit=${view.quoteId}`} className="btn-secondary btn-sm">Open the quote</Link>}
        {message && <span className={`text-xs ${view.status === "done" ? "text-muted-foreground" : "text-destructive"}`}>{message}</span>}
      </div>
    </div>
  );
}
