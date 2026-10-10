import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { researchGate } from "../src/lib/assistantResearchGate";
import { formatDecision, matchDecisions, parseDecision } from "../src/lib/assistantDecisions";
import { costSummary, runLive, scoreRecorded } from "../evals/runResearchEval";

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
  const raw = formatDecision({ kind: "topic", subject: "pricing", text: "Hold the October promo", at: "2026-10-01T00:00:00Z" });
  const parsed = parseDecision(raw, "2026-10-01T00:00:00Z");
  assert.ok(parsed);
  assert.equal(parsed.subject, "pricing");
  const hits = matchDecisions(
    [parsed, { kind: "topic", subject: "other", text: "unrelated", at: "2026-10-01T00:00:00Z" }],
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


test("live runner scores answers from an ask function", async () => {
  const scores = await runLive(async (question) => ({
    tools: question.toLowerCase().includes("why") ? ["find_leads", "lead_brief"] : ["find_leads"],
    steps: 2,
    answer: question,
  }));
  assert.equal(scores.length, 5);
  assert.ok(scores.every((s) => s.score >= 0));
});


test("a two-person comparison needs evidence for both sides", () => {
  const one = researchGate({
    question: "Compare Donovan and Kristina's pipelines",
    tools: ["find_leads"],
    lastRoundEmpty: false,
    planSaysAnswer: true,
    stepsUsed: 1,
    maxSteps: 6,
  });
  assert.equal(one, "continue", "one find_leads is not enough for two people");
  const both = researchGate({
    question: "Compare Donovan and Kristina's pipelines",
    tools: ["find_leads", "find_leads"],
    lastRoundEmpty: false,
    planSaysAnswer: true,
    stepsUsed: 2,
    maxSteps: 6,
  });
  assert.equal(both, "answer");
});

test("decision recall checks lead access and save is unreviewed", () => {
  const lib = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../src/lib/assistantMemoryStore.ts", import.meta.url), "utf8");
  assert.match(lib, /canAccessLead\(user, d\.subject\)/, "recall filters by lead visibility");
  assert.match(lib, /visibleTo\(user\.id\)/, "unreviewed notes from others are excluded");
  assert.match(lib, /d\.kind === "lead"/, "lead check uses explicit kind, not a string heuristic");
  assert.match(store, /status: "unreviewed"/, "decisions are not auto-approved");
  assert.match(store, /createdById: userId/, "author is recorded");
});


test("cost summary reports latency and tokens", () => {
  const summary = costSummary([
    { latencyMs: 1000, tokens: 200 },
    { latencyMs: 3000, tokens: 400 },
  ]);
  assert.equal(summary.avgLatencyMs, 2000);
  assert.equal(summary.totalTokens, 600);
  assert.equal(summary.scenarios, 2);
});


test("decision search keeps visibility and keywords under AND", () => {
  const lib = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8");
  const recall = lib.slice(lib.indexOf("async function recallDecision"), lib.indexOf("async function runTool"));
  // Visibility OR and keyword OR must both survive — AND, not a second top-level OR.
  assert.match(recall, /AND:\s*\[\s*visibleTo\(user\.id\)/, "visibility is inside AND");
  assert.match(recall, /OR: words\.map/, "keyword match is present");
  assert.doesNotMatch(recall, /\.\.\.visibleTo\(user\.id\),\s*\.\.\.\(words/, "visibility is not spread beside a keyword OR");
});
