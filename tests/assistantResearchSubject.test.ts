import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { missingEvidence, peopleInResult, requestedPeople, researchSubject } from "../src/lib/assistantResearchGate";
import { RESEARCH_SUBJECT_SCENARIOS } from "./fixtures/researchSubjectScenarios";
import { misrouted } from "./fixtures/scoreResearchSubject";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("research follows the question's subject: every scenario routes right (before: 20/34; 42 with the review's cases)", () => {
  const { total, wrong } = misrouted();
  assert.equal(total, 42);
  assert.deepEqual(wrong, []);
});

test("a comparison of named people needs THOSE people's figures, same period (review of #1121)", () => {
  const staff = ["Donovan Hodgman", "Kristina Botha", "Sean Tunley"];
  const question = "Compare Donovan's and Kristina's pipelines this month";
  // The review's two reproductions: both used to return null (enough evidence).
  assert.match(missingEvidence(question, ["sales_stats"], [{ tool: "sales_stats", args: { period: "this_month" } }], staff) ?? "", /donovan hodgman and kristina botha over the same period/);
  assert.notEqual(missingEvidence(question, ["sales_stats", "sales_stats"], [
    { tool: "sales_stats", args: { assignedTo: "Donovan", period: "this_month" } },
    { tool: "sales_stats", args: { assignedTo: "Donovan", period: "last_month" } },
  ], staff), null);
  // Both of them, same period — by their own lookups or the team breakdown that lists them.
  assert.equal(missingEvidence(question, ["sales_stats", "sales_stats"], [
    { tool: "sales_stats", args: { assignedTo: "Donovan", period: "this_month" } },
    { tool: "sales_stats", args: { assignedTo: "Kristina", period: "this_month" } },
  ], staff), null);
  assert.equal(missingEvidence(question, ["sales_stats"], [{ tool: "sales_stats", args: { period: "this_month" }, people: ["Kristina Botha", "Donovan Hodgman"] }], staff), null);
  // A shared first name is not a match for either; a full name is.
  assert.deepEqual(requestedPeople("Compare Sean and Kristina", ["Sean Tunley", "Sean Smith", "Kristina Botha"]), ["kristina botha"]);
  assert.deepEqual(requestedPeople("Compare Sean Smith and Kristina", ["Sean Tunley", "Sean Smith", "Kristina Botha"]), ["sean smith", "kristina botha"]);
  // The names the team result listed reach the gate.
  assert.deepEqual(peopleInResult("sales_stats", [{ salespeople: [{ person: "Donovan Hodgman" }, { person: "Kristina Botha" }] }]), ["Donovan Hodgman", "Kristina Botha"]);
  assert.equal(peopleInResult("find_leads", [{}]), undefined);
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
  assert.match(lib, /researchGate\(\{\s*question,\s*tools: observations\.map\(\(o\) => o\.tool\),\s*steps: gateSteps\(\),\s*staff: staffNames,/);
  assert.match(lib, /const gateSteps = \(\) => observations\.map\(\(o\) => \(\{ tool: o\.tool, args: o\.args, people: peopleInResult\(o\.tool, o\.output\.data\) \}\)\);/);
  // The staff names are read only for a comparison.
  assert.match(lib, /const staffNames = research && isComparison\(question\) \? \(await listActingTenantStaff\(\)\.catch\(\(\) => \[\]\)\)\.map\(\(s\) => s\.name\) : \[\];/);
  assert.match(lib, /const evidenceGap = observations\.length\s*\? missingEvidence\(question, observations\.map\(\(o\) => o\.tool\), gateSteps\(\), staffNames\)/);
  assert.match(lib, /evidenceGap \? `Not checked: \$\{evidenceGap\}\./);
  assert.match(code("src/lib/crmAssistantPlan.ts"), /Research what the question is ABOUT, not its wording: comparing PRODUCTS/);
});
