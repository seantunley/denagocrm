import AssistantPlanCard from "@/components/AssistantPlanCard";
import type { PlanView } from "@/lib/assistantPlanRules";

/**
 * The person's multi-step plans on the Ask page (nothing hidden): one waiting
 * for Confirm, or paused part-way ("paused at step 3 — Retry / Close"), is shown
 * with its buttons; finished, expired and closed ones are listed underneath.
 */
export default function AssistantPlans({ plans }: { plans: PlanView[] }) {
  if (!plans.length) return null;
  const active = plans.filter((p) => p.status === "waiting" || p.status === "paused" || p.status === "running" || p.status === "interrupted");
  const past = plans.filter((p) => !active.includes(p));
  return (
    <section className="card space-y-3 p-4 text-sm">
      <h2 className="font-medium">📋 Plans</h2>
      {active.map((p) => <AssistantPlanCard key={p.taskId} plan={p} />)}
      {past.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Finished, expired or closed ({past.length})</summary>
          <div className="mt-2 space-y-2">{past.map((p) => <AssistantPlanCard key={p.taskId} plan={p} />)}</div>
        </details>
      )}
    </section>
  );
}
