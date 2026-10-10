/**
 * Should the research loop keep looking, or answer with what it has?
 *
 * Pure. Called after each round of lookups. Prefers a deterministic answer
 * (required tool missing, empty result, repeated lookup) and only falls
 * through to "unsure" when the model should decide.
 */

export type GateInput = {
  question: string;
  /** Tools called so far, in order. */
  tools: string[];
  /** True if the last round returned no rows and no data. */
  lastRoundEmpty: boolean;
  /** True if the plan step said "then":"answer". */
  planSaysAnswer: boolean;
  stepsUsed: number;
  maxSteps: number;
};

export type GateDecision = "continue" | "answer" | "unsure";

const WHY_OR_STUCK = /\b(why|stuck|stalled|quiet|no sales|what should)\b/i;
const COMPARE = /\b(compare|versus|vs\.?|difference between)\b/i;

/**
 * Minimum evidence for common question shapes. If the required tool has not
 * run, keep going (unless we are out of steps).
 */
function missingRequired(question: string, tools: string[]): string | null {
  if (WHY_OR_STUCK.test(question) && !tools.includes("lead_brief") && !tools.includes("sales_stats")) {
    return "why/stuck needs lead_brief or sales_stats";
  }
  if (COMPARE.test(question) && tools.filter((t) => t === "find_leads" || t === "sales_stats").length < 1) {
    return "comparison needs at least one pipeline lookup";
  }
  return null;
}

export function researchGate(input: GateInput): GateDecision {
  if (input.stepsUsed >= input.maxSteps) return "answer";
  if (input.planSaysAnswer && !missingRequired(input.question, input.tools)) return "answer";

  const missing = missingRequired(input.question, input.tools);
  if (missing) return "continue";

  // Last round found nothing and we already tried the obvious tool: stop.
  if (input.lastRoundEmpty && input.tools.length > 0) return "answer";

  // Repeated the same tool three times: stop.
  const last = input.tools.at(-1);
  if (last && input.tools.filter((t) => t === last).length >= 3) return "answer";

  return "unsure";
}
