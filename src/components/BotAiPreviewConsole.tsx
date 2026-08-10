"use client";

import { useActionState } from "react";
import { Bot, BrainCircuit, BookOpenCheck, Hand, ShieldCheck } from "lucide-react";
import { previewBotAnswer, type BotPreviewState } from "@/app/actions/botPreview";

const initial: BotPreviewState = {};

const confidenceTone = (confidence?: string) =>
  confidence === "high"
    ? "bg-emerald-500/15 text-emerald-300"
    : confidence === "medium"
    ? "bg-amber-500/15 text-amber-300"
    : "bg-red-500/15 text-red-300";

export default function BotAiPreviewConsole() {
  const [state, action, pending] = useActionState(previewBotAnswer, initial);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <form action={action} className="card space-y-4 p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Test input</p>
          <h2 className="mt-1 text-lg font-semibold">Ask exactly what a customer would ask</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">This calls the same production answer decision, but it does not send a message, advance a flow, create a lead or change a booking.</p>
        </div>
        <div>
          <label className="label">Customer question</label>
          <textarea
            name="question"
            className="input"
            rows={6}
            required
            maxLength={3000}
            defaultValue={state.question ?? ""}
            placeholder="Example: Is the Rover XL road legal, and what warranty does the battery have?"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Customer name (optional)</label><input name="customerName" className="input" maxLength={120} placeholder="Sean" /></div>
          <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground"><input type="checkbox" name="isCustomer" className="h-4 w-4" /> Existing customer</label>
        </div>
        <button className="btn-primary" disabled={pending}><BrainCircuit className="size-4" />{pending ? "Testing…" : "Test assistant"}</button>
        {state.error && <p className="rounded-xl border border-red-400/20 bg-red-500/5 p-3 text-sm text-red-300">{state.error}</p>}
      </form>

      <div className="space-y-4">
        {!state.reply ? (
          <div className="card grid min-h-72 place-items-center p-8 text-center">
            <div><Bot className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 text-sm font-medium">No preview yet</p><p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">Run a real question to inspect what the customer would receive and why the assistant would keep or hand over the conversation.</p></div>
          </div>
        ) : (
          <>
            <div className="card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-1 text-xs font-medium ${confidenceTone(state.confidence)}`}>{state.confidence ?? "unknown"} confidence</span>
                <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">intent: {state.intent ?? "unknown"}</span>
                <span className={`rounded-full px-2 py-1 text-xs ${state.handoff ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}`}>{state.handoff ? "hands off" : "stays automated"}</span>
              </div>
              <div className="mt-4 rounded-2xl border border-border bg-muted/25 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Customer would receive</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{state.reply}</p>
              </div>
              {state.handoff && (
                <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-200"><Hand className="size-4" />Human handoff context</div>
                  <p className="mt-2 text-xs text-amber-100/90"><b>Reason:</b> {state.handoffReason || "No specific reason returned"}</p>
                  <p className="mt-1 text-xs leading-5 text-amber-100/80"><b>Staff summary:</b> {state.handoffSummary || "No summary returned"}</p>
                </div>
              )}
            </div>

            <div className="card p-5">
              <div className="flex items-center gap-2"><BookOpenCheck className="size-4 text-primary" /><p className="text-sm font-semibold">Approved Knowledge matched</p></div>
              {state.knowledge?.length ? (
                <ul className="mt-3 space-y-2">{state.knowledge.map((entry) => <li key={entry.id} className="rounded-xl border border-border bg-muted/25 px-3 py-2"><p className="text-xs font-medium">{entry.title}</p>{entry.sourceLabel && <p className="mt-0.5 text-[10px] text-muted-foreground">Source: {entry.sourceLabel}</p>}</li>)}</ul>
              ) : <p className="mt-2 text-xs text-muted-foreground">No approved/current knowledge entry matched this question. The reply therefore had to rely on live CRM product facts, the global brief or a canonical FAQ pathway.</p>}
            </div>
          </>
        )}

        <div className="flex items-start gap-2 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.04] p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" /><p>Preview is read-only with respect to customer and CRM state. It does consume one normal AI inference because it intentionally tests the production decision path.</p></div>
      </div>
    </div>
  );
}
