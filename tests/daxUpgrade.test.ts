import assert from "node:assert/strict";
import { test } from "node:test";
import { researchGate } from "../src/lib/assistantResearchGate";
import { formatDecision, matchDecisions, parseDecision } from "../src/lib/assistantDecisions";
import { scoreRecorded } from "../evals/runResearchEval";

test("gate continues when a why-question has no lead_brief yet", () => {
  const d = researchGate({
    question: "Why is the Jacobs deal stuck?",
    tools: ["find_leads"],
    lastRoundEmpty: false,
    planSaysAnswer: true,
    stepsUsed: 1,
    maxSteps: 6,
  });
  assert.equal(d, "continue");
});

test("gate answers when the plan says so and evidence is present", () => {
  const d = researchGate({
    question: "Why is the Jacobs deal stuck?",
    tools: ["find_leads", "lead_brief"],
    lastRoundEmpty: false,
    planSaysAnswer: true,
    stepsUsed: 2,
    maxSteps: 6,
  });
  assert.equal(d, "answer");
});

test("gate stops on empty results or step cap", () => {
  assert.equal(
    researchGate({ question: "how many", tools: ["find_leads"], lastRoundEmpty: true, planSaysAnswer: false, stepsUsed: 1, maxSteps: 3 }),
    "answer",
  );
  assert.equal(
    researchGate({ question: "why", tools: [], lastRoundEmpty: false, planSaysAnswer: false, stepsUsed: 6, maxSteps: 6 }),
    "answer",
  );
});

test("decision round-trip and match", () => {
  const raw = formatDecision({ subject: "pricing", text: "Hold the October promo", at: "2026-10-01T00:00:00Z" });
  const parsed = parseDecision(raw, "2026-10-01T00:00:00Z");
  assert.ok(parsed);
  assert.equal(parsed.subject, "pricing");
  const hits = matchDecisions(
    [parsed, { subject: "other", text: "unrelated", at: "2026-10-01T00:00:00Z" }],
    "october promo",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].subject, "pricing");
});

test("eval runner scores a recorded trace", () => {
  const scores = scoreRecorded([
    {
      scenarioId: "why-stuck",
      question: "Why is the Jacobs deal stuck and what should we do to close it?",
      tools: ["find_leads", "lead_brief"],
      steps: 2,
      hitBudget: false,
      answer: "The Jacobs deal has been quiet. Suggest a follow-up.",
    },
  ]);
  assert.equal(scores.length, 1);
  assert.ok(scores[0].score >= 80);
});
