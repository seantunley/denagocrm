import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gapKey, isKnowledgeGap, parseDraft, scrubQuestion, withExample } from "../src/lib/knowledgeGapRules";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("only a question the chatbot couldn't answer from knowledge is a gap", () => {
  assert.equal(isKnowledgeGap({ faqId: null, confidence: "low", intent: "service" }), true);
  assert.equal(isKnowledgeGap({ faqId: null, confidence: "medium", intent: "unknown" }), true);
  assert.equal(isKnowledgeGap({ faqId: "faq_1", confidence: "low", intent: "service" }), false, "an FAQ answered it");
  assert.equal(isKnowledgeGap({ faqId: null, confidence: "high", intent: "general" }), false, "it answered");
  for (const intent of ["purchase", "demo", "complaint", "human"]) {
    assert.equal(isKnowledgeGap({ faqId: null, confidence: "low", intent }), false, `${intent} is handed over for its own reason`);
  }
});

test("the same question asked differently is one gap, and who asked it isn't kept", () => {
  assert.equal(gapKey("Do you deliver to Joburg?"), gapKey("deliver to joburg??"));
  assert.equal(gapKey("Do you deliver to Joburg?"), gapKey("Do you do deliveries to Joburg"));
  assert.notEqual(gapKey("Do you deliver to Joburg?"), gapKey("Do you deliver to Durban?"));
  assert.equal(gapKey("hi?"), "", "nothing to go on");
  assert.equal(scrubQuestion("Call me on 082 555 1234 or sean@example.co.za about finance"), "Call me on [number] or [email] about finance");
  assert.deepEqual(withExample(["b", "a"], "a"), ["a", "b"], "newest first, no repeats");
  assert.equal(withExample(["1", "2", "3", "4", "5"], "6").length, 5);
});

test("a draft needs a title and an answer; anything else is no draft", () => {
  assert.deepEqual(parseDraft('Here: {"title":"Delivery areas","content":"We deliver nationwide.","check":"Confirm the delivery fee"}'), {
    title: "Delivery areas", content: "We deliver nationwide.", check: "Confirm the delivery fee",
  });
  assert.equal(parseDraft('{"title":"","content":"x"}'), null);
  assert.equal(parseDraft("no json"), null);
});

test("DAX's answer is filed as a DRAFT the chatbot can't use until the owner approves it", () => {
  const lib = read("src/lib/knowledgeGaps.ts");
  assert.match(lib, /botKnowledgeEntry\.create\(\{\s*data: \{\s*tenantId,\s*title: draft\.title,\s*content: draft\.content,\s*status: "draft",/);
  assert.doesNotMatch(lib, /status: "approved"/);
  // Only knowledge the business already has, and what staff said — never invented.
  assert.match(read("src/lib/knowledgeGapRules.ts"), /Never invent prices, dates, stock, warranty or finance terms/);
  const actions = read("src/app/actions/knowledgeGaps.ts");
  assert.equal((actions.match(/const owner = await requireTenantOwner\(\);/g) ?? []).length, 2, "owner only, like every knowledge change");
});

test("the chatbot records a gap without ever failing its reply, in its own workspace", () => {
  const bot = read("src/lib/botAi.ts");
  assert.match(bot, /if \(isKnowledgeGap\(parsed\)\) \{[\s\S]*?await recordKnowledgeGap\(latestQuestion, parsed\.intent\)\.catch\(\(\) => \{\}\);/);
  const lib = read("src/lib/knowledgeGaps.ts");
  assert.match(lib, /const tenantId = currentTenantScope\(\)\?\.tenantId;[\s\S]*?if \(!tenantId \|\| !key \|\| !wording\) return;/);
  assert.match(read("prisma/migrations/20261105180000_knowledge_gaps/migration.sql"), /ALTER TABLE "KnowledgeGap" FORCE ROW LEVEL SECURITY;/);
});
