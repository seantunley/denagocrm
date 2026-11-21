import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_WARRANTY_PARTS,
  coverOf,
  parsePartList,
  parseTerms,
  partCovered,
  termEnd,
  termLabel,
  termRows,
  termsFromForm,
  vehicleCover,
  vehicleWarrantyFrom,
} from "../src/lib/warrantyParts";
import { computeWarranty } from "../src/lib/warranty";
import { analyzeBattery } from "../src/lib/battery";
import { vehicleWorkshop } from "../src/lib/workshopRules";

/**
 * Sean, 2026-11-21: "5 Years on the Battery, 2 years on the cart and lifetime on the chassis. But the warranty details
 * need to be captured per vehicle. The bike will have different warranties." Time only; from the delivery day.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const day = (iso: string) => new Date(`${iso}T00:00:00`);
const CART = [{ part: "Battery", months: 60 }, { part: "Cart", months: 24 }, { part: "Chassis", months: null }];

function form(rows: [string, string, string][]): FormData {
  const f = new FormData();
  rows.forEach(([part, length, unit], i) => {
    f.set(`part_${i}`, part);
    f.set(`length_${i}`, length);
    f.set(`unit_${i}`, unit);
  });
  return f;
}

test("the cart's terms: battery 5 years, cart 2 years, chassis for life — each from the delivery day", () => {
  const cover = coverOf(CART, day("2026-11-21"), day("2029-01-10"));
  assert.deepEqual(cover.map((c) => [c.part, c.until?.toDateString() ?? null, c.status]), [
    ["Battery", day("2031-11-21").toDateString(), "active"],
    ["Cart", day("2028-11-21").toDateString(), "expired"],
    ["Chassis", null, "lifetime"],
  ]);
  assert.deepEqual(CART.map((t) => termLabel(t.months)), ["5 years", "2 years", "Lifetime"]);
  assert.equal(termLabel(18), "18 months");
});

test("the battery claim and DAX's workshop read the Battery part's cover, not the old single term", () => {
  // Review case: the old single term says 12 months; the parts say Battery 5 years, Chassis for life. 18 months on, SoH 65%.
  const delivered = day("2025-05-21");
  const now = day("2026-11-21");
  const v = { purchaseDate: delivered, warrantyMonths: 12, warrantyParts: CART, warrantyStartsAt: delivered };
  const checks = [{ checkedAt: now, stateOfHealth: 65 }];
  assert.equal(analyzeBattery(checks, { ...v, now }).warrantyEligible, true, "battery still covered for 5 years");
  assert.equal(analyzeBattery(checks, { ...v, warrantyParts: [{ part: "Chassis", months: null }], now }).warrantyEligible, false, "a lifetime chassis doesn't cover the battery");
  assert.equal(analyzeBattery(checks, { purchaseDate: delivered, warrantyMonths: 12, now }).warrantyEligible, false, "no parts: the single term, as before");
  assert.equal(partCovered(v, "Cart", now), true);
  assert.equal(partCovered(v, "Cart", day("2027-06-01")), false);
  const workshop = vehicleWorkshop({
    id: "v1", model: "Nomad XL", regNumber: null, ...v,
    serviceIntervalKm: null, serviceIntervalMonths: null, serviceRecords: [], mileageLogs: [], batteryChecks: checks,
  }, now, true) as Record<string, unknown>;
  assert.equal(workshop.warranty, "In warranty", "not 'out of warranty' after 12 months");
  assert.equal(workshop.batteryWarrantyClaimCandidate, true);
  // Both DAX workshop queries load the parts.
  const context = code("src/lib/workshopContext.ts");
  assert.equal(context.match(/warrantyMonths: true,\s*warrantyParts: true, warrantyStartsAt: true,/g)?.length, 2);
  assert.match(code("src/app/(app)/vehicles/[id]/page.tsx"), /analyzeBattery\(checks, \{ \.\.\.vehicle, now: new Date\(\) \}\)/);
});

test("month-ends clamp to the last day of the month, as the single-term warranty does", () => {
  const end = (iso: string, months: number) => termEnd(day(iso), months)?.toDateString();
  assert.equal(end("2026-01-29", 1), day("2026-02-28").toDateString());
  assert.equal(end("2026-01-30", 1), day("2026-02-28").toDateString());
  assert.equal(end("2026-01-31", 1), day("2026-02-28").toDateString(), "never rolls into March");
  assert.equal(end("2028-01-31", 1), day("2028-02-29").toDateString(), "leap year");
  assert.equal(end("2028-02-29", 12), day("2029-02-28").toDateString(), "leap day + a year");
  // One policy: a single 24-month term and a 24-month part end on the same day.
  const legacy = computeWarranty({ purchaseDate: day("2028-02-29"), warrantyMonths: 24 }, day("2028-03-01")).expiryDate;
  assert.equal(legacy?.toDateString(), end("2028-02-29", 24));
});

test("what is posted: parts from the workspace's own list only, years or months or lifetime, no duplicates", () => {
  const parts = DEFAULT_WARRANTY_PARTS;
  const ok = termsFromForm(form([["Battery", "5", "years"], ["cart", "24", "months"], ["Chassis", "", "lifetime"], ["", "", "years"]]), parts);
  assert.deepEqual(ok, { ok: true, terms: CART });
  assert.equal(termsFromForm(form([["Frame", "2", "years"]]), parts).ok, false, "not on the list");
  assert.equal(termsFromForm(form([["Battery", "5", "years"], ["Battery", "2", "years"]]), parts).ok, false, "listed twice");
  assert.equal(termsFromForm(form([["Battery", "", "years"]]), parts).ok, false, "needs a length");
  assert.deepEqual(termsFromForm(form([["Battery", "1.5", "years"]]), parts), { ok: true, terms: [{ part: "Battery", months: 18 }] });
  assert.equal(termsFromForm(form([["Battery", "1.3", "years"]]), parts).ok, false, "a whole number of months");
  assert.deepEqual(termRows(CART), [
    { part: "Battery", length: "5", unit: "years" }, { part: "Cart", length: "2", unit: "years" }, { part: "Chassis", length: "", unit: "lifetime" },
  ]);
});

test("stored values are read defensively; the part list defaults, trims and de-duplicates", () => {
  assert.deepEqual(parseTerms([{ part: "Battery", months: 60 }, { part: "x", months: 0 }, { part: "battery", months: 12 }, "junk", { months: 5 }]), [{ part: "Battery", months: 60 }]);
  assert.deepEqual(parseTerms(null), []);
  assert.deepEqual(parsePartList(null), ["Battery", "Cart", "Chassis"]);
  assert.deepEqual(parsePartList(" Battery \nbattery\n\nMotor"), ["Battery", "Motor"]);
});

test("a vehicle copies its product's terms from the delivery day; without parts it reads as it always did", () => {
  assert.deepEqual(vehicleWarrantyFrom(CART, day("2026-11-21")), { warrantyParts: CART, warrantyStartsAt: day("2026-11-21") });
  assert.deepEqual(vehicleWarrantyFrom(null, day("2026-11-21")), {}, "a product without terms adds nothing");
  const old = { warrantyParts: null, warrantyStartsAt: null, purchaseDate: day("2026-01-01"), warrantyMonths: 12 };
  assert.deepEqual(vehicleCover(old, day("2026-06-01")).map((c) => [c.part, c.months, c.status]), [["Warranty", 12, "active"]]);
  assert.equal(computeWarranty(old, day("2026-06-01")).status, "active");
  // In parts: in warranty for good with a lifetime part; otherwise until the last part ends.
  const parted = { ...old, warrantyParts: CART, warrantyStartsAt: day("2026-11-21") };
  assert.deepEqual(computeWarranty(parted, day("2040-01-01")), { status: "active", expiryDate: null, daysRemaining: null });
  const noLifetime = { ...parted, warrantyParts: CART.slice(0, 2) };
  assert.equal(computeWarranty(noLifetime, day("2030-01-01")).expiryDate?.toDateString(), day("2031-11-21").toDateString());
  assert.equal(computeWarranty(noLifetime, day("2032-01-01")).status, "expired");
});

test("wired in: delivery and registration copy the product's terms; owner-only edits on product and part list; warranty.manage per vehicle", () => {
  const delivery = code("src/lib/quoteDelivery.ts");
  assert.match(delivery, /include: \{ product: \{ select: \{ name: true, warrantyTerms: true \} \} \}/);
  assert.match(delivery, /\.\.\.vehicleWarrantyFrom\(unit\.product\.warrantyTerms, deliveredAt\),/);
  assert.match(code("src/app/actions/vehicles.ts"), /\.\.\.vehicleWarrantyFrom\(product\?\.warrantyTerms, data\.purchaseDate \?\? new Date\(\)\)/);
  const actions = code("src/app/actions/warrantyParts.ts");
  assert.match(actions, /if \(!\(await isModuleEnabled\("warranty"\)\)\) refuse\(/);
  const product = actions.slice(actions.indexOf("export async function saveProductWarrantyTerms"), actions.indexOf("export async function saveVehicleWarranty"));
  assert.match(product, /await requireTenantOwner\(\);[\s\S]*prisma\.product\.updateMany\(\{ where: \{ id: productId, tenantId \}/);
  const vehicle = actions.slice(actions.indexOf("export async function saveVehicleWarranty"));
  assert.match(vehicle, /requireVehicleAccess\(vehicleId, "warranty\.manage"\)/);
  assert.match(vehicle, /action: "vehicle\.warranty_changed"[\s\S]*before: \{ warrantyParts: vehicle\.warrantyParts, warrantyStartsAt: vehicle\.warrantyStartsAt \}/);
  assert.match(actions, /putWorkspaceSetting\(tenantId, WARRANTY_PARTS_KEY, parts\.join\("\\n"\)\)/, "the workspace's own list, named by workspace");
  assert.match(code("src/app/(app)/products/[id]/page.tsx"), /tenantId && \(await isModuleEnabled\("warranty"\)\)/);
  const sql = code("prisma/migrations/20261121120000_warranty_parts/migration.sql");
  assert.match(sql, /ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "warrantyTerms" JSONB;/);
  assert.match(sql, /ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "warrantyParts" JSONB;/);
  assert.match(sql, /ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "warrantyStartsAt" TIMESTAMP\(3\);/);
});
