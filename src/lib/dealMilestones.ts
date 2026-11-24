/**
 * Where a deal stands, from its own records — ONE definition for the deal page's
 * journey, the Deals Centre and the deal's blockers (brief §3–§5). Pure.
 *
 * The rules are the ones the deal page already applied (accepted, deposit, stock,
 * PDI, delivery). What is new:
 *  - a step that does not apply TO THIS DEAL is SKIPPED, said so, and not counted
 *    as missing — a deal with no deposit set is not "waiting for a deposit";
 *  - a step the workspace's LIFECYCLE does not have (dealLifecycle.ts) is not on
 *    the journey at all, is never a blocker and never holds delivery. A consulting
 *    firm's deal has no stock and no PDI; pretending some other check is "PDI"
 *    would be a lie (§5: "do not pretend unrelated conditions are equivalent").
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

/** A workspace's way of selling: what each step is called, and which steps it has. */
export type Lifecycle = { labels: Record<MilestoneKey, string>; steps: readonly MilestoneKey[] };
export const AUTOMOTIVE_LIFECYCLE: Lifecycle = { labels: DEFAULT_MILESTONE_LABELS, steps: MILESTONE_KEYS };

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

const has = (lifecycle: Lifecycle, key: MilestoneKey) => lifecycle.steps.includes(key);

export function dealMilestones(facts: DealFacts, lifecycle: Lifecycle = AUTOMOTIVE_LIFECYCLE): Milestone[] {
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
  return lifecycle.steps.map((key) => {
    const skipped = key === "deposit" && depositSkipped;
    return { key, label: lifecycle.labels[key], done: facts.delivered || done[key], skipped: !facts.delivered && skipped };
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
export const BLOCKER_KEYS = ["accept", "deposit", "finance", "stock", "pdi", "delivery"] as const;
export type BlockerKey = (typeof BLOCKER_KEYS)[number];
export type Blocker = { key: BlockerKey; text: string };

export function dealBlockers(facts: DealFacts, lifecycle: Lifecycle = AUTOMOTIVE_LIFECYCLE): Blocker[] {
  const { labels } = lifecycle;
  if (facts.delivered) return [];
  if (!facts.accepted) return [{ key: "accept", text: `Not ${labels.accepted.toLowerCase()} yet` }];
  const out: Blocker[] = [];
  if (has(lifecycle, "deposit") && facts.depositCents > 0 && !facts.depositPaid) out.push({ key: "deposit", text: `${labels.deposit} not received` });
  if (facts.financeHolds) out.push({ key: "finance", text: `Finance not approved — ${labels.delivery.toLowerCase()} is held` });
  if (has(lifecycle, "stock") && facts.stock.length === 0) out.push({ key: "stock", text: `No ${labels.stock.toLowerCase()} allocated` });
  else if (has(lifecycle, "pdi") && facts.stock.length > 0 && !pdiReady(facts.stock)) out.push({ key: "pdi", text: `${labels.pdi} not passed` });
  if (has(lifecycle, "delivery") && !facts.deliveryBooked) out.push({ key: "delivery", text: `${labels.delivery} not booked` });
  return out;
}

/** How far along: steps done out of the steps that apply (a skipped step counts in neither). */
export function dealProgress(milestones: Milestone[]): { done: number; of: number } {
  const applies = milestones.filter((step) => !step.skipped);
  return { done: applies.filter((step) => step.done).length, of: applies.length };
}

/** Ready to hand over: accepted, deposit in (or none asked), and — where the lifecycle has them — unit allocated and through PDI; finance not holding it. */
export function readyForDelivery(facts: DealFacts, lifecycle: Lifecycle = AUTOMOTIVE_LIFECYCLE): boolean {
  return (
    facts.accepted &&
    !facts.delivered &&
    (!has(lifecycle, "deposit") || facts.depositCents <= 0 || facts.depositPaid) &&
    !facts.financeHolds &&
    (!has(lifecycle, "stock") || facts.stock.length > 0) &&
    (!has(lifecycle, "pdi") || pdiReady(facts.stock))
  );
}
