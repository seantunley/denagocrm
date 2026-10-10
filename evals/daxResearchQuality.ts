/**
 * DAX research-quality evaluation — pure, so CI can score recorded traces
 * without calling a model.
 *
 * A "trace" is what the research loop produced for one question:
 *   - the tools it called (in order)
 *   - how many plan steps it used
 *   - whether it hit the time budget
 *   - the final answer text
 *
 * Scenarios declare what good research looks like for that question.
 * scoreTrace() returns a 0–100 score plus the individual checks that failed.
 *
 * This does not call ChatGPT. To evaluate a live change, capture traces
 * (tools, steps, answer) from askCrm and pass them here. A future live runner
 * can feed real model output into the same scorer.
 */

export type ResearchTrace = {
  question: string;
  /** Tools called, in order. Parallel lookups in one step stay sequential here. */
  tools: string[];
  /** Plan steps that ran (not counting the final answer write-up). */
  steps: number;
  /** True if the research loop stopped because the time budget was spent. */
  hitBudget: boolean;
  /** Final answer text the person would see. */
  answer: string;
  /** Optional: total milliseconds from question to answer. */
  latencyMs?: number;
  /** Optional: estimated prompt+completion tokens for the research+answer calls. */
  tokens?: number;
};

export type ResearchScenario = {
  id: string;
  question: string;
  /** Expected isComplexQuestion result. */
  complex: boolean;
  /**
   * Tools that should appear at least once. Order is not required unless
   * orderedTools is set.
   */
  requiredTools: string[];
  /** If set, these tools must appear in this order (others may interleave). */
  orderedTools?: string[];
  /** Tools that should not appear (wrong lookup for this question). */
  forbiddenTools?: string[];
  /** Minimum plan steps for a good complex investigation. */
  minSteps?: number;
  /** Maximum plan steps before it is considered wasteful. */
  maxSteps?: number;
  /** Phrases the answer must contain (case-insensitive). */
  answerMustInclude?: string[];
  /** Phrases the answer must not contain (invented facts, hedging that hides missing data). */
  answerMustNotInclude?: string[];
  /** Notes for humans reading the report. */
  note?: string;
};

export const RESEARCH_SCENARIOS: ResearchScenario[] = [
  {
    id: "simple-count",
    question: "how many leads came in last month",
    complex: false,
    requiredTools: ["find_leads"],
    forbiddenTools: ["lead_brief", "web"],
    maxSteps: 2,
    answerMustInclude: ["lead"],
    note: "A count should be one or two lookups, not a multi-hop investigation.",
  },
  {
    id: "why-stuck",
    question: "Why is the Jacobs deal stuck and what should we do to close it?",
    complex: true,
    requiredTools: ["lead_brief"],
    orderedTools: ["find_leads", "lead_brief"],
    minSteps: 2,
    maxSteps: 5,
    answerMustInclude: ["Jacobs"],
    answerMustNotInclude: ["I don't know", "I can't tell"],
    note: "Should find the deal, then read it in depth before recommending.",
  },
  {
    id: "compare-reps",
    question: "Compare Donovan and Kristina's pipelines and tell me who needs help",
    complex: true,
    requiredTools: ["find_leads"],
    minSteps: 1,
    maxSteps: 4,
    answerMustInclude: ["Donovan", "Kristina"],
    note: "Parallel find_leads is fine; a follow-up lead_brief on the weaker pipeline is better but not required.",
  },
  {
    id: "short-why",
    question: "Why no sales?",
    complex: true,
    requiredTools: ["sales_stats"],
    forbiddenTools: ["web"],
    minSteps: 1,
    maxSteps: 4,
    answerMustInclude: ["sales"],
    note: "Short why-questions should still investigate numbers, not guess.",
  },
  {
    id: "what-needs-attention",
    question: "what needs my attention today",
    complex: false,
    requiredTools: ["daily_brief"],
    maxSteps: 2,
    answerMustInclude: ["attention"],
    note: "The brief is already prioritised; no multi-hop needed.",
  },
];

export type CheckResult = { name: string; ok: boolean; detail?: string };

export type Score = {
  scenarioId: string;
  score: number;
  checks: CheckResult[];
};

function includesAll(haystack: string, needles: string[] | undefined): CheckResult {
  if (!needles?.length) return { name: "answer-includes", ok: true };
  const lower = haystack.toLowerCase();
  const missing = needles.filter((n) => !lower.includes(n.toLowerCase()));
  return {
    name: "answer-includes",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : undefined,
  };
}

function excludesAll(haystack: string, needles: string[] | undefined): CheckResult {
  if (!needles?.length) return { name: "answer-excludes", ok: true };
  const lower = haystack.toLowerCase();
  const present = needles.filter((n) => lower.includes(n.toLowerCase()));
  return {
    name: "answer-excludes",
    ok: present.length === 0,
    detail: present.length ? `unexpected: ${present.join(", ")}` : undefined,
  };
}

function hasOrdered(tools: string[], ordered: string[] | undefined): CheckResult {
  if (!ordered?.length) return { name: "tool-order", ok: true };
  let i = 0;
  for (const t of tools) {
    if (t === ordered[i]) i += 1;
    if (i === ordered.length) break;
  }
  return {
    name: "tool-order",
    ok: i === ordered.length,
    detail: i === ordered.length ? undefined : `wanted ${ordered.join(" → ")}, got ${tools.join(" → ") || "(none)"}`,
  };
}

/**
 * Score one trace against its scenario. 100 = all checks pass.
 * Each failed check subtracts an equal share.
 */
export function scoreTrace(scenario: ResearchScenario, trace: ResearchTrace): Score {
  const checks: CheckResult[] = [];

  const missing = scenario.requiredTools.filter((t) => !trace.tools.includes(t));
  checks.push({
    name: "required-tools",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : undefined,
  });

  const forbidden = (scenario.forbiddenTools ?? []).filter((t) => trace.tools.includes(t));
  checks.push({
    name: "forbidden-tools",
    ok: forbidden.length === 0,
    detail: forbidden.length ? `used: ${forbidden.join(", ")}` : undefined,
  });

  checks.push(hasOrdered(trace.tools, scenario.orderedTools));

  if (scenario.minSteps !== undefined) {
    checks.push({
      name: "min-steps",
      ok: trace.steps >= scenario.minSteps,
      detail: `steps=${trace.steps}, min=${scenario.minSteps}`,
    });
  }
  if (scenario.maxSteps !== undefined) {
    checks.push({
      name: "max-steps",
      ok: trace.steps <= scenario.maxSteps,
      detail: `steps=${trace.steps}, max=${scenario.maxSteps}`,
    });
  }

  // Hitting the budget is not automatically bad, but a complex scenario that
  // never looked past one step and still hit the budget is a failure mode.
  if (scenario.complex && trace.hitBudget && trace.steps < 2) {
    checks.push({
      name: "budget-with-depth",
      ok: false,
      detail: "hit budget before a second step",
    });
  } else {
    checks.push({ name: "budget-with-depth", ok: true });
  }

  checks.push(includesAll(trace.answer, scenario.answerMustInclude));
  checks.push(excludesAll(trace.answer, scenario.answerMustNotInclude));

  const passed = checks.filter((c) => c.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { scenarioId: scenario.id, score, checks };
}

/** Mean score across scenarios. Useful as a single CI number. */
export function meanScore(scores: Score[]): number {
  if (!scores.length) return 0;
  return Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length);
}

/**
 * Format a human-readable report. Pure — returns a string.
 */
export function formatReport(scores: Score[]): string {
  const lines = [`DAX research quality: ${meanScore(scores)} / 100 (${scores.length} scenarios)`, ""];
  for (const s of scores) {
    const failed = s.checks.filter((c) => !c.ok);
    lines.push(`${s.scenarioId}: ${s.score}`);
    for (const f of failed) {
      lines.push(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
    }
  }
  return lines.join("\n");
}
