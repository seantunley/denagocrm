import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { customFieldsArgs, parseSteps } from "../src/lib/crmAssistantPlan";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("custom_fields: a record type, a field and words of its value", () => {
  assert.equal(customFieldsArgs.safeParse({ record: "lead", field: "Expo", value: "Paarl" }).success, true);
  assert.equal(customFieldsArgs.safeParse({ record: "lead" }).success, true, "no field: list the fields");
  assert.equal(customFieldsArgs.safeParse({ record: "product" }).success, false, "products and stock have no per-record access rule");
  assert.equal(customFieldsArgs.safeParse({ record: "lead", tenantId: "x" }).success, false, "strict");
  assert.equal(customFieldsArgs.parse({ record: "quote", limit: 900 }).limit, 50);
  assert.deepEqual(parseSteps('{"tool":"custom_fields","args":{"record":"contact","field":"Finance house"}}'), [{ tool: "custom_fields", args: { record: "contact", field: "Finance house" } }]);
});

test("permission based: the record type's own access list, ANDed; the workspace named; the page's own visibility", () => {
  const lookup = src("src/lib/assistantCustomFieldsLookup.ts");
  for (const fn of ["getAccessibleLeadIds", "getAccessibleContactIds", "getAccessibleQuoteIds", "getAccessibleCaseIds", "getAccessibleVehicleIds", "getAccessibleJobCardIds"]) {
    assert.match(lookup, new RegExp(`ids: ${fn},`), fn);
  }
  assert.match(lookup, /case: \{ ids: getAccessibleCaseIds, module: "support"/);
  assert.match(lookup, /vehicle: \{ ids: getAccessibleVehicleIds, module: "automotive"/);
  assert.match(lookup, /AND: \[\.\.\.\(allowed === null \? \[\] : \[\{ recordId: \{ in: allowed \} \}\]\), \{ value: \{ not: null \} \}, \.\.\.valueWhere\]/);
  // Review of #1105: the right to read the record type is checked BEFORE any definition is read or listed.
  const body = lookup.slice(lookup.indexOf("export async function customFieldsLookup("));
  const gate = body.indexOf("if (!(await hasAnyPermission(user, ...record.view))) return note(`You don't have access to ${record.name}.`);");
  assert.ok(gate > 0 && gate < body.indexOf("getFieldDefs("), "permission before the definitions");
  assert.ok(gate < body.indexOf("{ fields }"), "permission before any reply that lists fields");
  // Bounded: at most SCAN_MAX values read; past that the total is "at least" and the result says it is partial.
  assert.match(body, /take: SCAN_MAX \+ 1,/);
  assert.match(body, /total: capped \? `at least \$\{live\.length\}` : live\.length,/);
  // Every value read names the workspace; only ACTIVE definitions (getFieldDefs' default); "Show only when" applied.
  assert.equal((lookup.match(/prisma\.customFieldValue\.findMany\(\{\s*where: \{\s*tenantId,/g) ?? []).length, 3);
  assert.match(lookup, /getFieldDefs\(entity, \{ tenantId \}\)/);
  assert.doesNotMatch(lookup, /includeInactive/);
  assert.equal((lookup.match(/isFieldShown\(/g) ?? []).length, 2);
});

test("lookup rows that ARE records carry their custom fields; a failure leaves the answer alone", () => {
  const dax = src("src/lib/crmAssistant.ts");
  assert.match(dax, /if \(CUSTOM_FIELD_TOOLS\.has\(s\.tool\)\) \{\s*await withCustomFields\(user, out\.data\)\.catch\(async \(error: unknown\) => \{\s*await logError\("crm-assistant", "custom fields read failed", error instanceof Error \? error\.name : "unknown"\);/);
  assert.match(dax, /case "custom_fields": return customFieldsLookup\(user, step\.args\);/);
  const lookup = src("src/lib/assistantCustomFieldsLookup.ts");
  assert.match(lookup, /export const CUSTOM_FIELD_TOOLS = new Set\(\["find_leads", "lead_brief", "find_quotes", "vehicles"\]\);/);
});
