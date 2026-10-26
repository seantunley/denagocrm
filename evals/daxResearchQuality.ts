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

/* ── Goal scenarios (roadmap Phase 4b — delivery goals) ──────────────────────
 *
 * A goal is followed by the assistant cron with plain code, so a scenario is a
 * delivery moving step by step on a SEEDED LOCAL database
 * (scripts/test-assistant-goals.ts, `npm run test:assistant-goals`), scored on
 * what the database shows afterwards. WORK FIRST: a goal that is not finished,
 * leaves its own reminders running, still has updates waiting to go out, touched
 * somebody else's reminders, or contacted the customer scores ZERO.
 */

export type GoalScenario = {
  id: string;
  /** What changes in the CRM between cron passes, in order. */
  steps: string[];
  expect: {
    status: "done" | "closed";
    /** Alert keys (without the goal's id), each matched in this order; none may repeat. */
    alerts: RegExp[];
  };
  note?: string;
};

export type GoalOutcome = {
  status: string;
  /** The goal's alert keys as raised, in order. */
  alerts: string[];
  /** The goal's own watches and DAX check-backs still switched on. */
  ownRemindersOn: number;
  /** Reminders that are NOT the goal's (another person's, the person's own schedules, unrelated ones) that changed. */
  othersChanged: number;
  /** The goal's alerts still waiting to be sent after it finished. */
  pendingAlerts: number;
  /** Messages, emails or anything else that reached the customer. */
  customerMessages: number;
};

export const GOAL_SCENARIOS: GoalScenario[] = [
  {
    id: "delivery-completes-and-stops-reminders",
    steps: ["deposit paid", "invoice issued", "cart allocated and PDI passed", "delivery booked", "delivered"],
    expect: { status: "done", alerts: [/^next:documents:/, /^next:prep:/, /^next:booking:/, /^next:delivered:/, /^done$/] },
    note: "Each step is news once, naming the next blocker; delivered closes the goal and switches off its own watches and check-backs in the same transaction — and nothing else.",
  },
];

export function scoreGoalScenario(scenario: GoalScenario, outcome: GoalOutcome): Score {
  const e = scenario.expect;
  const work: CheckResult[] = [
    { name: "work-status", ok: outcome.status === e.status, detail: `status=${outcome.status}, want ${e.status}` },
    { name: "work-reminders-off", ok: outcome.ownRemindersOn === 0, detail: `${outcome.ownRemindersOn} of its own still on` },
    { name: "work-others-untouched", ok: outcome.othersChanged === 0, detail: `${outcome.othersChanged} changed` },
    { name: "work-nothing-pending", ok: outcome.pendingAlerts === 0, detail: `${outcome.pendingAlerts} still waiting` },
    { name: "work-customer-never-contacted", ok: outcome.customerMessages === 0, detail: `${outcome.customerMessages} sent` },
  ];
  let from = 0;
  const inOrder = e.alerts.every((re) => {
    const at = outcome.alerts.findIndex((k, i) => i >= from && re.test(k));
    from = at + 1;
    return at >= 0;
  });
  const checks: CheckResult[] = [
    ...work,
    { name: "alerts-in-order", ok: inOrder, detail: outcome.alerts.join(", ") },
    { name: "never-twice", ok: new Set(outcome.alerts).size === outcome.alerts.length, detail: outcome.alerts.join(", ") },
  ];
  const passed = checks.filter((c) => c.ok).length;
  return { scenarioId: scenario.id, score: work.every((c) => c.ok) ? Math.round((passed / checks.length) * 100) : 0, checks };
}

/* ── Multi-turn task scenarios (roadmap §4; Phase 1 — job sheets) ────────────
 *
 * A scenario is a scripted conversation run against a SEEDED LOCAL database
 * (scripts/eval-dax-tasks.ts — never the hosted dev DB) and scored on what the
 * DATABASE shows afterwards, not on how the answer reads: a fluent "done!" with
 * no quote in the CRM scores ZERO. Then unnecessary questions, recovery (the
 * right customer, nothing made twice) and time.
 *
 * The seed every scenario assumes: products "Denago Rover XL" (White, Gray) and
 * "Golf Caddie"; customers "Anna Jacobs" and "Anna Jacobsen" (the plan's
 * similar-names case: two customers with nearly the same name, both the asker's).
 * Fictional names only — never a real customer's in this public repository.
 */

export type TaskTurn = {
  /** Where it is asked: the CRM chat or WhatsApp — the same job sheets in both. */
  channel: "chat" | "whatsapp";
  ask: string;
  /** Hours since the previous turn — the runner moves the earlier turns and sheets back by this much. */
  afterHours?: number;
  /** Press Confirm on every quote card this answer offered (as the person would). */
  confirm?: boolean;
};

export type ExpectedLine = { product: string; qty: number; colour?: string };

export type TaskScenario = {
  id: string;
  turns: TaskTurn[];
  expect: {
    /** Draft quotes the person ends up with from this conversation (made twice = a failure). */
    quotes: number;
    /** For that quote: the customer's name, and exactly these lines (and fees, in rands). */
    customer?: string;
    lines?: ExpectedLine[];
    fees?: { label: string; amount: number }[];
    /** Open job sheets afterwards. */
    openSheets?: number;
    /** Questions DAX may ask across the whole conversation before it is "unnecessary". */
    maxQuestions?: number;
    /** It must ask (e.g. which of two similarly named customers) before it does anything. */
    mustAsk?: RegExp;
  };
  note?: string;
};

/** What the database and the answers showed after the scripted conversation. */
export type TaskOutcome = {
  quotes: { customer: string; lines: ExpectedLine[]; fees: { label: string; amount: number }[] }[];
  openSheets: number;
  answers: string[];
  /** Milliseconds per turn. */
  latencyMs?: number[];
};

export const TASK_SCENARIOS: TaskScenario[] = [
  {
    id: "grey-to-white",
    turns: [
      { channel: "chat", ask: "Quote Anna Jacobs for a Rover XL in grey, delivery to Hermanus R6500" },
      { channel: "chat", ask: "Actually make it white" },
      { channel: "chat", ask: "Yes, go ahead", confirm: true },
    ],
    expect: {
      quotes: 1, customer: "Anna Jacobs",
      lines: [{ product: "Denago Rover XL", qty: 1, colour: "White" }],
      fees: [{ label: "Hermanus", amount: 6500 }],
      openSheets: 1, maxQuestions: 1,
    },
    note: "The correction changes one line of the sheet; the quote is built from the sheet — white, with the delivery fee still on it.",
  },
  {
    id: "add-a-line",
    turns: [
      { channel: "chat", ask: "Quote Anna Jacobs for a Rover XL in white", confirm: true },
      { channel: "chat", ask: "Add a golf caddie to that quote", confirm: true },
    ],
    expect: {
      quotes: 1, customer: "Anna Jacobs",
      lines: [{ product: "Denago Rover XL", qty: 1, colour: "White" }, { product: "Golf Caddie", qty: 1 }],
      maxQuestions: 1,
    },
    note: "After the quote exists, an addition is a quote_add on the sheet's quote — never a second quote.",
  },
  {
    id: "continue-across-channels-24h",
    turns: [
      { channel: "chat", ask: "Start a quote for Anna Jacobs: Rover XL, white. I'll confirm the delivery fee tomorrow." },
      { channel: "whatsapp", ask: "Continue that quote — delivery is R6500 to Hermanus. Go ahead.", afterHours: 24, confirm: true },
    ],
    expect: {
      quotes: 1, customer: "Anna Jacobs",
      lines: [{ product: "Denago Rover XL", qty: 1, colour: "White" }],
      fees: [{ label: "Hermanus", amount: 6500 }],
      maxQuestions: 1,
    },
    note: "A day later, on WhatsApp: past the 3-hour conversation window, so only the job sheet carries it.",
  },
  {
    id: "two-similar-names",
    turns: [
      // A voice note's spelling that is close to BOTH customers.
      { channel: "chat", ask: "Quote Anna Jacobson for a Rover XL in white" },
      { channel: "chat", ask: "Anna Jacobsen", confirm: true },
    ],
    expect: {
      quotes: 1, customer: "Anna Jacobsen",
      lines: [{ product: "Denago Rover XL", qty: 1, colour: "White" }],
      mustAsk: /anna jacobs\b[\s\S]*anna jacobsen|anna jacobsen[\s\S]*anna jacobs\b/i,
      maxQuestions: 1,
    },
    note: "Two customers with nearly the same name: ask which, then quote the one chosen — never guess.",
  },
];

const questionsIn = (answer: string) => answer.split("\n").filter((line) => line.trim().endsWith("?")).length;

/**
 * Score one scripted conversation. WORK FIRST: when the database does not hold
 * exactly the quote(s) expected — the right customer, lines and fees, nothing
 * made twice — the score is 0, however good the answers read.
 */
export function scoreTaskScenario(scenario: TaskScenario, outcome: TaskOutcome): Score {
  const e = scenario.expect;
  const checks: CheckResult[] = [];
  const quote = outcome.quotes[0];
  const sameLines = (got: ExpectedLine[], want: ExpectedLine[]) =>
    got.length === want.length &&
    want.every((w) => got.some((g) => g.product.toLowerCase().includes(w.product.toLowerCase()) && g.qty === w.qty && (!w.colour || g.colour?.toLowerCase() === w.colour.toLowerCase())));
  const work: CheckResult[] = [
    { name: "work-quotes", ok: outcome.quotes.length === e.quotes, detail: `quotes=${outcome.quotes.length}, want ${e.quotes}` },
    ...(e.customer ? [{ name: "work-customer", ok: quote?.customer === e.customer, detail: `got ${quote?.customer ?? "none"}` }] : []),
    ...(e.lines ? [{ name: "work-lines", ok: Boolean(quote) && sameLines(quote.lines, e.lines), detail: JSON.stringify(quote?.lines ?? []) }] : []),
    ...(e.fees ? [{ name: "work-fees", ok: Boolean(quote) && e.fees.every((f) => quote.fees.some((g) => g.label.toLowerCase().includes(f.label.toLowerCase()) && g.amount === f.amount)), detail: JSON.stringify(quote?.fees ?? []) }] : []),
  ];
  checks.push(...work);
  if (e.openSheets !== undefined) checks.push({ name: "open-sheets", ok: outcome.openSheets === e.openSheets, detail: `open=${outcome.openSheets}` });
  const asked = outcome.answers.reduce((n, a) => n + questionsIn(a), 0);
  if (e.maxQuestions !== undefined) checks.push({ name: "unnecessary-questions", ok: asked <= e.maxQuestions, detail: `asked ${asked}, max ${e.maxQuestions}` });
  if (e.mustAsk) checks.push({ name: "asked-first", ok: e.mustAsk.test(outcome.answers[0] ?? ""), detail: "the first answer must ask which one" });
  if (outcome.latencyMs?.length) {
    const slowest = Math.max(...outcome.latencyMs);
    checks.push({ name: "time", ok: slowest <= 90_000, detail: `slowest turn ${Math.round(slowest / 1000)}s` });
  }
  const passed = checks.filter((c) => c.ok).length;
  const score = work.every((c) => c.ok) ? Math.round((passed / checks.length) * 100) : 0;
  return { scenarioId: scenario.id, score, checks };
}
