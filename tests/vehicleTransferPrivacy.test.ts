import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { claimsSince, historyFrom, ownerAt, splitServices } from "../src/lib/vehicleOwnershipPrivacy";

/**
 * Privacy after a vehicle changes hands (warranty-transfer-brief.md, PR 2). The pure rules for each viewer, before and
 * after the transfer date, and what the portal and staff screens promise. The document rule itself runs in SQL and is
 * exercised on a real database by scripts/test-vehicle-transfer.ts (seller, buyer, before and after, undo).
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const d = (iso: string) => new Date(`${iso}T00:00:00`);
const services = [
  { id: "s1", serviceDate: d("2025-06-01"), summary: "1,000 km service", km: 1000, details: "Seller asked about tyres", performedById: "tech" },
  { id: "s2", serviceDate: d("2026-02-01"), summary: "Brake check", km: 4200, details: "Buyer's own notes", performedById: "tech" },
];
const claims = [{ id: "c1", claimedAt: d("2025-07-01") }, { id: "c2", claimedAt: d("2026-03-01") }];
const transfer = { ownedFrom: d("2026-01-01"), reason: "sold_privately" };

test("never transferred: the owner sees all of it, exactly as before", () => {
  assert.equal(historyFrom({ ownedFrom: d("2025-01-01"), reason: "registered" }), null);
  assert.equal(historyFrom(undefined), null);
  const split = splitServices(services, null);
  assert.equal(split.own.length, 2);
  assert.equal(split.earlier.length, 0);
  assert.equal(claimsSince(claims, null).length, 2);
});

test("the new owner: their own services and claims in full; earlier services as date, what and odometer only", () => {
  const from = historyFrom(transfer);
  assert.equal(from?.getTime(), d("2026-01-01").getTime());
  const split = splitServices(services, from);
  assert.deepEqual(split.own.map((s) => s.id), ["s2"]);
  assert.deepEqual(split.earlier, [{ id: "s1", serviceDate: d("2025-06-01"), summary: "1,000 km service", km: 1000 }], "no notes, no technician");
  assert.deepEqual(claimsSince(claims, from).map((c) => c.id), ["c2"], "the previous owner's claim is not shown");
});

test("staff: every record names its owner at the time; an undone transfer never does", () => {
  const owners = [
    { ownerName: "Buyer", ownedFrom: d("2026-01-01"), ownedUntil: null, reason: "sold_privately", reversedAt: null },
    { ownerName: "Mistake", ownedFrom: d("2025-12-01"), ownedUntil: d("2025-12-01"), reason: "other", reversedAt: d("2025-12-02") },
    { ownerName: null, ownedFrom: d("2025-01-01"), ownedUntil: d("2026-01-01"), reason: "registered", reversedAt: null },
  ];
  assert.equal(ownerAt(owners, d("2026-02-01")), "Buyer");
  assert.equal(ownerAt(owners, d("2025-06-01")), "Previous owner (deleted)", "a purged owner is named as such");
  assert.equal(ownerAt(owners, d("2024-06-01")), "Previous owner (deleted)", "before the purchase date: still the first owner");
  assert.equal(ownerAt(owners, d("2025-12-01")), "Previous owner (deleted)", "the undone owner never shows");
});

test("the portal: one document rule for the list and the download, by ownership dates; history cut for a new owner", () => {
  const access = code("src/lib/portalAccess.ts");
  assert.match(access, /export async function portalCanAccessDocument[\s\S]*?return \(await portalAllowedDocumentIds\(scope, \[documentId\]\)\)\.has\(documentId\);/);
  const rule = access.slice(access.indexOf("export async function portalAllowedDocumentIds"), access.indexOf("export async function portalOwnershipStarts"));
  assert.match(rule, /o\."reversedAt" IS NULL/, "an undone owner sees nothing by it");
  assert.match(rule, /o\."reason" = 'registered' OR d\."createdAt" >= o\."ownedFrom"/, "the first owner has no cut-off");
  assert.match(rule, /o\."ownedUntil" IS NULL OR d\."createdAt" < o\."ownedUntil"/, "a previous owner keeps their own time's paperwork, not the next owner's");
  assert.match(rule, /d\."staysWithVehicle"/, "marked paperwork passes to the current owner");
  assert.doesNotMatch(rule, /OR v\."contactId" = ANY\(\$\{scope\.contactIds\}::text\[\]\)\s*\n\s*OR/, "the current owner no longer sees every vehicle document");
  const list = code("src/app/portal/documents/page.tsx");
  assert.match(list, /const allowed = await portalAllowedDocumentIds\(scope, candidates\.map\(\(d\) => d\.id\)\);\s*const documents = candidates\.filter\(\(d\) => allowed\.has\(d\.id\)\);/);
  const home = code("src/app/portal/page.tsx");
  assert.match(home, /const services = splitServices\(vehicle\.serviceRecords, from\);/);
  assert.match(home, /const claims = claimsSince\(vehicle\.warrantyClaims, from\)\.slice\(0, 3\);/);
  const earlier = home.slice(home.indexOf("Services before you owned it"), home.indexOf("{claims.length > 0"));
  assert.doesNotMatch(earlier, /details|performedBy|jobCard|price|contactName/, "the summary carries no notes, names or prices");
  assert.doesNotMatch(home, /vehicle\.serviceRecords\.slice|vehicle\.warrantyClaims\.map/, "nothing reads the uncut history");
});

test("staff mark a vehicle's document as staying with it: vehicles.manage on that vehicle, audited; off by default", () => {
  const action = code("src/app/actions/vehicleDocuments.ts");
  assert.match(action, /requireVehicleAccess\(doc\.vehicleId, "vehicles\.manage"\)/);
  assert.match(action, /where: \{ id: documentId, tenantId, deletedAt: null \}/);
  assert.match(action, /action: "document\.stays_with_vehicle"/);
  assert.match(code("prisma/migrations/20261120180000_document_stays_with_vehicle/migration.sql"), /ADD COLUMN IF NOT EXISTS "staysWithVehicle" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(code("src/components/DocumentsPanel.tsx"), /\{doc\.vehicleId && <StaysWithVehicleToggle /);
  // Staff see every document on the vehicle page, each with its owner at the time.
  assert.match(code("src/app/(app)/vehicles/[id]/page.tsx"), /ownerLabel: ownerOn\(d\.createdAt\)/);
});
