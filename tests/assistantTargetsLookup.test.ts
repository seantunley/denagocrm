import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseSteps } from "../src/lib/crmAssistantPlan";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const one = (s: string) => parseSteps(s)?.[0] as { tool: string; args: Record<string, unknown> } | undefined;

test("DAX can ask for the month's targets and for competitor intelligence", () => {
  assert.deepEqual(one('{"tool":"targets","args":{}}'), { tool: "targets", args: {} });
  assert.deepEqual(one('{"tool":"targets","args":{"period":"2026-11-01"}}')?.args, { period: "2026-11" }, "a date → its month");
  assert.equal(parseSteps('{"tool":"targets","args":{"person":"Donovan"}}'), null, "targets are for the business, not per person");
  assert.deepEqual(one('{"tool":"competitors","args":{"name":"Rival"}}'), { tool: "competitors", args: { name: "Rival" } });
});

test("each is held to its page's rule, in its page's numbers", () => {
  const lookup = code("src/lib/assistantTargetsLookup.ts");
  // /targets: its layout's reports permission; the page's own counts (one rule, read by both).
  assert.match(lookup, /hasAnyPermission\(user, "reports\.view_all", "reports\.view_team", "reports\.view"\)/);
  assert.match(lookup, /targetProgress\(ownedWriteTenantId\(\), period, monthStart, monthEnd\)/);
  assert.match(code("src/app/(app)/targets/page.tsx"), /await targetProgress\(await actingTenantId\(\), period, monthStart\)/);
  // /competitors: the automation module and competitors.view; the workspace named in every query.
  assert.match(lookup, /isModuleEnabled\("automation"\)/);
  assert.match(lookup, /hasPermission\(user, "competitors\.view"\)/);
  assert.equal((lookup.match(/where: \{ tenantId,/g) ?? []).length, 3, "competitors, their changes, their brief");
  const rule = code("src/lib/targetProgress.ts");
  assert.equal((rule.match(/where: \{ tenantId,/g) ?? []).length, 5, "every count names the workspace");
  assert.match(rule, /sales_value: wonLeads\.reduce\(\(sum, lead\) => sum \+ baseValueCents\(lead\), 0\)/, "base currency only");
});
