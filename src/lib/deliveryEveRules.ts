import { STEP_DONE, stepDone, whatToDo, type GoalFacts, type GoalStep } from "./assistantGoalRules";
import { johannesburgDayStart } from "./proactiveRules";
import { johannesburgDateKey } from "./activityDay";

/**
 * THE DAY BEFORE A DELIVERY (round 2, item 5). The salesperson on a signed deal booked for tomorrow gets one check:
 * is the deposit in, the invoice issued, the cart allocated and through its PDI — the delivery goal's own steps
 * (assistantGoalRules), each missing one with where to do it. NOTHING GOES TO THE CUSTOMER: a reminder for them is a
 * draft the person asks DAX for and sends themselves. Pure here; deliveryEve.ts reads the CRM and raises the alert.
 */

const CHECKED: readonly GoalStep[] = ["deposit", "documents", "prep"];
const DAY = 86_400_000;

/** Tomorrow in Johannesburg, as [start, end). */
/**
 * Once per booked DAY in Johannesburg (review of #951): the time moved within the day is the same delivery, already
 * checked; rebooked to another day, it is checked again for that day.
 */
export const deliveryEveKey = (quoteId: string, scheduled: Date) => `${quoteId}:${johannesburgDateKey(scheduled)}`;

export function tomorrowWindow(now: Date): { gte: Date; lt: Date } {
  const start = new Date(johannesburgDayStart(now).getTime() + DAY);
  return { gte: start, lt: new Date(start.getTime() + DAY) };
}

const SCREEN: Record<string, string> = { deposit: "/deliveries", documents: "/deliveries", prep: "/stock" };

/** The alert's words: the deal, then each check — ✅ done, or ❌ with what to do and its link. */
export function deliveryEveText(f: GoalFacts, customer: string, origin: string): string {
  const base = origin.replace(/\/$/, "");
  const when = f.deliveryScheduledFor
    ? f.deliveryScheduledFor.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "tomorrow";
  const missing = CHECKED.filter((s) => !stepDone(s, f));
  return [
    `🚚 Tomorrow's delivery: ${f.ref} for ${customer} (${when}).`,
    ...CHECKED.map((s) => (stepDone(s, f) ? `✅ ${STEP_DONE[s]}` : `❌ ${STEP_DONE[s]} — not yet. ${whatToDo(s)} ${base}${SCREEN[s]}`)),
    missing.length ? "" : "All set.",
    "Nothing has been sent to the customer. Want a reminder for them? Ask me for a draft — you send it.",
  ].filter(Boolean).join("\n");
}
