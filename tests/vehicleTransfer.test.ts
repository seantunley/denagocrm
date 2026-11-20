import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimRefusal,
  coverRemaining,
  fleetAfterTransfer,
  parseWarrantyTransferRule,
  transferDay,
  transferRefusal,
  undoRefusal,
  warrantyAtTransfer,
} from "../src/lib/vehicleTransferRules";
import { computeWarranty } from "../src/lib/warranty";

/**
 * Transfer a vehicle and its warranty to a new owner (warranty-transfer-brief.md, PR 1). The pure rules, and what the
 * code and the migration promise. The real-database half (one current owner always, two transfers at once, undo,
 * deleting a previous owner, another workspace) is scripts/test-vehicle-transfer.ts, run in CI.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const d = (iso: string) => new Date(`${iso}T00:00:00`);
const now = d("2026-11-20");
const base = { newContactId: "c2", currentContactId: "c1", currentFrom: d("2025-01-01"), date: d("2026-06-01"), reason: "sold_privately", odometerKm: 1200, now };

test("what a transfer may be", () => {
  assert.equal(transferRefusal(base), null);
  assert.match(transferRefusal({ ...base, newContactId: "" })!, /Choose the new owner/);
  assert.match(transferRefusal({ ...base, newContactId: "c1" })!, /already owns/);
  assert.match(transferRefusal({ ...base, reason: "registered" })!, /why/);
  assert.match(transferRefusal({ ...base, date: d("2026-11-21") })!, /future/);
  assert.equal(transferRefusal({ ...base, date: d("2026-11-20") }), null, "today is fine");
  assert.match(transferRefusal({ ...base, date: d("2024-12-31") })!, /before the current owner/);
  assert.equal(transferRefusal({ ...base, date: d("2025-01-01") }), null, "the day the current owner took over is fine");
  assert.match(transferRefusal({ ...base, odometerKm: -5 })!, /odometer/);
  assert.equal(transferDay("2026-02-30")?.getMonth(), 2, "an impossible day rolls, as Date does — the date input never sends one");
  assert.equal(transferDay("yesterday"), null);
});

test("the fleet: kept only when the new owner is part of it", () => {
  const fleet = { id: "f1", contactId: "manager" };
  assert.equal(fleetAfterTransfer(fleet, { id: "buyer", fleetId: null }), null, "sold out of the fleet");
  assert.equal(fleetAfterTransfer(fleet, { id: "colleague", fleetId: "f1" }), "f1", "within the fleet");
  assert.equal(fleetAfterTransfer(fleet, { id: "manager", fleetId: null }), "f1", "to the fleet's manager");
  assert.equal(fleetAfterTransfer(null, { id: "buyer", fleetId: "f1" }), null);
});

test("the warranty on transfer follows the workspace's rule — default yes — and a correction keeps what it was", () => {
  assert.equal(parseWarrantyTransferRule(null), "yes");
  assert.equal(parseWarrantyTransferRule("nonsense"), "yes");
  assert.equal(warrantyAtTransfer("yes", "sold_privately", "carried"), "carried");
  assert.equal(warrantyAtTransfer("no", "sold_privately", "carried"), "not_carried");
  assert.equal(warrantyAtTransfer("approval", "inherited", "carried"), "pending");
  assert.equal(warrantyAtTransfer("no", "correction", "carried"), "carried");
  assert.equal(claimRefusal("carried"), null);
  assert.match(claimRefusal("not_carried")!, /didn't transfer/);
  assert.match(claimRefusal("pending")!, /approval/);
});

test("undo: only a real transfer, only back to someone who exists, never after the new owner's activity — saying why", () => {
  const latest = { reason: "sold_privately", reversedAt: null };
  const none = { claims: 0, jobCards: 0, services: 0 };
  assert.equal(undoRefusal(latest, { contactId: "c1" }, none), null);
  assert.match(undoRefusal({ reason: "registered", reversedAt: null }, null, none)!, /no transfer/);
  assert.match(undoRefusal(latest, { contactId: null }, none)!, /deleted/);
  assert.equal(undoRefusal(latest, { contactId: "c1" }, { claims: 1, jobCards: 2, services: 1 }), 'The new owner already has 1 warranty claim, 2 job cards, 1 service on this vehicle, so the transfer can\'t be undone. If the transfer was a mistake, transfer it back with the reason "Correction".');
});

test("warranty dates are the vehicle's and never change: the same expiry for any owner; the dialog shows the cover left", () => {
  const v = { purchaseDate: d("2025-01-01"), warrantyMonths: 24 };
  assert.equal(computeWarranty(v, now).expiryDate?.getTime(), computeWarranty({ ...v }, now).expiryDate?.getTime());
  assert.match(coverRemaining(v, now), /^1 month and 12 days of cover left \(until .*2027\)$/);
  assert.match(coverRemaining({ purchaseDate: d("2020-01-01"), warrantyMonths: 12 }, now), /^Out of warranty since/);
  assert.equal(coverRemaining({ purchaseDate: null, warrantyMonths: 12 }, now), "No warranty on record");
  // Nothing in the transfer writes a warranty date, or moves/copies a history record.
  const core = code("src/lib/vehicleOwnership.ts");
  assert.doesNotMatch(core, /purchaseDate|warrantyMonths/);
  assert.doesNotMatch(core, /tx\.(warrantyClaim|serviceRecord|jobCard|batteryCheck|document)\.(create|update|updateMany|upsert|delete|deleteMany)\(/);
});

test("the transfer is one transaction: the vehicle held, every update count-checked, audited on the same transaction", () => {
  const core = code("src/lib/vehicleOwnership.ts");
  const transfer = core.slice(core.indexOf("export async function transferVehicleOwnership"), core.indexOf("export async function undoLastTransfer"));
  assert.match(transfer, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(transfer, /FROM "Vehicle" WHERE "id" = \$\{vehicleId\} AND "tenantId" = \$\{tenantId\} AND "deletedAt" IS NULL FOR UPDATE/, "soft-deleted vehicles are not transferable");
  assert.match(transfer, /if \(input\.expectedOwnerId && vehicle\.contactId !== input\.expectedOwnerId\) \{\s*refuse\(/, "two people transferring at once: the second is refused, not moved on from an owner they never saw");
  assert.match(code("src/app/actions/vehicleTransfer.ts"), /expectedOwnerId: text\(formData, "currentOwnerId", 64\) \|\| null,/);
  assert.match(code("src/components/TransferVehicleDialog.tsx"), /<input type="hidden" name="currentOwnerId" value=\{currentOwnerId\} \/>/);
  assert.match(transfer, /if \(closed\.count !== 1\) refuse\(/);
  assert.match(transfer, /if \(moved\.count !== 1\) refuse\(/);
  assert.match(transfer, /logAuditStrict\(\s*\{\s*action: "vehicle\.transferred"[\s\S]*?\},\s*tx,\s*\)/);
  assert.match(transfer, /isOneOpenRowViolation\(error\)\) refuse\(/, "the database's one-current-owner rule gives a clean message");
  const undo = core.slice(core.indexOf("export async function undoLastTransfer"));
  assert.match(undo, /FOR UPDATE/);
  assert.match(undo, /action: "vehicle\.transfer_undone"/);
});

test("the action: vehicles.transfer, access to the vehicle AND the destination contact; a proof document must be the vehicle's", () => {
  const action = code("src/app/actions/vehicleTransfer.ts");
  assert.match(action, /requireVehicleAccess\(vehicleId, "vehicles\.transfer"\)/);
  assert.match(action, /await requireContactAccess\(newContactId, "vehicles\.transfer"\)/);
  assert.match(action, /hasPermission\(user, "contacts\.create"\)/, "creating the new owner inline needs contacts.create");
  assert.match(action, /prisma\.document\.findFirst\(\{ where: \{ id: proofId, tenantId, vehicleId, deletedAt: null \}/);
  assert.match(action, /undoVehicleTransfer[\s\S]*?requireVehicleAccess\(vehicleId, "vehicles\.transfer"\)/);
  assert.match(action, /decideVehicleWarrantyTransfer[\s\S]*?requireVehicleAccess\(vehicleId, "warranty\.manage"\)/);
  assert.match(action, /saveWarrantyTransferRule[\s\S]*?requireTenantOwner\(\)/);
  assert.match(code("src/lib/permissions.ts"), /"vehicles\.transfer",/);
});

test("editing a vehicle can no longer change its owner", () => {
  const vehicles = code("src/app/actions/vehicles.ts");
  const update = vehicles.slice(vehicles.indexOf("export async function updateVehicle"), vehicles.indexOf("export async function deleteVehicle"));
  assert.match(update, /const \{ contactId: submittedOwner, \.\.\.data \} = vehicleData\(formData\);/);
  assert.match(update, /if \(submittedOwner && submittedOwner !== current\.contactId\) \{\s*throw new Error\("Editing a vehicle can't change its owner\. Use Transfer to new owner/);
  assert.match(update, /prisma\.vehicle\.update\(\{ where: \{ id \}, data \}\)/, "contactId is not in what is written");
  assert.match(code("src/app/(app)/vehicles/[id]/edit/page.tsx"), /ownerLocked=\{\{ label: owner,/);
});

test("claims show their claimant, not the vehicle's current owner — on every screen that shows one", () => {
  for (const file of ["src/app/(app)/warranty/page.tsx", "src/app/(app)/warranty/[id]/page.tsx", "src/app/(print)/warranty/[id]/print/page.tsx", "src/lib/docbuilder/leadWarrantyRecords.ts"]) {
    assert.match(code(file), /withClaimants?\(/, file);
  }
  const helper = code("src/lib/warrantyClaimant.ts");
  assert.match(helper, /tenantId: \{ in: tenantIds \}/, "the claimant is read in the claim's own workspace");
  assert.match(helper, /firstName: "Previous owner \(deleted\)"/, "a purged claimant shows no one else's details");
});

test("a new claim is refused when the warranty doesn't cover the current owner", () => {
  assert.match(code("src/app/actions/warranty.ts"), /claimRefusal\(await currentOwnershipWarranty\(vehicle\.tenantId, vehicleId\)\)/);
});

test("the migration: one current owner per vehicle held by the database, every vehicle backfilled and proven, walled per workspace", () => {
  const sql = code("prisma/migrations/20261120170000_vehicle_ownership/migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "VehicleOwnership_one_open_per_vehicle"\s+ON "VehicleOwnership"\("vehicleId"\) WHERE "ownedUntil" IS NULL;/);
  assert.match(sql, /CREATE TRIGGER "Vehicle_open_first_ownership" AFTER INSERT ON "Vehicle"/);
  assert.match(sql, /INSERT INTO "VehicleOwnership" [\s\S]*?FROM "Vehicle" v\s+WHERE NOT EXISTS/);
  assert.match(sql, /RAISE EXCEPTION 'VehicleOwnership backfill: % vehicle\(s\) without exactly one current owner'/);
  assert.match(sql, /ALTER TABLE "VehicleOwnership" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "VehicleOwnership" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /FOREIGN KEY \("tenantId", "vehicleId"\) REFERENCES "Vehicle"\("tenantId", "id"\)/);
  assert.match(sql, /FOREIGN KEY \("contactId"\) REFERENCES "Contact"\("id"\) ON DELETE SET NULL/, "deleting a previous owner never touches the vehicle");
  assert.match(sql, /'vehicles\.transfer'/);
  assert.match(sql, /split_part\(r\."id", ':', 1\) IN \('role_crm_admin', 'role_workshop_manager', 'role_sales_manager'\)/);
});

test("merging contacts moves their ownership rows with everything else", () => {
  assert.match(code("src/app/actions/merge.ts"), /await move\(tx\.vehicleOwnership, "contactId", "vehicle ownership records"\);/);
});
