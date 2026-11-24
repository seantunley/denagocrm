import Link from "next/link";
import { ArrowRight, CheckCircle2, ListChecks } from "lucide-react";
import type { Blocker, BlockerKey } from "@/lib/dealMilestones";
import { Surface } from "@/components/visual-system";

/** Where each blocker is fixed, for someone allowed to fix it there. Null = nowhere for this person: say what, not how. */
export type BlockerActions = Partial<Record<BlockerKey, { label: string; href: string } | null>>;

/**
 * What stands between this deal and handover, in order, each with the place it is
 * fixed (brief §4: "surface the highest-priority blockers and next actions").
 * Every line is a fact from the deal's own records (dealMilestones.ts); nothing is
 * guessed and nothing is sent from here — each button opens the existing screen
 * where that step is done.
 */
export default function DealNextActions({ blockers, actions, noNextStep, scheduleHref }: { blockers: Blocker[]; actions: BlockerActions; noNextStep: boolean; scheduleHref: string | null }) {
  return (
    <Surface className="p-5">
      <div className="flex items-center gap-2">
        <ListChecks className="size-5 text-primary" />
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Next actions</p>
          <h2 className="mt-0.5 text-base font-semibold">What is in the way</h2>
        </div>
      </div>
      {blockers.length === 0 && !noNextStep ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-500" />Nothing in the way.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {blockers.map((blocker, index) => {
            const action = actions[blocker.key];
            return (
              <li key={blocker.key} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <span className="text-sm">
                  {index === 0 && <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">First</span>}
                  {blocker.text}
                </span>
                {action && (
                  <Link href={action.href} className="btn-secondary btn-sm shrink-0">{action.label}<ArrowRight className="size-3.5" /></Link>
                )}
              </li>
            );
          })}
          {noNextStep && (
            <li className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <span className="text-sm">No next step planned</span>
              {scheduleHref && <Link href={scheduleHref} className="btn-secondary btn-sm shrink-0">Schedule<ArrowRight className="size-3.5" /></Link>}
            </li>
          )}
        </ul>
      )}
    </Surface>
  );
}
