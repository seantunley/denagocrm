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
  weight: number;
  /** Rendered verbatim. This is the product — see the header. */
  detail: string;
  /** ISO instant the condition started, where one is knowable. */
  since?: string;
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
  const total = signals.reduce((sum, signal) => sum + signal.weight, 0);
  return Math.min(MAX_ATTENTION_SCORE, total);
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

/** Is this lead's attention currently snoozed? */
export function isSnoozed(snoozedUntil: Date | null | undefined, now: Date): boolean {
  return snoozedUntil != null && snoozedUntil.getTime() > now.getTime();
}

/** How long a snooze lasts. One working week — long enough to mean it. */
export const SNOOZE_DAYS = 7;

const BAND_LABELS: Record<AttentionBand, string> = {
  urgent: "Urgent",
  act: "Act",
  watch: "Watch",
  none: "Clear",
};

export function attentionBandLabel(band: AttentionBand): string {
  return BAND_LABELS[band];
}
