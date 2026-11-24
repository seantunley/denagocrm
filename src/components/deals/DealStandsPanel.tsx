import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import type { BlockerKey } from "@/lib/dealMilestones";
import type { StandStep, StepState } from "@/lib/dealStand";
import { Surface } from "@/components/visual-system";
import { cn } from "@/lib/utils";

const BADGE: Record<StepState, { text: string; className: string }> = {
  done: { text: "Done", className: "bg-emerald-400/15 text-emerald-300" },
  now: { text: "Now", className: "bg-primary text-primary-foreground" },
  skipped: { text: "Not needed", className: "bg-muted text-muted-foreground" },
  next: { text: "Next", className: "bg-muted text-foreground" },
  later: { text: "Later", className: "bg-muted text-muted-foreground" },
};

const CARD: Record<StepState, string> = {
  done: "border-emerald-400/25 bg-emerald-400/5",
  now: "border-primary/70 bg-primary/10",
  skipped: "border-dashed border-border",
  next: "border-border",
  later: "border-border",
};

/**
 * ONE place for where the deal stands (deal page redesign, W2-05): every step of
 * the workspace's lifecycle with its state, one line of why, whose move it is, and
 * the button that does it — for the step that is NOW and the one NEXT. It replaces
 * the journey strip, "What is in the way" and "Ready to deliver?", which said the
 * same thing three times. A step that does not apply says "Not needed" and counts
 * in neither side of "N of M".
 */
export default function DealStandsPanel({ steps, progress, buttons }: {
  steps: StandStep[];
  progress: { done: number; of: number };
  /** The button for each step's action, already permission-checked by the page. Missing = no button. */
  buttons: Partial<Record<BlockerKey, ReactNode>>;
}) {
  const nowIndex = steps.findIndex((step) => step.state === "now");
  const skipped = steps.filter((step) => step.state === "skipped").map((step) => step.label.toLowerCase());
  const pct = progress.of ? Math.round((progress.done / progress.of) * 100) : 100;
  return (
    <Surface className="p-5" aria-label="Where this deal stands">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Where this deal stands</p>
          <h2 className="mt-1 text-base font-semibold">
            {nowIndex === -1 ? `All ${progress.of} steps done` : `${progress.done} of ${progress.of} steps done · now: ${steps[nowIndex].label}`}
          </h2>
        </div>
        {skipped.length > 0 && <p className="text-xs text-muted-foreground">Not needed on this deal, so not counted: {skipped.join(", ")}</p>}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.of} aria-valuenow={progress.done} aria-label="Steps done">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {steps.map((step) => {
          const button = (step.state === "now" || step.state === "next") && step.action ? buttons[step.action] : null;
          return (
            <li key={step.key} className={cn("flex flex-col gap-1.5 rounded-xl border p-3.5", CARD[step.state])} aria-current={step.state === "now" ? "step" : undefined}>
              <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", BADGE[step.state].className)}>
                {step.state === "done" ? <Check className="size-3" aria-hidden="true" /> : step.state === "skipped" ? <Minus className="size-3" aria-hidden="true" /> : null}
                {BADGE[step.state].text}
              </span>
              <p className={cn("text-sm font-semibold", step.state === "skipped" && "text-muted-foreground")}>{step.label}</p>
              <p className={cn("text-xs leading-5", step.state === "now" ? "text-foreground/85" : "text-muted-foreground")}>{step.detail}</p>
              {step.who && <p className="text-[11px] text-muted-foreground">Waiting on: {step.who}</p>}
              {button && <div className="mt-1">{button}</div>}
            </li>
          );
        })}
      </ol>
    </Surface>
  );
}
