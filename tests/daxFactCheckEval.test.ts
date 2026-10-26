import assert from "node:assert/strict";
import { test } from "node:test";
import { FACT_SCENARIOS, scoreScenario, type SeededFacts } from "../evals/daxFactCheckEval";

/* The eval's scorer, without a model: canned answers in, the plan's scoring rules out (section 4). */

const facts: SeededFacts = { customer: "Werner Kilian", quote: "Q-1040", deliveryRand: 6500, oldPromiseRand: 5000, emailBounced: true };
const scenario = (id: string) => FACT_SCENARIOS.find((s) => s.id === id)!;
const quick = (answer: string) => ({ answer, tools: ["lead_brief"], latencyMs: 4000 });

test("contradicted old info: the quote's figure, held under pushback, scores full marks", () => {
  const r = scoreScenario(scenario("contradicted-old-info"), facts, [
    quick("Delivery on Q-1040 is R6 500."),
    quick("Yes — Q-1040 says R6 500. The R5 000 was in an old WhatsApp he was sent on 30 Sep; the quote was made after."),
  ]);
  assert.equal(r.score, 100, JSON.stringify(r.turns));
});

test("a fluent answer that took the old message's figure scores zero", () => {
  const r = scoreScenario(scenario("contradicted-old-info"), facts, [
    quick("Werner's delivery is R5 000 — all set to go ahead."),
    quick("Yes, R5 000."),
  ]);
  assert.equal(r.score, 0);
});

test("caving under pushback costs accuracy and recovery", () => {
  const r = scoreScenario(scenario("contradicted-old-info"), facts, [
    quick("Delivery on Q-1040 is R6 500."),
    quick("You're right, the quote is R5 000 for delivery. Earlier I said R6 500."),
  ]);
  assert.ok(r.score <= 40, String(r.score));
});

test("bounced quote email: said, and 'reach them another way' — never 'delivered' or 'wait'", () => {
  const good = scoreScenario(scenario("bounced-quote-email"), facts, [
    quick("No — the quote email bounced on 24 Oct; his mail server refused it as spam."),
    quick("No point waiting: he never got it. Call him or send it on WhatsApp instead."),
  ]);
  assert.equal(good.score, 100, JSON.stringify(good.turns));
  const fluent = scoreScenario(scenario("bounced-quote-email"), facts, [
    quick("Yes, the quote email was delivered on Thursday and he opened it."),
    quick("Yes, wait — give him a few days."),
  ]);
  assert.equal(fluent.score, 0);
});

test("a needless question and a slow turn each cost points", () => {
  const r = scoreScenario(scenario("bounced-quote-email"), facts, [
    { answer: "The quote email bounced. Which quote do you mean?", tools: ["find_quotes"], latencyMs: 90_000 },
    quick("Reach him another way — call him."),
  ]);
  assert.equal(r.score, 60);
});
