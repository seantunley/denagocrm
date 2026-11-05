import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assistantStep } from "../src/lib/crmAssistantPlan";
import { ALL_SEARCH_GROUPS, SEARCH_GROUPS } from "../src/lib/recordSearch";

/*
 * ONE SEARCH (2026-11-05): the search menu, /search and DAX's search_everything all call lib/crmSearch.ts as the
 * person searching. Source-patterned where it needs the database.
 */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = read("src/lib/crmSearch.ts");

test("all three surfaces ask the one search, as the person searching", () => {
  assert.match(read("src/app/actions/search.ts"), /searchCrm\(user, rawTerm,/);
  assert.match(read("src/app/(app)/search/page.tsx"), /const hits = await searchCrm\(user, term\);/);
  assert.match(read("src/lib/crmAssistant.ts"), /case "search_everything": return searchEverything\(user, step\.args\);/);
  assert.match(read("src/lib/crmAssistant.ts"), /const hits = await searchCrm\(user, args\.words, /);
  // No second copy of the queries left behind on the page.
  assert.doesNotMatch(read("src/app/(app)/search/page.tsx"), /prisma\.|getAccessible/);
});

test("every raw read names the workspace — including cases, which used to match every workspace's", () => {
  assert.match(code, /FROM "CustomerCase" c[\s\S]*?WHERE c\."tenantId" = \$\{tenantId\}/);
  assert.match(code, /FROM "Communication"\s*WHERE "tenantId" = \$\{tenantId\}/);
});

test("messages are found only on deals and customers the person may open, on the full-text index", () => {
  assert.match(code, /"leadId" = ANY\(\$\{leadIds\}::text\[\]\)/);
  assert.match(code, /"contactId" = ANY\(\$\{contactIds\}::text\[\]\)/);
  // The same expression as the index (Communication_search_idx), or Postgres won't use it.
  assert.match(code, /const doc = Prisma\.raw\(COMMUNICATION_SEARCH_DOC\);/);
  assert.match(code, /to_tsvector\('english', \$\{doc\}\) @@ websearch_to_tsquery\('english', \$\{query\}\)/);
});

test("the menu shortlists records and messages; the page lists every kind", () => {
  assert.deepEqual(SEARCH_GROUPS.map((g) => g.type), ["contact", "lead", "quote", "vehicle", "jobcard", "message"]);
  assert.deepEqual(
    ALL_SEARCH_GROUPS.map((g) => g.type).sort(),
    ["activity", "case", "contact", "document", "jobcard", "knowledge", "lead", "message", "product", "quote", "vehicle"],
  );
});

test("DAX's search_everything takes words and optional kinds, nothing else", () => {
  assert.ok(assistantStep.safeParse({ tool: "search_everything", args: { words: "financing" } }).success);
  assert.ok(assistantStep.safeParse({ tool: "search_everything", args: { words: "warranty", kinds: ["message", "case"] } }).success);
  assert.equal(assistantStep.safeParse({ tool: "search_everything", args: { words: "x" } }).success, false, "two letters at least");
  assert.equal(assistantStep.safeParse({ tool: "search_everything", args: { words: "a b", kinds: ["users"] } }).success, false);
  assert.equal(assistantStep.safeParse({ tool: "search_everything", args: { words: "a b", tenantId: "t2" } }).success, false, "no other arguments");
});
