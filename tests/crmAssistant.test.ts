import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parsePlan, planInstructions } from "../src/lib/crmAssistantPlan";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("a well-formed tool call is accepted, even wrapped in a fence or prose", () => {
  assert.deepEqual(parsePlan('{"tool":"find_leads","args":{"noContactDays":7,"sort":"value"}}'), {
    tool: "find_leads",
    args: { noContactDays: 7, sort: "value" },
  });
  assert.equal(parsePlan('```json\n{"tool":"pipeline_summary"}\n```')?.tool, "pipeline_summary");
  assert.equal(parsePlan('Sure: {"tool":"find_activities","args":{"when":"overdue"}}')?.tool, "find_activities");
  assert.deepEqual(parsePlan('{"tool":"none","reply":"Hi!"}'), { tool: "none", reply: "Hi!" });
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
  ]) {
    assert.equal(parsePlan(reply), null, reply);
  }
});

test("the plan prompt names the workspace's real stages, people and today's date", () => {
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
});

test("the assistant only reads, and only through each user's own visibility", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.doesNotMatch(lib, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/, "read-only, no raw SQL");
  assert.doesNotMatch(lib, /basePrisma/, "the tenant-scoped client only");
  for (const helper of ["getAccessibleLeadIds(user)", "getAccessibleQuoteIds(user)", "getAccessibleActivityIds(user)"]) {
    assert.ok(lib.includes(helper), helper);
  }
  // Customer data stays out of the error log: no question, row or answer text.
  for (const call of lib.match(/logError\([^)]*\)/g) ?? []) {
    assert.doesNotMatch(call, /question|prompt|rows|data|text\b/, call);
  }
  const action = code("src/app/actions/assistant.ts");
  assert.match(action, /withActingStaffScope\(async \(\) => \{\s*const user = await requireAnyPermission\(/);
  assert.match(action, /if \(!\(await isModuleEnabled\("automation"\)\)\)/);
});
