import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { lookupStatus, parseStep } from "../src/lib/crmAssistantPlan";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lookups = src("src/lib/assistantAreaLookups.ts");
const fn = (name: string) => lookups.slice(lookups.indexOf(`export async function ${name}(`), lookups.indexOf("\n}\n", lookups.indexOf(`export async function ${name}(`)));

/** Sean, 2026-11-13: "no lookups for the help desk, marketing campaigns, forecast, surveys or referrals". */
test("DAX can ask for each area, and nothing it shouldn't", () => {
  assert.deepEqual(parseStep('{"tool":"tickets","args":{"mine":true}}'), { tool: "tickets", args: { mine: true } });
  assert.deepEqual(parseStep('{"tool":"tickets"}'), { tool: "tickets", args: {} });
  assert.deepEqual(parseStep('{"tool":"campaigns","args":{"from":"2026-11-02","to":"2026-11-08"}}'), { tool: "campaigns", args: { from: "2026-11-02", to: "2026-11-08" } });
  assert.deepEqual(parseStep('{"tool":"forecast","args":{"period":"2026-12"}}'), { tool: "forecast", args: { period: "2026-12" } });
  assert.deepEqual(parseStep('{"tool":"surveys","args":{"survey":"Service"}}'), { tool: "surveys", args: { survey: "Service" } });
  assert.deepEqual(parseStep('{"tool":"referrals","args":{"status":"earned"}}'), { tool: "referrals", args: { status: "earned" } });
  assert.equal(parseStep('{"tool":"forecast","args":{"period":"December"}}'), null);
  assert.equal(parseStep('{"tool":"tickets","args":{"tenantId":"other"}}'), null, "strict: no reaching another workspace by argument");
  assert.equal(lookupStatus([{ tool: "tickets" }, { tool: "forecast" }]), "Checking the help desk and working out the forecast…");
  const plan = src("src/lib/crmAssistantPlan.ts");
  for (const tool of ["tickets", "campaigns", "forecast", "surveys", "referrals"]) assert.match(plan, new RegExp(`'- ${tool}: \\{`), `${tool} is described to DAX`);
  const runner = src("src/lib/crmAssistant.ts");
  for (const [tool, call] of [["tickets", "ticketsLookup"], ["campaigns", "campaignsLookup"], ["forecast", "forecastLookup"], ["surveys", "surveysLookup"], ["referrals", "referralsLookup"]]) {
    assert.match(runner, new RegExp(`case "${tool}": return ${call}\\(user, step\\.args\\);`));
  }
});

test("each lookup is held to its page's own rule — permission, module, and the page's query", () => {
  // Help desk: the cases page's permission, the support module, and the page's own query (its access list inside).
  const tickets = fn("ticketsLookup");
  assert.match(tickets, /isModuleEnabled\("support"\)/);
  assert.match(tickets, /hasAnyPermission\(user, "cases\.view_all", "cases\.view_owned"\)/);
  assert.match(tickets, /listTickets\(user, /);
  assert.match(lookups, /export const TICKET_REPLY_HOURS = 24;/);
  // Forecast: the forecast page's permission, its query, and its own team/owner visibility filter.
  const forecast = fn("forecastLookup");
  assert.match(forecast, /hasAnyPermission\(user, "forecast\.view", "forecast\.manage"\)/);
  assert.match(forecast, /listForecastLeads\(/);
  assert.match(forecast, /scope\.viewAll \? all : all\.filter\(\(l\) => l\.assignedToId === scope\.userId \|\| Boolean\(l\.teamId && scope\.teamIds\.includes\(l\.teamId\)\)\)/);
  // Surveys: the route rule's permissions and the marketing module.
  const surveys = fn("surveysLookup");
  assert.match(surveys, /isModuleEnabled\("marketing"\)/);
  assert.match(surveys, /hasAnyPermission\(user, "surveys\.view", "surveys\.manage"\)/);
  assert.match(src("src/lib/routeAccess.ts"), /\{ prefix: "\/surveys", anyOf: \["surveys\.view", "surveys\.manage"\] \}/, "the same rule the page uses");
  // Campaigns and referrals: open to every member (as their pages are), with Marketing on.
  for (const name of ["campaignsLookup", "referralsLookup"]) assert.match(fn(name), /isModuleEnabled\("marketing"\)/, name);
  assert.match(src("src/app/(app)/campaigns/page.tsx"), /requireUser/);
  assert.match(src("src/app/(app)/referrals/page.tsx"), /await requireUser\(\);/);
});

test("the workspace is named in every query of its own, and nothing is logged", () => {
  assert.equal((lookups.match(/tenantId: ownedWriteTenantId\(\)/g) ?? []).length, 2, "campaigns and referrals");
  assert.match(fn("surveysLookup"), /const tenantId = ownedWriteTenantId\(\);[\s\S]*where: \{ tenantId, deletedAt: null[\s\S]*where: \{ tenantId, sentAt:/);
  assert.doesNotMatch(lookups, /logError|console\./);
  assert.doesNotMatch(lookups, /basePrisma/, "only the scoped client and the pages' own helpers");
});
