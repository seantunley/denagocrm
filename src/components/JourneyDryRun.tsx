"use client";

import { useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { FlaskConical, Loader2, RefreshCw } from "lucide-react";
import { dryRunJourneyAction } from "@/app/actions/journeyDryRun";
import type { DryRunScenario, DryRunStep } from "@/lib/journeyDryRun";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { FeedbackBanner, StatusPill } from "@/components/visual-system";
import type { JourneyTestLead } from "@/components/JourneyTestRun";

type Result = Awaited<ReturnType<typeof dryRunJourneyAction>>;

const OUTCOME: Record<DryRunStep["outcome"], { label: string; tone: "info" | "success" | "warning" | "danger" }> = {
  would_do: { label: "Would do", tone: "info" },
  decided: { label: "Decided", tone: "success" },
  waited: { label: "Waited", tone: "warning" },
  skipped: { label: "Skipped", tone: "warning" },
  stopped: { label: "Stopped", tone: "warning" },
  failed: { label: "Problem", tone: "danger" },
};
const ENDED = { finished: "The journey finished.", stopped: "The journey stopped here.", step_limit: "Stopped after 300 steps — check for a loop that never ends." };
const when = (iso: string) => new Date(iso).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" });
const stepName = (type: string) => type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/**
 * DRY RUN (Sean, 2026-11-04): walk the journey step by step on a pretend clock — nothing is sent or changed
 * (lib/journeyDryRun). Every decision in the timeline can be flipped to see the other branch.
 */
export default function JourneyDryRun({ journeyId, journeyName, leads }: { journeyId: string; journeyName: string; leads: JourneyTestLead[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [leadId, setLeadId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [scenario, setScenario] = useState<DryRunScenario>({});
  const [result, setResult] = useState<Result | null>(null);

  const walk = (next: DryRunScenario = scenario) => {
    setScenario(next);
    start(async () => {
      try {
        setResult(await dryRunJourneyAction(journeyId, leadId || null, { ...next, ...(startAt ? { start: new Date(startAt).toISOString() } : {}) }));
      } catch (error) {
        unstable_rethrow(error);
        setResult({ ok: false, error: "The dry run could not be started. Please try again." });
      }
    });
  };

  /** Try the other answer at this step and walk again. */
  const flip = (step: DryRunStep) => {
    const other = !step.answer;
    walk(step.type === "wait_for_trigger"
      ? { ...scenario, triggers: { ...scenario.triggers, [step.stepId]: other ? "arrives" : "times_out" } }
      : { ...scenario, conditions: { ...scenario.conditions, [step.stepId]: other } });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (pending && !next) return; setOpen(next); if (!next) { setResult(null); setScenario({}); } }}>
      <DialogTrigger asChild>
        <button type="button" className="btn-secondary btn-sm">
          <FlaskConical className="size-4" />
          Dry run
        </button>
      </DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-2xl" aria-busy={pending}>
        <DialogHeader className="text-left">
          <DialogTitle>Dry run “{journeyName}”</DialogTitle>
          <DialogDescription>
            Walks the journey step by step on a pretend clock and shows what each step would do. Nothing is sent and
            nothing in the CRM changes. It uses the draft if there is one, otherwise the published version.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`dry-lead-${journeyId}`}>Lead to use for its details</label>
              <select id={`dry-lead-${journeyId}`} className="input" value={leadId} disabled={pending}
                onChange={(event) => { setLeadId(event.target.value); setResult(null); }}>
                <option value="">No lead — blank details</option>
                {leads.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground mt-1">Read only: the lead is not enrolled or contacted.</p>
            </div>
            <div>
              <label className="label" htmlFor={`dry-start-${journeyId}`}>Pretend it starts at</label>
              <input id={`dry-start-${journeyId}`} type="datetime-local" className="input" value={startAt} disabled={pending}
                onChange={(event) => setStartAt(event.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">Blank: now.</p>
            </div>
          </div>

          {result && !result.ok && <FeedbackBanner tone="danger" title="The dry run stopped">{result.error}</FeedbackBanner>}
          {result?.ok && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Version {result.version} ({result.state}). Nothing was sent.</p>
              <ol className="space-y-2">
                {result.result.steps.map((step, index) => (
                  <li key={`${step.path}-${index}`} className="rounded-lg border border-white/10 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <StatusPill tone={OUTCOME[step.outcome].tone}>{OUTCOME[step.outcome].label}</StatusPill>
                      <span className="font-medium">{stepName(step.type)}</span>
                      <span className="text-xs text-muted-foreground">{when(step.at)}</span>
                      {step.answer !== undefined && (
                        <button type="button" className="btn-secondary btn-sm ml-auto" disabled={pending} onClick={() => flip(step)}>
                          <RefreshCw className="size-3.5" />
                          {step.type === "wait_for_trigger" ? (step.answer ? "Try: it never happens" : "Try: it happens") : "Try the other answer"}
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-300">{step.note}</p>
                    {step.vars && <pre className="mt-1 overflow-x-auto text-xs text-muted-foreground">{JSON.stringify(step.vars, null, 2)}</pre>}
                  </li>
                ))}
              </ol>
              <FeedbackBanner tone={result.result.ended === "step_limit" ? "warning" : "info"} title={ENDED[result.result.ended]}>
                Ends {when(result.result.endedAt)}.
              </FeedbackBanner>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary" disabled={pending}>Close</button>
          </DialogClose>
          {result?.ok && Object.keys({ ...scenario.conditions, ...scenario.triggers }).length > 0 && (
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => walk({})}>Reset answers</button>
          )}
          <button type="button" className="btn-primary" disabled={pending} onClick={() => walk()}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {result ? "Walk it again" : "Walk through it"}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
