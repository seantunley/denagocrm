import Link from "next/link";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { goalsForAskPage } from "@/lib/assistantGoals";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { closeDeliveryGoal, setDeliveryGoalOn, startDeliveryGoalAction } from "@/app/actions/assistantGoals";

/**
 * "Following" on the Ask page (roadmap Phase 4b): every delivery goal the person set, open or recently finished,
 * each with Off/On and Close — nothing DAX follows is hidden. Shown while the Automotive module is on, or while
 * the person still has goals to see.
 */
export default async function AssistantGoalsCard({ userId, name }: { userId: string; name: string }) {
  const [automotive, goals] = await Promise.all([isModuleEnabled("automotive"), goalsForAskPage(userId)]);
  if (!automotive && goals.length === 0) return null;
  const open = goals.filter((g) => g.status === "open");
  const past = goals.filter((g) => g.status !== "open");
  return (
    <section className="card space-y-3 p-4 text-sm">
      <h2 className="font-medium">🚚 Following</h2>
      <p className="text-muted-foreground">
        Ask {name} to keep an eye on a delivery until it&apos;s done: deposit, invoice, cart prep, booking, handover. It tells you the next
        blocker, says when it stalls, and stops its own reminders once the cart is delivered. It never contacts the customer. Updates come the
        way proactive DAX&apos;s do, so switch that on for yourself first.
      </p>
      {automotive && (
        <SaveForm action={startDeliveryGoalAction} className="flex gap-2">
          <input name="quote" required maxLength={64} className="input w-full" placeholder="Accepted quote, e.g. Q-1042" aria-label="Quote number" />
          <SaveButton className="btn-secondary btn-sm shrink-0">Follow</SaveButton>
        </SaveForm>
      )}
      {open.length > 0 && (
        <ul className="divide-y divide-border/50">
          {open.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-medium">{g.title}</p>
                <p className="text-muted-foreground">
                  {g.paused ? "Off — not checking" : g.proactiveOff ? "Paused — proactive DAX is off for you; switch it on and it picks up where the delivery is now" : g.nextAction}
                </p>
                {g.quoteId && <Link href={`/deals/${g.quoteId}`} className="text-xs text-primary underline">Open the deal</Link>}
              </div>
              <div className="flex shrink-0 gap-3">
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-foreground">{g.paused ? "On" : "Off"}</button>}
                  title={g.paused ? "Switch this back on?" : "Switch this off?"}
                  description={g.paused ? "It checks again from the next half hour." : "It stops checking and won't tell you anything about it until you switch it back on."}
                  confirmLabel={g.paused ? "On" : "Off"}
                  onConfirm={setDeliveryGoalOn.bind(null, g.id, g.paused)}
                />
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Close</button>}
                  title="Stop following this delivery?"
                  description="Nothing in the CRM changes. Updates it hasn't sent yet are dropped."
                  confirmLabel="Close"
                  onConfirm={closeDeliveryGoal.bind(null, g.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Finished or closed ({past.length})</summary>
          <ul className="mt-2 divide-y divide-border/50">
            {past.map((g) => (
              <li key={g.id} className="py-2">
                <p>{g.title}</p>
                <p className="text-xs text-muted-foreground">{g.status === "done" ? "Done" : "Closed"}{g.nextAction ? ` — ${g.nextAction}` : ""}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
