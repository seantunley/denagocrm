/**
 * Where a deal stands, from its own records — ONE definition for the deal page's
 * journey, the Deals Centre and the deal's blockers (brief §3–§5). Pure.
 *
 * The rules are the ones the deal page already applied (accepted, deposit, stock,
 * PDI, delivery). What is new: a step that does not apply is SKIPPED, said so,
 * and not counted as missing — a deal with no deposit set is not "waiting for a
 * deposit" (§5: "support optional/skipped milestones explicitly").
 */

export const MILESTONE_KEYS = ["quote", "accepted", "deposit", "stock", "pdi", "delivery"] as const;
export type MilestoneKey = (typeof MILESTONE_KEYS)[number];

export const DEFAULT_MILESTONE_LABELS: Record<MilestoneKey, string> = {
  quote: "Quote",
  accepted: "Accepted",
  deposit: "Deposit",
  stock: "Stock",
  pdi: "PDI",
  delivery: "Delivery",
};

export type DealFacts = {
  accepted: boolean;
  /** The deposit the quote asks for, in cents. 0 = none set. */
  depositCents: number;
  depositPaid: boolean;
  /** Units sold or reserved against the quote. */
  stock: { pdiStatus: string }[];
  deliveryBooked: boolean;
  delivered: boolean;
  /** Finance through an outside house that is not approved yet — it holds delivery (dealFinanceRules). */
  financeHolds?: boolean;
};

export type Milestone = { key: MilestoneKey; label: string; done: boolean; skipped: boolean };

const PDI_READY = new Set(["ready_for_delivery", "passed"]);
export const pdiReady = (stock: DealFacts["stock"]) => stock.length > 0 && stock.every((unit) => PDI_READY.has(unit.pdiStatus));

export function dealMilestones(facts: DealFacts, labels: Record<MilestoneKey, string> = DEFAULT_MILESTONE_LABELS): Milestone[] {
  const depositSkipped = facts.depositCents <= 0 && !facts.depositPaid;
  const done: Record<MilestoneKey, boolean> = {
    quote: true,
    accepted: facts.accepted,
    deposit: facts.depositPaid,
    stock: facts.stock.length > 0,
    pdi: pdiReady(facts.stock),
    delivery: facts.delivered,
  };
  // A delivered deal went through every step, whatever was or wasn't recorded on the way.
  return MILESTONE_KEYS.map((key) => {
    const skipped = key === "deposit" && depositSkipped;
    return { key, label: labels[key], done: facts.delivered || done[key], skipped: !facts.delivered && skipped };
  });
}

/** The step the deal is on: the first one neither done nor skipped (the last, once all are). */
export function currentMilestone(milestones: Milestone[]): Milestone {
  return milestones.find((step) => !step.done && !step.skipped) ?? milestones[milestones.length - 1];
}

/**
 * What is stopping this deal, in order — factual, each one a thing someone can
 * go and do. Nothing for a delivered deal. Missing data is never a blocker here:
 * every line reads a field the deal actually has.
 */
export function dealBlockers(facts: DealFacts, labels: Record<MilestoneKey, string> = DEFAULT_MILESTONE_LABELS): string[] {
  if (facts.delivered) return [];
  if (!facts.accepted) return [`Not ${labels.accepted.toLowerCase()} yet`];
  const out: string[] = [];
  if (facts.depositCents > 0 && !facts.depositPaid) out.push(`${labels.deposit} not received`);
  if (facts.financeHolds) out.push("Finance not approved — delivery is held");
  if (facts.stock.length === 0) out.push(`No ${labels.stock.toLowerCase()} allocated`);
  else if (!pdiReady(facts.stock)) out.push(`${labels.pdi} not passed`);
  if (!facts.deliveryBooked) out.push(`${labels.delivery} not booked`);
  return out;
}

/** Ready to hand over: accepted, deposit in (or none asked), unit allocated and through PDI, finance not holding it. */
export function readyForDelivery(facts: DealFacts): boolean {
  return (
    facts.accepted &&
    !facts.delivered &&
    (facts.depositCents <= 0 || facts.depositPaid) &&
    !facts.financeHolds &&
    pdiReady(facts.stock)
  );
}
