import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseStep, lookupStatus } from "../src/lib/crmAssistantPlan";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/**
 * Sean's 06:00 schedule: "Which notes were added to lead records yesterday? Summarise them by lead and identify who
 * added each note." No lookup could list notes across the CRM, so the answer changed every morning (2026-11-13:
 * "the results don't show lead-note records or who added them").
 */
test("DAX can ask for the notes added on a day, by a colleague, over a period", () => {
  assert.deepEqual(parseStep('{"tool":"notes","args":{"from":"2026-11-12"}}'), { tool: "notes", args: { from: "2026-11-12" } });
  assert.deepEqual(parseStep('{"tool":"notes","args":{"from":"2026-11-09","to":"2026-11-13","by":"Donovan"}}'), {
    tool: "notes", args: { from: "2026-11-09", to: "2026-11-13", by: "Donovan" },
  });
  assert.equal(parseStep('{"tool":"notes","args":{}}'), null, "a day is required");
  assert.equal(parseStep('{"tool":"notes","args":{"from":"2026-11-12","userId":"x"}}'), null, "strict: nothing else");
  assert.equal(lookupStatus([{ tool: "notes" }]), "Reading the notes added…");
  const plan = src("src/lib/crmAssistantPlan.ts");
  assert.match(plan, /'- notes: \{"from":"YYYY-MM-DD" \(required\)/, "described to DAX");
  assert.match(src("src/lib/crmAssistant.ts"), /case "notes": return notesLookup\(user, step\.args\);/);
});

test("only notes this person may see — this workspace, deals and customers they can open", () => {
  const lookup = src("src/lib/assistantNotesLookup.ts");
  assert.match(lookup, /tenantId: ownedWriteTenantId\(\),/, "the workspace is named in the query");
  assert.match(lookup, /type: "note",/);
  assert.match(lookup, /createdAt: \{ gte: start, lt: end \}/, "ADDED in the period — not when the note says it happened");
  assert.match(lookup, /getAccessibleLeadIds\(user\), getAccessibleContactIds\(user\)/);
  assert.match(lookup, /\{ leadId: \{ in: leadIds \} \}/, "a deal note: a deal they can open");
  assert.match(lookup, /\{ leadId: null, contactId: \{ in: contactIds \} \}/, "a customer note: a customer they can open");
  assert.match(lookup, /by: n\.user\?\.name/, "who added it");
  assert.doesNotMatch(lookup, /logError|console\./, "no customer words in logs");
});
