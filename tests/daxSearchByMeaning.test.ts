import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseStep } from "../src/lib/crmAssistantPlan";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/**
 * Sean, 2026-11-13: "Message search matches words and close spellings only. 'Find where she complained about delivery'
 * misses a message that says 'still waiting for my bike'." No embeddings: other wordings, then read-for-meaning.
 * The search itself, against a real database, is scripts/test-assistant-evidence.ts ("by meaning").
 */
test("DAX can pass other wordings with a message search", () => {
  const step = parseStep('{"tool":"search_messages","args":{"customer":"Anna","words":"complaint","alternatives":["still waiting","not arrived"]}}');
  assert.deepEqual(step, { tool: "search_messages", args: { customer: "Anna", words: "complaint", alternatives: ["still waiting", "not arrived"] } });
  assert.equal(parseStep(`{"tool":"search_messages","args":{"customer":"Anna","alternatives":${JSON.stringify(Array(7).fill("x y"))}}}`), null, "at most 6");
  // With wordings the search uses the words AND them, and more stems (16, not 8). (crmAssistantEvidence is server-only.)
  assert.match(src("src/lib/crmAssistantEvidence.ts"), /searchStems\(\[args\.words, \.\.\.\(args\.alternatives \?\? \[\]\)\]\.filter\(Boolean\)\.join\(" "\), args\.alternatives\?\.length \? 16 : 8\)/);
});

test("when the words find little, the latest messages come along to be read for meaning — inside the budget", () => {
  const evidence = src("src/lib/crmAssistantEvidence.ts");
  assert.match(evidence, /stems\.length && page\.length < MEANING_MIN_HITS/);
  assert.match(evidence, /export const MEANING_MIN_HITS = 3;/);
  assert.match(evidence, /export const MEANING_READ = 20;/);
  // The same scope and filters as the search (`filters` — never the stems), in this workspace.
  assert.match(evidence, /WHERE "tenantId" = \$\{tenantId\}\s*AND \$\{Prisma\.join\(filters, " AND "\)\}/);
  assert.match(evidence, /READ FOR MEANING/);
  assert.match(src("src/lib/crmAssistantPlan.ts"), /"alternatives":\["<up to 6 other ways the SAME THING may have been said/);
  // 20 × (200-character excerpt + its date, id and facts) sits inside search_messages' 12 000-character budget.
  assert.match(src("src/lib/crmAssistant.ts"), /search_messages: 12_000/);
});
