import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { missingEvidence, researchSubject } from "../src/lib/assistantResearchGate";
import { RESEARCH_SUBJECT_SCENARIOS } from "./fixtures/researchSubjectScenarios";
import { misrouted } from "./fixtures/scoreResearchSubject";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("research follows the question's subject: every scenario routes right (before: 20/34)", () => {
  const { total, wrong } = misrouted();
  assert.equal(total, 34);
  assert.deepEqual(wrong, []);
});

test("each scenario's subject is recognised", () => {
  for (const s of RESEARCH_SUBJECT_SCENARIOS) assert.equal(researchSubject(s.question), s.subject, s.question);
  // Sales words outrank the rest; a "why" never becomes a product question.
  assert.equal(researchSubject("Why did sales drop after the delivery delays?"), "people");
  assert.equal(researchSubject("Why is the Rover XL quote stuck?"), "deal");
});

test("what's missing is said in plain words, and nothing for an ordinary question", () => {
  assert.match(missingEvidence("Why is Anna's delivery late?", ["deliveries"]) ?? "", /history/);
  assert.match(missingEvidence("Compare Donovan's and Kristina's pipelines this month", ["sales_stats", "sales_stats"], [
    { tool: "sales_stats", args: { period: "this_month", assignedTo: "Donovan" } },
    { tool: "sales_stats", args: { period: "last_month", assignedTo: "Kristina" } },
  ]) ?? "", /same period/);
  assert.equal(missingEvidence("How many leads came in today?", []), null);
});

test("the loop gives the gate each lookup's arguments, and the answer is told what wasn't checked", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /researchGate\(\{\s*question,\s*tools: observations\.map\(\(o\) => o\.tool\),\s*steps: observations\.map\(\(o\) => \(\{ tool: o\.tool, args: o\.args \}\)\),/);
  assert.match(lib, /const evidenceGap = observations\.length\s*\? missingEvidence\(question,/);
  assert.match(lib, /evidenceGap \? `Not checked: \$\{evidenceGap\}\./);
  assert.match(code("src/lib/crmAssistantPlan.ts"), /Research what the question is ABOUT, not its wording: comparing PRODUCTS/);
});
