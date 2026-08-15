/**
 * The Attention Centre — the PURE half.
 *
 * Same seam as `stageGate.ts` and `journeyTypes.ts`: no imports, so the Kanban
 * board can bring the predicate into the browser bundle without dragging
 * server-only code with it. `signals.ts` is the impure counterpart.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * One line in KanbanBoard.tsx:
 *
 *     const needsAttention =
 *       !attentionOnly || lead.noNextStep || lead.nextStep?.overdue || isStale(...);
 *
 * A boolean can answer "is this card interesting" and nothing else. It cannot
 * rank, it cannot say WHY, and because it is a filter it hides every other card —
 * destroying the board's spatial meaning at exactly the moment you want context.
 *
 * ── THE DETAIL STRING IS THE PRODUCT ────────────────────────────────────────
 *
 * "Quote Q-1042 expires tomorrow" is what a person acts on. The number only
 * orders the list. Every signal therefore carries a sentence written to be read
 * verbatim, and the scorer never invents one.
 */

export type AttentionSignalKind =
  | "unanswered_inbound"
  | "overdue_task"
  | "quote_expiring"
  | "no_next_step"
  | "stage_age";

export type AttentionCategory = "customer" | "commitment" | "workflow";

export const ATTENTION_CATEGORY: Record<AttentionSignalKind, AttentionCategory> = {
  unanswered_inbound: "customer",
  overdue_task: "commitment",
  quote_expiring: "commitment",
  no_next_step: "workflow",
  stage_age: "workflow",
};

/** Related symptoms stay visible, but cannot inflate the same underlying problem. */
export const ATTENTION_CATEGORY_CAPS: Record<AttentionCategory, number> = {
  customer: 60,
  commitment: 45,
  workflow: 25,
};

/**
 * Fixed, and not configurable in v1.
 *
 * Per-tenant weights double the configuration surface for unproven demand. When
 * they are wanted they are a JSON blob read by this same scorer — no schema
 * churn, and no second implementation of the ranking.
 */
export const ATTENTION_WEIGHTS: Record<AttentionSignalKind, number> = {
  unanswered_inbound: 40, // a person is literally waiting
  overdue_task: 30, // we promised a date and missed it
  quote_expiring: 25, // a deadline with money on it
  no_next_step: 20, // nothing will happen unless someone acts
  stage_age: 20,
};

export type AttentionSignal = {
  kind: AttentionSignalKind;
  /** Stable identity of the underlying task, quote or conversation. */
  key: string;
  category: AttentionCategory;
  weight: number;
  /** Rendered verbatim. This is the product — see the header. */
  detail: string;
  /** ISO instant the condition started, where one is knowable. */
  since?: string;
  context?: string;
  actionHref: string;
  actionLabel: string;
};

export type AttentionBand = "none" | "watch" | "act" | "urgent";

export const MAX_ATTENTION_SCORE = 100;

/**
 * Sum, capped. Deliberately not multiplicative.
 *
 * The cap means a lead with four signals and a lead with six both read 100, and
 * that is correct: past a point "how bad" stops being useful and the reasons take
 * over. Ordering within the cap comes from the tiebreak.
 */
export function scoreAttention(signals: AttentionSignal[]): number {
  const totals: Record<AttentionCategory, number> = { customer: 0, commitment: 0, workflow: 0 };
  for (const signal of signals) {
    const category = signal.category ?? ATTENTION_CATEGORY[signal.kind];
    totals[category] += signal.weight;
  }
  const total = (Object.keys(totals) as AttentionCategory[]).reduce(
    (sum, category) => sum + Math.min(totals[category], ATTENTION_CATEGORY_CAPS[category]),
    0,
  );
  return Math.min(MAX_ATTENTION_SCORE, total);
}

export function attentionSignalKey(kind: AttentionSignalKind, entityId?: string | null): string {
  return entityId ? `${kind}:${entityId}` : kind;
}

/**
 * Bands, so the UI never invents its own thresholds.
 *
 * `urgent` starts at 40 rather than something rounder because 40 is exactly
 * `unanswered_inbound` — one person waiting is enough on its own, and a band
 * table that disagreed with the weight table would be two opinions about the
 * same thing.
 */
export function attentionBand(score: number): AttentionBand {
  if (score >= 40) return "urgent";
  if (score >= 20) return "act";
  if (score > 0) return "watch";
  return "none";
}

/**
 * The board's toggle predicate AND the page's inclusion rule.
 *
 * One definition, so "needs attention" cannot mean two things on two screens —
 * which is what the inline boolean guaranteed it would.
 */
export function needsAttention(signals: AttentionSignal[]): boolean {
  return signals.length > 0;
}

/**
 * Rank: score first, then deal value.
 *
 * VALUE IS A TIEBREAK, NEVER A MULTIPLIER. A multiplicative value term makes the
 * number unexplainable — "why is this 63?" — and legibility is the entire reason
 * for replacing a boolean. Keeping value as a tiebreak gets the ordering a
 * manager wants without turning the score into a black box.
 *
 * The accepted cost, stated rather than hidden: a R2m deal with one signal sorts
 * below a R40k deal with three. That is arguably wrong. It is still better than a
 * number nobody can account for.
 *
 * `id` is the final key so the order is total — without it two identical rows can
 * swap between requests and the list appears to shuffle on refresh.
 */
export function compareAttention(
  a: { score: number; valueCents: number; id: string },
  b: { score: number; valueCents: number; id: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.valueCents !== a.valueCents) return b.valueCents - a.valueCents;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Has this lead been dismissed from the list?
 *
 * ── WHY DISMISSAL NEEDS A REASON, AND WHY IT IS NOT OPTIONAL ────────────────
 *
 * This is the one screen whose job is to make sure nothing is forgotten, so the
 * only way off it must be accountable. A one-click dismiss is a button that makes
 * work disappear, and the first time somebody asks "why did nobody chase this
 * deal" the honest answer would be "someone clicked something, we don't know
 * who or why".
 *
 * A reason is therefore REQUIRED, and required at a length that stops "x" and
 * "ok" from satisfying it — the same discipline `MIN_OVERRIDE_REASON` applies to
 * overriding a stage rule, and for the same reason: an audit trail of blank
 * justifications is an audit trail nobody can use.
 */
export function isDismissed(dismissedAt: Date | null | undefined): boolean {
  return dismissedAt != null;
}

/**
 * Is this lead snoozed right now?
 *
 * ── SNOOZE AND DISMISS ARE DIFFERENT TOOLS ──────────────────────────────────
 *
 *   SNOOZE   nothing is wrong — come back on a date.
 *   DISMISS  this does not belong on the list at all.
 *
 * The first build had only snooze, which was reasonless. The second replaced it
 * with dismiss, which was accountable but wrong for the commonest case: the first
 * real screenful had a deal reading "In Italy at the moment. Back on the 19th".
 * Nothing is wrong with that deal. Dismissing it is a lie, and leaving it shouting
 * is what makes a list stop being read.
 *
 * An ELAPSED snooze is simply not snoozed — the comparison is against `now`, so
 * the deal reappears on its own and nothing has to sweep the column.
 */
export function isSnoozed(snoozedUntil: Date | null | undefined, now: Date): boolean {
  return snoozedUntil != null && snoozedUntil.getTime() > now.getTime();
}

/**
 * Long enough that "done" and "n/a" do not pass.
 *
 * Deliberately the same number as `MIN_OVERRIDE_REASON` in stageGate.ts. Two
 * different minimums for two justification fields in the same product is a
 * distinction nobody can defend when asked.
 *
 * ONE minimum for BOTH exits, for the same reason. Snoozing and dismissing are
 * different decisions but they are the same kind of record: the note the next
 * person reads when they ask why this was not on the list.
 */
export const MIN_ATTENTION_REASON = 10;

export function attentionReasonError(reason: string, verb: "snooze" | "dismiss"): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return `A reason is required to ${verb} a deal.`;
  if (trimmed.length < MIN_ATTENTION_REASON) {
    return `Say a little more — at least ${MIN_ATTENTION_REASON} characters, so the record means something later.`;
  }
  return null;
}

/**
 * How far ahead a snooze may reach.
 *
 * Bounded, because an unbounded one is a dismiss wearing a date — "back on this
 * in 2031" silences a deal for practical ever while reading as temporary, and the
 * whole point of having two tools is that the honest one is available. Three
 * months covers every real "call me after the new year" and stops short of
 * indefinite.
 */
export const MAX_SNOOZE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Validate a snooze date. Returns the sentence to show, or null when it is fine. */
export function snoozeDateError(until: Date | null, now: Date): string | null {
  if (!until || Number.isNaN(until.getTime())) return "Pick a date to snooze until.";
  if (until.getTime() <= now.getTime()) return "Pick a date in the future.";
  if (until.getTime() - now.getTime() > MAX_SNOOZE_DAYS * DAY_MS) {
    return `Snooze for at most ${MAX_SNOOZE_DAYS} days — dismiss it instead if it should go for longer.`;
  }
  return null;
}

const BAND_LABELS: Record<AttentionBand, string> = {
  urgent: "Urgent",
  act: "Act",
  watch: "Watch",
  none: "Clear",
};

export function attentionBandLabel(band: AttentionBand): string {
  return BAND_LABELS[band];
}
