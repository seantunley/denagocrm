import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { unsupportedFigures, unsupportedNote } from "../src/lib/assistantVerify";
import { RECHECK_STEPS, RECHECK_TURNS, stepsToRecheck } from "../src/lib/crmAssistantPlan";

// What a quotes lookup returns: formatZAR's en-ZA shape, with its odd spaces.
const quotes = [
  { quote: "Q-1022", customer: "Anna", total: "R 412 000,00", link: "/quotes/a" },
  { quote: "Q-1023", customer: "Ben", total: "R 88 500,50", link: "/quotes/b" },
];

test("figures that are in the results pass, however they're written", () => {
  assert.deepEqual(unsupportedFigures("Anna's Q-1022 is R412,000 and Ben's is R 88 500,50.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("Anna's quote is about R412k; Ben's R88 500.", [quotes]), [], "rounded as written");
  assert.deepEqual(unsupportedFigures("Together R 500 500,50.", [quotes]), [], "a list's column total");
  assert.deepEqual(unsupportedFigures("About R0.5m between them.", [quotes]), []);
});

test("an invented amount or a wrong quote number is flagged", () => {
  assert.deepEqual(unsupportedFigures("Anna's Q-1022 is R 421 000.", [quotes]), ["R 421 000"]);
  assert.deepEqual(unsupportedFigures("Ben signed Q-1099.", [quotes]), ["Q-1099"]);
  assert.deepEqual(unsupportedFigures("It's R2.5m.", [quotes]), ["R2.5m"]);
});

test("what the person said counts; DAX's own judgement isn't checked", () => {
  assert.deepEqual(unsupportedFigures("Within your R50 000 budget: Ben's.", ["Anything under R50 000?", quotes]), []);
  assert.deepEqual(unsupportedFigures("My read: offer R5 000 off to close it.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("No figures here, 3 deals open.", [quotes]), []);
});

test("a figure DAX invented last turn can't vouch for itself this turn (#789 review)", () => {
  // Last turn DAX said Anna's quote was R 421 000 and named Q-1099 — both made up.
  const earlier = [{ question: "What's Anna's quote worth?", answer: "Anna's Q-1099 is R 421 000." }];
  // As crmAssistant builds the evidence: this question, earlier QUESTIONS, the lookups.
  const evidence = ["And Ben's?", ...earlier.map((t) => t.question), quotes];
  assert.deepEqual(unsupportedFigures("Ben's is R 88 500,50; Anna's Q-1099 is R 421 000.", evidence), ["R 421 000", "Q-1099"]);
  // The reviewed bug: with DAX's earlier answer as evidence, the made-up quote number slips through. The amount is
  // still caught since the record-bound check (Phase 2): the sentence is about Anna's quote, and it isn't on it.
  assert.deepEqual(unsupportedFigures("Anna's Q-1099 is R 421 000.", [...evidence, earlier[0].answer]), ["R 421 000 (not on Q-1022)"]);
  // What the person themselves said earlier is still trusted.
  assert.deepEqual(unsupportedFigures("Under your R60 000 limit: Ben's.", ["And Ben's?", "Anything under R60 000?", quotes]), []);
});

test("figures restated from an earlier answer pass when its lookups, run again, still hold them (2026-11-14)", () => {
  // "I want a table here in writing": no lookup this turn, so every amount was flagged.
  const answer = "| Marcel | Rover XXL | R270,000 |\n| Shaun | Rover XL | R235,000 |\n\nTotal: 3 open leads in New, worth R740,000.";
  const evidence = ["I want a table here in writing", "Can you summarize the new open leads?"];
  assert.deepEqual(unsupportedFigures(answer, evidence), ["R270,000", "R235,000", "R740,000"]);
  // The earlier answer's find_leads, run again now: the leads as they stand.
  const leadsNow = [
    { name: "Marcel", value: "R 270 000,00", link: "/leads/m" },
    { name: "Shaun", value: "R 235 000,00", link: "/leads/s" },
    { name: "Amien", value: "R 235 000,00", link: "/leads/a" },
  ];
  assert.deepEqual(unsupportedFigures(answer, [...evidence, leadsNow]), [], "the amounts, and their total");
  // A figure the records no longer hold (or never did) is still flagged.
  assert.deepEqual(unsupportedFigures("Marcel's is R290,000.", [...evidence, leadsNow]), ["R290,000"]);
});

test("which earlier lookups run again: plain CRM reads, each once, newest first, capped", () => {
  const leads = { tool: "find_leads", args: { stage: "New", status: "open", limit: 25, sort: "value" } };
  const earlier = [
    [leads, { tool: "read_document", args: { document: "contract" } }, { tool: "web", args: {} }],
    [leads, { tool: "pipeline_summary", args: {} }, { tool: "nonsense", args: { x: 1 } }, "junk"],
    null,
  ];
  const steps = stepsToRecheck(earlier);
  assert.deepEqual(steps.map((s) => s.tool), ["find_leads", "pipeline_summary"], "no file/picture reads, no internet, no duplicates, nothing invalid");
  const many = [Array.from({ length: 10 }, (_, i) => ({ tool: "find_leads", args: { search: `name${i}` } }))];
  assert.equal(stepsToRecheck(many).length, RECHECK_STEPS);
  assert.ok(RECHECK_TURNS <= 3);
});

test("the note names what to check, and is said once", () => {
  assert.match(unsupportedNote(["R 421 000"]), /R 421 000\. It may be worked out from them, or wrong/);
  assert.match(unsupportedNote(["a", "b", "c", "d", "e", "f"]), /a, b, c, d and 2 more\. They may/);
});

test("every answer goes through the check, and the note is part of what's saved and shown", () => {
  const src = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8");
  // The person's words count as evidence; DAX's earlier answers never do (#789 review).
  // Checked with its citations (reply.answer), so a sentence citing a quote is checked against that quote.
  assert.match(src, /const evidenceNow = \[question, \.\.\.history\.map\(\(t\) => t\.question\), \.\.\.observations\.map\(\(o\) => o\.output\.data\)\];\s*let flagged = unsupportedFigures\(reply\.answer, evidenceNow\);/);
  const call = src.slice(src.indexOf("const evidenceNow = "), src.indexOf("\n", src.indexOf("const evidenceNow = ")));
  assert.doesNotMatch(call, /conversation|\.answer|\.state/, "nothing DAX wrote is evidence");
  // LOOKED UP AGAIN (2026-11-14): only when something is flagged; the earlier answers' LOOKUPS re-run now, as this
  // person — their stored tools, never their answers or working memory.
  assert.match(src, /if \(flagged\.length && history\.length\) \{\s*const again = await earlierLookupsAgain\(user, who\.tenantId, thread\?\.id \?\? null\)/);
  assert.match(src, /if \(again\.length\) flagged = unsupportedFigures\(reply\.answer, \[\.\.\.evidenceNow, \.\.\.again\]\);/);
  const rerun = src.slice(src.indexOf("async function earlierLookupsAgain("), src.indexOf("/** The records each answer listed travel apart"));
  assert.match(rerun, /where: \{ tenantId, userId: user\.id, /);
  assert.match(rerun, /select: \{ tools: true \}/);
  assert.doesNotMatch(rerun, /answer: true|state: true/);
  assert.match(rerun, /runTool\(user, step\)/);
  // The note is still part of both — and when what it said about a task was replaced (settledAnswer), the note stays
  // with the rest of the answer that was kept (its figures are still there), before the task status.
  assert.match(src, /const settledText = settled === null \? null : kept \? `\$\{kept\}\$\{note\}\\n\\n\$\{settled\}` : settled;/);
  assert.match(src, /const cited = \(settledText \?\? resolved\.cited \+ note\) \+ checkBackLine \+ taskLine;\s*const answer = \(settledText \?\? resolved\.plain \+ note\) \+ checkBackLine \+ taskLine;/);
  const plan = readFileSync(new URL("../src/lib/crmAssistantPlan.ts", import.meta.url), "utf8");
  assert.match(plan, /with \\"My read:\\"/);
  assert.match(plan, /with \\"Not in the CRM:\\"/);
});
