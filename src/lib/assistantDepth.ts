import { MAX_LOOKUPS, MAX_LOOKUPS_INVESTIGATE, MAX_STEPS, MAX_STEPS_COMPLEX, isComplexQuestion, stepObject } from "./crmAssistantPlan";

/**
 * Adaptive thinking (DAX roadmap Phase 4a): how hard DAX looks before it answers.
 * Pure, so the rules can be tested without ChatGPT.
 *
 * Quick questions stay quick. A real investigation looks harder and thinks longer,
 * and stops when another lookup wouldn't change the answer. Two depths:
 * - quick: today's ordinary path, unchanged (3 rounds, 6 lookups, low effort).
 * - investigate: up to 8 rounds and 10 lookups, medium effort on planning AND
 *   on the answer, still inside the 280 s hard deadline.
 *
 * The keyword detector (isComplexQuestion) is the FLOOR: a question it calls
 * complex is never treated as quick. The research step's ledger can only deepen.
 * No ledger, or a malformed one, leaves the depth where the keywords put it.
 */

export type Depth = "quick" | "investigate";
export type Effort = "low" | "medium";

/** Under the route's 300 s limit, so a slow plan + retry + answer still finishes. */
export const HARD_DEADLINE_MS = 280_000;
/** Below this, a model call isn't worth starting. */
export const MIN_CALL_MS = 5_000;

export type DepthBudget = {
  maxSteps: number;
  maxLookups: number;
  /** Research time, before the answer's reserve is taken off the hard deadline. */
  researchMs: number;
  /** Kept back for the answer step. */
  answerReserveMs: number;
  /** The answer call's own cap. */
  answerMaxMs: number;
  planEffort: Effort;
  answerEffort: Effort;
};

export const DEPTH_BUDGETS: Record<Depth, DepthBudget> = {
  // Exactly today's ordinary question: nothing about it gets slower.
  quick: { maxSteps: MAX_STEPS, maxLookups: MAX_LOOKUPS, researchMs: 90_000, answerReserveMs: 70_000, answerMaxMs: 60_000, planEffort: "low", answerEffort: "low" },
  // Research ends by 195 s at the latest; the medium-effort answer gets up to 80 s of the 85 s kept back.
  investigate: { maxSteps: MAX_STEPS_COMPLEX, maxLookups: MAX_LOOKUPS_INVESTIGATE, researchMs: 195_000, answerReserveMs: 85_000, answerMaxMs: 80_000, planEffort: "medium", answerEffort: "medium" },
};

/**
 * Where a question starts. A question that skips research (the fast path, small
 * talk) is always quick, so its answer runs exactly as before.
 */
export function startingDepth(question: string, research: boolean): Depth {
  return research && isComplexQuestion(question) ? "investigate" : "quick";
}

/** What the research step said about its own progress. Both parts optional. */
export type Ledger = {
  depth: Depth | null;
  /** Would another lookup AFTER this round change the answer? */
  more: boolean | null;
};

/**
 * The ledger in a research reply, or null when there is none or it is unusable.
 * Only the depth and the yes/no are read: the free-text parts (need / have /
 * unsure) are the model's own working and are never logged or stored.
 */
export function parseLedger(text: string): Ledger | null {
  const raw = stepObject(text);
  const ledger = raw?.ledger;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return null;
  const l = ledger as Record<string, unknown>;
  const d = l.depth ?? raw?.depth;
  const depth = d === "quick" || d === "investigate" ? d : null;
  const more = typeof l.more === "boolean" ? l.more : null;
  return depth || more !== null ? { depth, more } : null;
}

/** The ledger can deepen a question, never make it shallower. */
export function deepen(current: Depth, ledger: Ledger | null): Depth {
  return current === "investigate" || ledger?.depth === "investigate" ? "investigate" : "quick";
}

/** Research time left at this depth, after the answer's reserve. */
export function researchLeftMs(depth: Depth, elapsedMs: number): number {
  const b = DEPTH_BUDGETS[depth];
  return Math.min(b.researchMs, HARD_DEADLINE_MS - b.answerReserveMs) - elapsedMs;
}

/**
 * Is there time for another round? Budgeted against the clock, not just the
 * count: a round needs at least as long as the slowest one so far took.
 */
export function roundFits(leftMs: number, slowestRoundMs: number): boolean {
  return leftMs >= Math.max(MIN_CALL_MS, slowestRoundMs);
}
