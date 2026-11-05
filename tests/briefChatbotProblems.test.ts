import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { briefQuestion, chatbotProblemsFact, chatbotProblemsOn } from "../src/lib/proactiveRules";

test("the brief states how many chatbot steps failed and the commonest reasons", () => {
  const fact = chatbotProblemsFact(3, [
    { message: "The customer has no open deal", n: 2 },
    { message: "API returned 503", n: 1 },
  ]);
  assert.equal(fact, "The chatbot had 3 failed steps in the last 24 hours — most often “The customer has no open deal” (×2), “API returned 503” (×1). The details are in Settings → System Log.");
  assert.equal(chatbotProblemsFact(0, []), null, "nothing failed, nothing is said");
  // Review of #999: the total was the length of a 500-row read, so a big outage was understated.
  assert.match(chatbotProblemsFact(1200, [{ message: "API returned 503", n: 1100 }])!, /had 1200 failed steps/);
  const now = new Date("2026-11-05T05:30:00Z");
  assert.match(briefQuestion(now, [], { chatbotProblems: fact }), /Add a one-line Chatbot part at the end, stating exactly this: The chatbot had 3 failed steps/);
  assert.doesNotMatch(briefQuestion(now, [], {}), /Chatbot part/);
});

test("on until the owner switches it off", () => {
  assert.equal(chatbotProblemsOn(null), true);
  assert.equal(chatbotProblemsOn("on"), true);
  assert.equal(chatbotProblemsOn("off"), false);
});

test("only the workspace owner's brief reads the System Log, and only the chatbot's own entries", () => {
  const brief = readFileSync("src/lib/proactiveBrief.ts", "utf8");
  const reader = brief.slice(brief.indexOf("async function chatbotProblemsFor"), brief.indexOf("async function writeBrief"));
  assert.match(reader, /ownerUserId === user\.id/);
  assert.match(reader, /if \(!owner \|\| !chatbotProblemsOn/);
  assert.match(reader, /const where = \{ tenantId, scope: "chatbot-step"/);
  assert.match(reader, /basePrisma\.errorLog\.count\(\{ where \}\)/);
  assert.doesNotMatch(reader, /take: 500/);
  // The switch is offered to the owner only — everyone else gets null and no checkbox.
  assert.match(readFileSync("src/app/(app)/assistant/page.tsx", "utf8"), /isTenantOwner\(\)\.then\(async \(owner\) => \(owner \? chatbotProblemsOn/);
});
