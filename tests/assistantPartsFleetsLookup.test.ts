import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assistantStep, fleetsArgs, partsArgs } from "../src/lib/crmAssistantPlan";

const src = readFileSync(new URL("../src/lib/assistantPartsFleetsLookup.ts", import.meta.url), "utf8");
/** One exported function's source, up to the next one (or the end of the file). */
const fn = (name: string) => {
  const start = src.indexOf(`export async function ${name}(`);
  const end = src.indexOf("\nexport async function", start + 1);
  return src.slice(start, end < 0 ? undefined : end);
};

test("parts and fleets are lookups DAX can ask for", () => {
  assert.equal(assistantStep.safeParse({ tool: "parts", args: { search: "brake pads XL", lowStock: true } }).success, true);
  assert.equal(assistantStep.safeParse({ tool: "parts", args: {} }).success, true);
  assert.equal(assistantStep.safeParse({ tool: "fleets", args: { fleet: "Pearl Valley" } }).success, true);
  assert.equal(partsArgs.safeParse({ search: "x", costCents: 1 }).success, false, "strict");
  assert.equal(fleetsArgs.safeParse({ fleet: "x", tenantId: "t" }).success, false, "strict");
  assert.equal(partsArgs.parse({ limit: 500 }).limit, 60, "capped");
});

test("parts: the Parts page's rule; the cost only for those who may manage parts; notes searched, never shown", () => {
  const parts = fn("partsLookup");
  assert.ok(parts.indexOf('isModuleEnabled("automotive")') < parts.indexOf("prisma.part.findMany"), "module first");
  assert.ok(parts.indexOf('hasAnyPermission(user, "parts.view", "parts.manage")') < parts.indexOf("prisma.part.findMany"), "permission first");
  assert.match(parts, /const showCost = await hasAnyPermission\(user, "parts\.manage"\);/);
  assert.match(parts, /\.\.\.\(showCost \? \{ cost: formatZAR\(p\.costCents, money\) \} : \{\}\),/);
  assert.match(parts, /where: \{\s*tenantId,\s*active: true,\s*deletedAt: null,/);
  const shown = parts.slice(parts.indexOf("const shown = "), parts.indexOf("return {", parts.indexOf("const shown = ")));
  assert.doesNotMatch(shown, /notes|margin/);
});

test("fleets: the Fleets page's rule; linked records only where the person may open them; no billing details", () => {
  const fleets = fn("fleetsLookup");
  assert.ok(fleets.indexOf('isModuleEnabled("automotive")') < fleets.indexOf("prisma.fleet."), "module first");
  assert.ok(fleets.indexOf('hasAnyPermission(user, "fleets.view", "fleets.manage")') < fleets.indexOf("prisma.fleet."), "permission first");
  assert.match(fleets, /const fleetWhere = \{ tenantId, deletedAt: null,/);
  // Access lists ANDed, never spread.
  assert.match(fleets, /const only = \(ids: string\[\] \| null\) => \(ids === null \? \[\] : \[\{ id: \{ in: ids \} \}\]\);/);
  assert.match(fleets, /status: "open", contactId: \{ in: memberIds \}, AND: only\(leadIds\)/);
  assert.match(fleets, /\.\.\.only\(jobIds\)\]/);
  assert.match(fleets, /\.\.\.only\(contactIds\)\]/);
  assert.match(fleets, /status: \{ notIn: CLOSED_JOB_STATUSES \}/);
  assert.doesNotMatch(fleets, /vatNumber|registrationNumber|billingEmail|billingPhone|xeroContactId/);
});
