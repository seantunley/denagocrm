import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseSteps, testDrivesArgs } from "../src/lib/crmAssistantPlan";

const src = readFileSync(new URL("../src/lib/assistantTestDrivesLookup.ts", import.meta.url), "utf8");

test("test_drives: past and upcoming, by customer, vehicle, outcome, bought or not", () => {
  assert.deepEqual(testDrivesArgs.parse({ from: "2026-11-07", to: "2026-11-13T10:00", boughtAfter: false, limit: 500 }), { from: "2026-11-07", to: "2026-11-13", boughtAfter: false, limit: 60 });
  assert.equal(testDrivesArgs.safeParse({ licence: "x" }).success, false, "strict: nothing else");
  const [step] = parseSteps('{"tool":"test_drives","args":{"customer":"Anna"}}') ?? [];
  assert.deepEqual(step, { tool: "test_drives", args: { customer: "Anna" } });
});

test("held to the /test-drives page's own rule, checked before anything is read", () => {
  const body = src.slice(src.indexOf("export async function testDrivesLookup("));
  const firstQuery = body.indexOf("prisma.");
  assert.ok(body.indexOf('isModuleEnabled("automotive")') < firstQuery, "Automotive first");
  assert.ok(body.indexOf('hasAnyPermission(user, "activities.view", "activities.manage")') < firstQuery, "the page's permission first");
  // The page's own booking scope, ANDed — never spread, so nothing asked for can replace it.
  assert.match(body, /accessibleTestDriveWhere\(user\)/);
  assert.match(body, /AND: \[\s*scope,/);
  // A won deal only when the person may open it.
  assert.match(body, /AND: \[leadIds === null \? \{\} : \{ id: \{ in: leadIds \} \}\]/);
  // The workspace named in the bookings query, and in every contact, product and lead read.
  assert.match(body, /const where: Prisma\.TestDriveBookingWhereInput = \{\s*tenantId,/);
  const reads = body.match(/prisma\.(contact|product|lead)\.findMany\(\{\s*where: \{ [^\n]*/g) ?? [];
  assert.ok(reads.length >= 5, String(reads.length));
  for (const q of reads) assert.match(q, /where: \{ tenantId,/, q.slice(0, 90));
});

test("never the licence, identity, emergency contact, uploads or incident text", () => {
  const select = src.slice(src.indexOf("select: {", src.indexOf("prisma.testDriveBooking.findMany")), src.indexOf("demoVehicle: { select"));
  for (const field of ["driverLicence", "identityVerified", "emergencyContact", "incidentReport", "newDamage", "existingDamage", "assets"]) {
    assert.doesNotMatch(select, new RegExp(field), field);
  }
});
