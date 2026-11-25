/**
 * Where a deal stands, in words — the deal page's one "where this deal stands"
 * panel and its headline (deal page redesign, wave 2 W2-05). It replaces three
 * separate views of the same facts (journey strip, "What is in the way",
 * "Ready to deliver?"), so they can no longer disagree.
 *
 * Pure. The steps, what is done and what is skipped come from dealMilestones
 * (the shared rules the Deals Centre uses); this only adds which step is NOW,
 * which is NEXT, one line of why, and who it is waiting on.
 */
import type { BlockerKey, Milestone, MilestoneKey } from "./dealMilestones";

export type StepState = "done" | "now" | "skipped" | "next" | "later";

export type StandStep = {
  key: MilestoneKey;
  label: string;
  state: StepState;
  detail: string;
  /** Whose move it is. Null when it is nobody's yet. */
  who: string | null;
  /** The blocker this step clears, for its button. Null = no button on this step. */
  action: BlockerKey | null;
};

export type StandFacts = {
  journey: Milestone[];
  /** The quote's status: draft | sent | accepted | declined | cancelled. */
  status: string;
  accepted: boolean;
  delivered: boolean;
  financeHolds: boolean;
  sentAt: Date | null;
  /** When the customer first opened it (the CRM keeps the first open only). */
  viewedAt: Date | null;
  signedAt: Date | null;
  depositPaid: boolean;
  /** The deposit asked, already formatted in the deal's currency; null = none asked. */
  depositLabel: string | null;
  stockCount: number;
  pdiReady: boolean;
  deliveryAt: Date | null;
  deliveredAt: Date | null;
  customer: string;
  /** The workspace's word for a ready deal: "Ready for delivery?" → "Ready for delivery". */
  readyTitle: string;
  date: (d: Date) => string;
};

export type StandHeadline = { text: string; tone: "success" | "warning" | "danger" | "info" | "neutral"; detail: string | null };

const WHO: Partial<Record<MilestoneKey, string>> = { accepted: "Customer", deposit: "Customer", stock: "Sales", pdi: "Workshop", delivery: "Deliveries" };

/**
 * Something holding the deal up that is not a step of its own — today only
 * finance. Shown on the panel above the steps, with its own button.
 */
export type StandHold = { key: "finance"; label: string; detail: string; who: string; action: BlockerKey };

export function dealStand(facts: StandFacts): { steps: StandStep[]; headline: StandHeadline; holds: StandHold[] } {
  const draft = facts.status === "draft";
  // A declined or cancelled deal is over: no step is "now", nothing to chase or do.
  const closed = !facts.delivered && (facts.status === "declined" || facts.status === "cancelled");
  const open = facts.journey.filter((step) => !step.done && !step.skipped);
  // A draft has not reached the customer: the quote itself is the step it is on.
  const nowKey: MilestoneKey | null = closed ? null : draft ? "quote" : open[0]?.key ?? null;
  const nextKey: MilestoneKey | null = closed ? null : draft ? (open[0]?.key ?? null) : open[1]?.key ?? null;

  const steps = facts.journey.map((step): StandStep => {
    const state: StepState =
      step.key === nowKey ? "now" : step.skipped ? "skipped" : step.done && !(draft && step.key === "quote") ? "done" : step.key === nextKey ? "next" : "later";
    const detail = { key: step.key, label: step.label, state, ...detailOf(step.key, state, facts) };
    return closed && state !== "done" ? { ...detail, who: null, action: null } : detail;
  });

  const holds: StandHold[] =
    facts.financeHolds && facts.accepted && !facts.delivered && !closed
      ? [{ key: "finance", label: "Finance", detail: "Not approved yet — delivery waits for it", who: "Finance house", action: "finance" }]
      : [];

  return { steps, headline: headlineOf(facts, steps), holds };
}

function detailOf(key: MilestoneKey, state: StepState, f: StandFacts): { detail: string; who: string | null; action: BlockerKey | null } {
  const done = state === "done";
  const who = done || state === "skipped" ? null : WHO[key] ?? null;
  switch (key) {
    case "quote":
      return { detail: f.status === "draft" ? "Draft — not sent to the customer yet" : f.sentAt ? `Sent ${f.date(f.sentAt)}` : "Sent", who: f.status === "draft" ? "Sales" : null, action: null };
    case "accepted":
      if (done) return { detail: f.signedAt ? `Signed ${f.date(f.signedAt)}` : "Marked accepted", who, action: null };
      return {
        detail: f.viewedAt ? `${f.customer} to accept · opened ${f.date(f.viewedAt)}` : f.sentAt ? `${f.customer} to accept · not opened yet` : `${f.customer} to accept`,
        who,
        action: f.status === "draft" ? null : "accept",
      };
    case "deposit":
      if (state === "skipped") return { detail: "Not needed — none asked on this deal", who, action: null };
      if (done) return { detail: "Received", who, action: null };
      return { detail: f.depositLabel ? `${f.depositLabel} expected` : "Expected", who, action: f.accepted ? "deposit" : null };
    case "stock":
      if (done) return { detail: `${f.stockCount} unit${f.stockCount === 1 ? "" : "s"} allocated`, who, action: null };
      return { detail: f.accepted ? "Not allocated" : "Not allocated · after acceptance", who, action: "stock" };
    case "pdi":
      if (done) return { detail: "Passed", who, action: null };
      return { detail: f.stockCount ? "Workshop to complete" : "Starts once a unit is allocated", who, action: f.stockCount ? "pdi" : null };
    case "delivery":
      if (done) return { detail: f.deliveredAt ? `Delivered ${f.date(f.deliveredAt)}` : "Delivered", who, action: null };
      return { detail: f.deliveryAt ? `Booked for ${f.date(f.deliveryAt)}` : "Not booked", who, action: f.accepted ? "delivery" : null };
  }
}

function headlineOf(f: StandFacts, steps: StandStep[]): StandHeadline {
  const sent = [f.sentAt ? `Sent ${f.date(f.sentAt)}` : null, f.viewedAt ? `opened ${f.date(f.viewedAt)}` : f.sentAt ? "not opened yet" : null].filter(Boolean).join(" · ") || null;
  if (f.delivered) return { text: f.deliveredAt ? `Delivered ${f.date(f.deliveredAt)}` : "Delivered", tone: "success", detail: null };
  if (f.status === "declined") return { text: "Declined by the customer", tone: "danger", detail: sent };
  if (f.status === "cancelled") return { text: "Cancelled", tone: "danger", detail: null };
  if (f.status === "draft") return { text: "Draft — not sent to the customer yet", tone: "warning", detail: null };
  if (!f.accepted) return { text: "Waiting for the customer to accept", tone: "warning", detail: sent };
  if (f.financeHolds) return { text: "Finance not approved — delivery is held", tone: "warning", detail: null };
  const now = steps.find((step) => step.state === "now");
  if (!now) return { text: f.readyTitle.replace(/\?$/, ""), tone: "success", detail: null };
  // The step's own detail is on the panel just below; the headline doesn't repeat it.
  return { text: `Accepted · next: ${now.label.toLowerCase()}`, tone: "info", detail: null };
}

/**
 * A warning on the deal's next step, when its date doesn't make sense: none
 * planned, already late, or after the quote stops being valid while the
 * customer still hasn't accepted. Null when it is fine.
 */
export function nextStepWarning(input: {
  nextDue: Date | null;
  validUntil: Date | null;
  accepted: boolean;
  delivered: boolean;
  closed: boolean;
  now: Date;
  date: (d: Date) => string;
}): string | null {
  if (input.delivered || input.closed) return null;
  if (!input.nextDue) return "No next step planned on this deal.";
  if (input.nextDue < input.now) return "This is overdue.";
  if (!input.accepted && input.validUntil && input.nextDue > input.validUntil) {
    return `That's after the quote's valid-until date (${input.date(input.validUntil)}). Bring it forward?`;
  }
  return null;
}
