import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESEARCH_SCENARIOS,
  formatReport,
  meanScore,
  scoreTrace,
  type ResearchTrace,
} from "../evals/daxResearchQuality";
import { isComplexQuestion } from "../src/lib/crmAssistantPlan";

function trace(over: Partial<ResearchTrace> & Pick<ResearchTrace, "question" | "tools" | "answer">): ResearchTrace {
  return { steps: 2, hitBudget: false, ...over };
}

test("scenario complex flags match isComplexQuestion", () => {
  for (const s of RESEARCH_SCENARIOS) {
    assert.equal(isComplexQuestion(s.question), s.complex, s.id);
  }
});

test("a good why-stuck trace scores high", () => {
  const scenario = RESEARCH_SCENARIOS.find((s) => s.id === "why-stuck")!;
  const good = trace({
    question: scenario.question,
    tools: ["find_leads", "lead_brief", "find_activities"],
    steps: 3,
    answer: "The Jacobs deal has been quiet for 12 days. Last quote was opened but not signed. Suggest a follow-up call.",
  });
  const result = scoreTrace(scenario, good);
  assert.ok(result.score >= 90, formatReport([result]));
  assert.ok(result.checks.every((c) => c.ok), JSON.stringify(result.checks.filter((c) => !c.ok)));
});

test("a shallow why-stuck trace is penalised", () => {
  const scenario = RESEARCH_SCENARIOS.find((s) => s.id === "why-stuck")!;
  const shallow = trace({
    question: scenario.question,
    tools: ["find_leads"],
    steps: 1,
    answer: "I don't know why the Jacobs deal is stuck.",
  });
  const result = scoreTrace(scenario, shallow);
  assert.ok(result.score < 70, `expected low score, got ${result.score}`);
  const names = result.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(names.includes("required-tools"));
  assert.ok(names.includes("min-steps"));
  assert.ok(names.includes("answer-excludes"));
});

test("simple count that over-investigates is penalised", () => {
  const scenario = RESEARCH_SCENARIOS.find((s) => s.id === "simple-count")!;
  const wasteful = trace({
    question: scenario.question,
    tools: ["find_leads", "lead_brief", "web"],
    steps: 4,
    answer: "There were 14 leads.",
  });
  const result = scoreTrace(scenario, wasteful);
  const names = result.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(names.includes("forbidden-tools"));
  assert.ok(names.includes("max-steps"));
});

test("compare-reps accepts parallel find_leads", () => {
  const scenario = RESEARCH_SCENARIOS.find((s) => s.id === "compare-reps")!;
  const good = trace({
    question: scenario.question,
    tools: ["find_leads", "find_leads"],
    steps: 1,
    answer: "Donovan has R420k open; Kristina has R180k and 3 overdue. Kristina needs help.",
  });
  const result = scoreTrace(scenario, good);
  assert.ok(result.score >= 90, formatReport([result]));
});

test("short why requires sales_stats", () => {
  const scenario = RESEARCH_SCENARIOS.find((s) => s.id === "short-why")!;
  const bad = trace({
    question: scenario.question,
    tools: ["find_leads"],
    steps: 1,
    answer: "Sales are down.",
  });
  const result = scoreTrace(scenario, bad);
  assert.ok(result.checks.some((c) => c.name === "required-tools" && !c.ok));
});

test("meanScore and report are stable", () => {
  const scores = RESEARCH_SCENARIOS.map((s) =>
    scoreTrace(
      s,
      trace({
        question: s.question,
        tools: s.requiredTools,
        steps: s.minSteps ?? 1,
        answer: (s.answerMustInclude ?? []).join(" "),
      }),
    ),
  );
  const mean = meanScore(scores);
  assert.ok(mean >= 70, formatReport(scores));
  const report = formatReport(scores);
  assert.match(report, /DAX research quality:/);
});
