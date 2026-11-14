import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { customersArgs, parseSteps } from "../src/lib/crmAssistantPlan";

const src = readFileSync(new URL("../src/lib/assistantCustomersLookup.ts", import.meta.url), "utf8");

test("customers: the filters DAX may ask for, capped", () => {
  assert.deepEqual(customersArgs.parse({ area: "Constantia", birthdayWithinDays: 90, limit: 500 }), { area: "Constantia", birthdayWithinDays: 31, limit: 60 });
  assert.equal(customersArgs.safeParse({ kind: "vip" }).success, false);
  assert.equal(customersArgs.safeParse({ idNumber: "x" }).success, false, "strict: nothing else");
  const step = parseSteps('{"tool":"customers","args":{"fleet":"Pearl Valley","openDeal":false}}')?.[0];
  assert.deepEqual(step, { tool: "customers", args: { fleet: "Pearl Valley", openDeal: false } });
  assert.deepEqual(parseSteps('{"tool":"customers"}')?.[0], { tool: "customers", args: {} });
});

test("customers: the customers page's own rule, ANDed, in the named workspace", () => {
  assert.match(src, /hasAnyPermission\(user, "contacts\.view_all", "contacts\.view_owned"\)/);
  assert.match(src, /const ids = await getAccessibleContactIds\(user\);/);
  // The access list sits inside AND, so no filter can replace it.
  assert.match(src, /AND: \[\s*\.\.\.\(ids === null \? \[\] : \[\{ id: \{ in: ids \} \}\]\),/);
  assert.match(src, /const where = \{\s*tenantId,\s*deletedAt: null,/);
  // Fleets: Automotive and fleets.view/manage, as /fleets.
  assert.match(src, /\(await isModuleEnabled\("automotive"\)\) && \(await hasAnyPermission\(user, "fleets\.view", "fleets\.manage"\)\)/);
  assert.match(src, /prisma\.fleet\.findMany\(\{ where: \{ tenantId, name: fuzzy\(args\.fleet\) \}/);
  // Fleet MEMBERSHIP is fleet data (review of #1103): kind fleet refused, rows never say fleet, business includes members.
  assert.match(src, /if \(\(args\.fleet \|\| args\.kind === "fleet"\) && !fleetsOpen\) return note\(/);
  assert.match(src, /kind: fleetsOpen && c\.fleetId \? "fleet" : c\.isCompany \? "business" : "individual",/);
  assert.match(src, /args\.kind === "business" \? \[fleetsOpen \? \{ isCompany: true, fleetId: null \} : \{ isCompany: true \}\]/);
});

test("customers: a birthday window is ranked by the day across every match, not the newest few (review of #1103)", () => {
  assert.match(src, /for \(const d of days\) \{\s*if \(page\.length >= take\) break;/);
  assert.match(src, /where: \{ AND: \[where, \{ OR: birthdayKeys\(\[d\]\)/);
  assert.doesNotMatch(src, /BIRTHDAY_READ|dayOrder/);
});

test("customers: never ID or VAT numbers, notes or research, and nothing logged", () => {
  // The columns read for each customer (the area filter may SEARCH the address; it is never shown).
  const select = src.slice(src.indexOf("id: true, firstName: true"), src.indexOf("_count:"));
  assert.ok(select.length > 50);
  assert.doesNotMatch(select, /vatNumber|notes|research|xeroContactId|address/);
  assert.doesNotMatch(src, /logError|console\./);
});
