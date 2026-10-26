import assert from "node:assert/strict";
import { test } from "node:test";
import { EVIDENCE_SCENARIOS, asksThePerson, reachedKeys, scoreScenario } from "../evals/daxEvidence";

const scenario = (id: string) => EVIDENCE_SCENARIOS.find((s) => s.id === id)!;

test("the plan's evidence scenarios are all there, each turn needing its evidence", () => {
  for (const id of ["promise-vs-quote", "contradicted-old-info", "contract-page", "scanned-pdf", "bounced-email"]) assert.ok(scenario(id), id);
  assert.equal(scenario("promise-vs-quote").turns.length, 2, "multi-turn: the follow-up leans on the first answer");
});

test("a right answer that reached the evidence scores 100", () => {
  const s = scoreScenario(scenario("promise-vs-quote"), [
    { tools: ["search_messages"], reached: ["promise"], answer: "On 16 September Donovan told Hendrik on WhatsApp: delivery to Paarl for R5,000.", ms: 9000 },
    { tools: ["find_quotes"], reached: ["quote"], answer: "No — the quote has a delivery fee of R6,500, not the R5,000 promised on WhatsApp.", ms: 8000 },
  ]);
  assert.equal(s.score, 100, JSON.stringify(s.checks.filter((c) => !c.ok)));
});

test("a fluent answer that never reached the evidence fails work completed AND accuracy", () => {
  const s = scoreScenario(scenario("contract-page"), [
    { tools: ["documents"], reached: [], answer: "The agreement says the delivery fee is R6,500, on page 2.", ms: 5000 },
  ]);
  const by = Object.fromEntries(s.checks.map((c) => [c.name, c.ok]));
  assert.equal(by["turn 1: work completed"], false);
  assert.equal(by["turn 1: factual accuracy"], false, "right words without the lookup are a guess");
});

test("the old figure stated as current, an email called delivered, invented scan text — each fails", () => {
  const old = scoreScenario(scenario("contradicted-old-info"), [
    { tools: ["search_messages", "lead_brief"], reached: ["promise", "quote"], answer: "Delivery is R5,000.", ms: 5000 },
  ]);
  assert.ok(old.checks.some((c) => c.name.endsWith("factual accuracy") && !c.ok));
  const bounce = scoreScenario(scenario("bounced-email"), [
    { tools: ["search_messages"], reached: ["bounced"], answer: "Yes, it was delivered on 23 October.", ms: 5000 },
  ]);
  assert.ok(bounce.checks.some((c) => c.name.endsWith("factual accuracy") && !c.ok));
  const scan = scoreScenario(scenario("scanned-pdf"), [
    { tools: ["read_document"], reached: [], answer: "The scan shows ID number 8001015009087.", ms: 5000 },
  ]);
  assert.ok(scan.checks.some((c) => c.name.endsWith("factual accuracy") && !c.ok));
  assert.ok(scan.checks.some((c) => c.name.endsWith("recovery") && !c.ok));
});

test("time and unnecessary questions count", () => {
  const s = scoreScenario(scenario("contract-page"), [
    { tools: ["read_document"], reached: ["contract"], answer: "Which agreement do you mean?\nThe fee is R6,500 on page 2.", ms: 90_000 },
  ]);
  const by = Object.fromEntries(s.checks.map((c) => [c.name, c.ok]));
  assert.equal(by["turn 1: no unnecessary questions"], false);
  assert.equal(by["turn 1: time"], false);
  assert.equal(asksThePerson("The fee is R6,500.\nWant me to draft a reply?"), false, "a closing offer is not a question back");
});

test("reached = the seeded ids found in what the lookups returned", () => {
  assert.deepEqual(reachedKeys([{ messages: [{ id: "cAAA" }] }, { link: "/quotes/cBBB" }], { promise: "cAAA", quote: "cBBB", scan: "cCCC" }), ["promise", "quote"]);
});
