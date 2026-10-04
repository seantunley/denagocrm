import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MAX_STEPS, conversationBlock, parseStep, planInstructions } from "../src/lib/crmAssistantPlan";
import { DEFAULT_PROFILE, DEFAULT_SOUL, LOCKED_RULES, cleanOwnerText, normaliseSoul, parseProfile, soulText } from "../src/lib/assistantSoul";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("a well-formed step is accepted, even wrapped in a fence or prose", () => {
  assert.deepEqual(parseStep('{"tool":"find_leads","args":{"noContactDays":7,"sort":"value"}}'), {
    tool: "find_leads",
    args: { noContactDays: 7, sort: "value" },
  });
  assert.equal(parseStep('```json\n{"tool":"pipeline_summary"}\n```')?.tool, "pipeline_summary");
  assert.equal(parseStep('Sure: {"tool":"find_activities","args":{"when":"overdue"}}')?.tool, "find_activities");
  assert.deepEqual(parseStep('{"tool":"lead_brief","args":{"lead":"Anna"}}'), { tool: "lead_brief", args: { lead: "Anna" } });
  assert.equal(parseStep('{"tool":"knowledge","args":{"topic":"warranty"}}')?.tool, "knowledge");
  assert.equal(parseStep('{"tool":"recall","args":{"query":"Anna"}}')?.tool, "recall");
  assert.deepEqual(parseStep('{"tool":"done"}'), { tool: "done" });
});

test("anything outside the schema is refused, not guessed at", () => {
  for (const reply of [
    "",
    "I can't help with that",
    "{not json}",
    '{"tool":"run_sql","args":{"query":"DELETE FROM \\"Lead\\""}}', // no such tool
    '{"tool":"find_leads","args":{"where":{"tenantId":"other"}}}', // unknown arg (strict)
    '{"tool":"find_leads","args":{"limit":5000}}', // over the cap
    '{"tool":"find_leads","args":{"status":"everything"}}',
    '{"tool":"find_activities","args":{}}', // `when` is required
    '{"tool":"find_quotes","args":{"minValue":-1}}',
    '{"tool":"lead_brief","args":{}}', // `lead` is required
    '{"tool":"recall","args":{"query":"x","userId":"someone-else"}}', // strict: no reading others' history
  ]) {
    assert.equal(parseStep(reply), null, reply);
  }
});

test("the research prompt names the workspace's real stages, people and today's date", () => {
  const text = planInstructions({
    today: "2026-10-04",
    userName: "Sean",
    stages: ["New", "Quoted"],
    staff: ["Sean", "Donovan"],
    activityTypes: ["call", "meeting"],
  });
  assert.match(text, /Today is 2026-10-04/);
  assert.match(text, /Stages: New, Quoted\./);
  assert.match(text, /People: Sean, Donovan\./);
  assert.match(text, /JSON only/);
  assert.equal(MAX_STEPS, 3);
});

test("follow-ups see the earlier turns, trimmed", () => {
  assert.equal(conversationBlock([]), "");
  const block = conversationBlock([{ question: "Open leads?", answer: "x".repeat(2000) }]);
  assert.match(block, /^Earlier in this conversation:\nQ: Open leads\?\nA: x+$/);
  assert.ok(block.length < 700);
});

test("the personality is the workspace's, with honest-colleague rules underneath", () => {
  assert.deepEqual(parseProfile(null), DEFAULT_PROFILE);
  assert.deepEqual(parseProfile("{broken"), DEFAULT_PROFILE);
  assert.deepEqual(parseProfile('{"name":"Ava","tone":"direct","rules":"Mention the warranty."}'), {
    name: "Ava", tone: "direct", rules: "Mention the warranty.", soul: "",
  });
  assert.deepEqual(parseProfile('{"tone":"sarcastic"}'), DEFAULT_PROFILE, "unknown tone → default, not a crash");
  const soul = soulText({ name: "Ava", tone: "direct", rules: "Mention the warranty.", soul: "" }, "Denago", "Sean");
  assert.match(soul, /You are Ava, the digital assistant inside Denago's CRM, talking with Sean\./);
  assert.ok(soul.includes(DEFAULT_SOUL), "no custom soul → the default");
  assert.match(soul, /Keep FACTS .* apart from ADVICE/);
  assert.match(soul, /Workspace instructions from the business \(follow these\):\nMention the warranty\./);
  // Saved as "rules" before the rename — still read, now with room for a full AGENTS.md.
  assert.equal(parseProfile(JSON.stringify({ rules: "x".repeat(8000) })).rules.length, 8000);
  assert.deepEqual(parseProfile(JSON.stringify({ rules: "x".repeat(8001) })), DEFAULT_PROFILE, "over the limit → refused, not truncated silently");
  assert.equal(cleanOwnerText("Be​ kind.\r\nAlways.", 4000), "Be kind.\nAlways.");
});

test("the owner can rewrite the whole soul — but never the honesty rules", () => {
  const custom = "- Talk like a seasoned dealer principal. Short sentences. Always end with the next move.";
  const soul = soulText({ name: "Ava", tone: "direct", rules: "", soul: custom }, "Denago", "Sean");
  assert.ok(soul.includes(custom));
  assert.ok(!soul.includes(DEFAULT_SOUL), "the custom soul replaces the default");
  assert.ok(soul.includes(LOCKED_RULES), "the locked rules are always there");
  assert.ok(soul.indexOf(LOCKED_RULES) > soul.indexOf(custom), "and come after, so they override it");
  // Untouched box (with the browser's CRLFs) → stored as "", so default improvements still arrive.
  assert.equal(normaliseSoul(DEFAULT_SOUL.replace(/\n/g, "\r\n")), "");
  assert.equal(normaliseSoul("   "), "");
  assert.equal(normaliseSoul(`Be​ blunt.`), "Be blunt.", "invisible characters stripped");
  assert.equal(normaliseSoul("x".repeat(5000)).length, 3000);
});

test("the assistant only reads the CRM, and only through each user's own visibility", () => {
  const lib = code("src/lib/crmAssistant.ts");
  // Its one write is its own conversation history.
  const writes = lib.match(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g) ?? [];
  assert.deepEqual(writes, [".create("]);
  assert.match(lib, /prisma\.assistantTurn\s*\.create\(/);
  assert.doesNotMatch(lib, /\$executeRaw|\$queryRaw|basePrisma/, "no raw SQL, tenant-scoped client only");
  for (const helper of ["getAccessibleLeadIds(user)", "getAccessibleQuoteIds(user)", "getAccessibleActivityIds(user)"]) {
    assert.ok(lib.includes(helper), helper);
  }
  // recall reads only the asker's own turns.
  assert.match(lib.slice(lib.indexOf("async function recall")), /where: \{\s*userId: user\.id,/);
  // Customer data stays out of the error log: no question, row or answer text.
  for (const call of lib.match(/logError\([^)]*\)/g) ?? []) {
    // No question/answer/row VARIABLE passed in (the fixed message text may say "answer step").
    assert.doesNotMatch(call, /[(,]\s*(question|prompt|rows|data|answer|observations|history)\b|\.text\b/, call);
  }
  const action = code("src/app/actions/assistant.ts");
  assert.match(action, /withActingStaffScope\(async \(\) => \{\s*const user = await requireAnyPermission\(/);
  assert.match(action, /if \(!\(await isModuleEnabled\("automation"\)\)\)/);
});

test("history is kept 30 days and no longer", () => {
  assert.match(
    code("src/app/api/cron/automations/route.ts"),
    /assistantTurn\s*\.deleteMany\(\{ where: \{ createdAt: \{ lt: new Date\(Date\.now\(\) - 30 \* 24 \* 60 \* 60 \* 1000\) \} \} \}\)/,
  );
});

test("only the workspace owner sets the personality", () => {
  assert.match(code("src/app/actions/assistantSettings.ts"), /const user = await requireTenantOwner\(\);/);
  assert.match(code("src/app/(app)/settings/assistant/page.tsx"), /await requireTenantOwner\(\);/);
});
