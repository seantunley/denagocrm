import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DELIVERABLE_STATUS,
  notReadyMessage,
  vehiclesAwaitingRegistration,
  type DeliveryQuoteLine,
} from "../src/lib/deliveryVehicles";

/**
 * GAP #12 — two delivery flows that each did half the job.
 *
 * The Deliveries board marked the quote delivered and left its stock unit
 * "allocated" forever; the stock page delivered the unit and created a vehicle
 * but left the quote on the board, where "Mark delivered" then sent the customer
 * to register the same cart again — two vehicle records for one cart.
 *
 * Both buttons now go through lib/quoteDelivery.ts → deliverQuote.
 *
 * GAP #15 — a delivery date, an invoice / proof of payment and a deposit amount
 * could not be corrected. Each correction is now an audited action.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const delivery = src("src/lib/quoteDelivery.ts");
const fulfilment = src("src/app/actions/fulfilment.ts");
const stock = src("src/app/actions/stock.ts");

function fn(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = code.indexOf("\nexport async function ", start + 1);
  return code.slice(start, next === -1 ? code.length : next);
}

/* ── #12: one delivery ───────────────────────────────────────────────────── */

test("both delivery buttons call the ONE shared deliver function", () => {
  assert.match(fn(fulfilment, "markDelivered"), /return deliverQuote\(\{/, "Deliveries board → deliverQuote");
  assert.match(fn(stock, "deliverStockUnit"), /return deliverQuote\(\{/, "stock page → deliverQuote");
  // The guided handover reaches it through markDelivered.
  assert.match(src("src/app/actions/guidedDelivery.ts"), /return markDelivered\(quoteId, formData, signedRunIds\)/);
});

test("neither entry point keeps a private copy of the delivery", () => {
  for (const [where, body] of [
    ["markDelivered", strip(fn(fulfilment, "markDelivered"))],
    ["deliverStockUnit", strip(fn(stock, "deliverStockUnit"))],
  ] as const) {
    assert.doesNotMatch(body, /quote\.updateMany\(/, `${where} must not mark the quote delivered itself`);
    assert.doesNotMatch(body, /stockUnit\.(update|updateMany)\(/, `${where} must not move stock itself`);
    assert.doesNotMatch(body, /vehicle\.create\(/, `${where} must not create vehicles itself`);
  }
});

test("the delivery marks the quote delivered AND moves every allocated unit to delivered, in one transaction", () => {
  const body = fn(delivery, "deliverQuote");
  const tx = body.slice(body.indexOf("prisma.$transaction("));
  assert.ok(body.includes("prisma.$transaction("), "quote, stock and vehicles commit together");
  assert.match(tx, /tx\.quote\.updateMany\(\{\s*where: \{ id: quoteId, tenantId, deliveredAt: null \},\s*data: \{ deliveredAt,/);
  assert.match(tx, /tx\.stockUnit\.updateMany\(\{\s*where: \{ id: unit\.id, status: DELIVERABLE_STATUS, deletedAt: null \},\s*data: \{\s*status: "delivered"/);
  // Every unit allocated to the quote is handed over — none is left "allocated".
  assert.match(body, /stockUnit\.findMany\(\{\s*where: \{ soldQuoteId: quoteId, tenantId, deletedAt: null \}/);
  assert.match(body, /const outstanding = units\.filter\(\(unit\) => !\(DELIVERED_STOCK_STATUSES/);
});

/* ── a cart that is not ready blocks the WHOLE delivery ──────────────────── */

test("the refusal names every cart that is not ready, and why — never the customer", () => {
  const message = notReadyMessage(1042, [
    { stockNumber: "STK-0007", serial: "DNG9XX00123", status: "pdi" },
    { stockNumber: null, serial: "dng9xx00456", status: "hold" },
    { stockNumber: null, serial: null, status: "allocated" },
  ]);
  assert.match(message, /^Q-1042 can't be delivered yet/);
  assert.match(message, /STK-0007 \(still in PDI\)/);
  assert.match(message, /unit …0456 \(on hold\)/, "no stock number: last 4 of the serial only");
  assert.doesNotMatch(message, /dng9xx00456/i, "never the full VIN");
  assert.match(message, /an unnumbered unit \(PDI not started\)/);
  assert.match(message, /Nothing was changed\./);
});

test("the readiness gate runs before ANY write, and the transaction re-checks it per unit", () => {
  const body = fn(delivery, "deliverQuote");
  const gate = body.indexOf("refuse(notReadyMessage(quote.number, notReady))");
  assert.notEqual(gate, -1, "deliverQuote must refuse on a not-ready cart");
  assert.match(body, /const notReady = outstanding\.filter\(\(unit\) => unit\.status !== DELIVERABLE_STATUS\);/);
  for (const write of ["input.collectEvidence(", "prisma.$transaction(", "tx.quote.updateMany(", "tx.vehicle.create("]) {
    const at = body.indexOf(write);
    assert.ok(at > gate, `${write} must come after the readiness gate — a refusal must leave nothing behind`);
  }
  // A unit that leaves ready_for_delivery between the gate and the write matches
  // nothing, refuses inside the transaction, and rolls the quote back with it.
  assert.match(body, /if \(moved\.count !== 1\) refuse\(/);
  assert.equal(DELIVERABLE_STATUS, "ready_for_delivery");
});

test("both entry points get that same refusal — the stock page has no readiness check of its own", () => {
  const unit = strip(fn(stock, "deliverStockUnit"));
  assert.doesNotMatch(unit, /current\.status/, "a private status check would give the stock page a different answer");
  assert.doesNotMatch(fn(fulfilment, "markDelivered"), /ready_for_delivery|DELIVERABLE_STATUS/);
});

test("an existing vehicle with the unit's VIN is reused, never duplicated", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /ciExactIds\("vehicleVin", unit\.serial\)/, "case-insensitive VIN match");
  const reuse = body.indexOf("existingVehicle.get(unit.id)");
  const create = body.indexOf("tx.vehicle.create(");
  assert.ok(reuse !== -1 && create !== -1 && reuse < create, "reuse is checked before any create");
  assert.match(body.slice(reuse, create), /if \(reuse\) \{[\s\S]*continue;/);
});

test("a board delivery that left its stock behind can be finished from the stock page", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /const catchUp = Boolean\(quote\.deliveredAt\);/);
  assert.match(body, /if \(catchUp && outstanding\.length === 0\) refuse\("This delivery is already marked as delivered\."\);/);
  // Still only once the cart has passed PDI: the readiness gate is not skipped.
  assert.ok(body.indexOf("const notReady") > body.indexOf("const catchUp"), "catch-up is gated like any delivery");
});

const cart = (over: Partial<DeliveryQuoteLine> = {}): DeliveryQuoteLine => ({
  productId: "rover",
  description: "Denago EV Rover XXL",
  qty: 1,
  kind: "product",
  optional: false,
  selected: true,
  colorPreference: null,
  product: { name: "Denago EV Rover XXL" },
  ...over,
});

test("a cart delivered from stock is NOT queued for a second registration", () => {
  // Two sold, one came out of stock (and got its vehicle at delivery): one left to register.
  assert.equal(vehiclesAwaitingRegistration([cart({ qty: 2 })], [{ productId: "rover" }]).length, 1);
  // Both from stock: nothing to register — this was the duplicate.
  assert.equal(vehiclesAwaitingRegistration([cart({ qty: 2 })], [{ productId: "rover" }, { productId: "rover" }]).length, 0);
  // Stock of a DIFFERENT model covers nothing on this line.
  assert.equal(vehiclesAwaitingRegistration([cart()], [{ productId: "nomad" }]).length, 1);
  // No stock: unchanged behaviour.
  assert.equal(vehiclesAwaitingRegistration([cart({ qty: 2 })]).length, 2);
});

test("the registration page and its action both use the stock-aware queue", () => {
  assert.match(src("src/app/(app)/vehicles/new/page.tsx"), /registrationQueueForQuote\(quoteId\)/);
  assert.match(src("src/app/actions/vehicles.ts"), /registrationQueueForQuote\(deliveryQuoteId\)/);
  assert.match(fn(delivery, "registrationQueueForQuote"), /soldStock: \{\s*where: \{ deletedAt: null, status: \{ in: \[\.\.\.DELIVERED_STOCK_STATUSES\] \} \}/);
});

test("each entry point keeps its sibling actions' permissions", () => {
  const board = fn(fulfilment, "markDelivered");
  assert.match(board, /requireModuleEnabled\("automotive"\)/);
  assert.match(board, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  const unit = fn(stock, "deliverStockUnit");
  assert.match(unit, /requirePermission\("stock\.manage"\)/);
  // As allocateUnit does: the quote it acts on must be one this user can reach.
  assert.match(unit, /requireQuoteAccess\(current\.soldQuoteId, "stock\.manage"\)/);
});

test("the delivery is audited — the quote and every unit handed over", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /action: "fulfilment\.delivered"/);
  assert.match(body, /action: "stock\.delivered"/);
  assert.match(body, /eventType: "unit\.delivered"/);
});

/* ── #15: corrections ────────────────────────────────────────────────────── */

const correctionActions = ["rescheduleDelivery", "replaceInvoice", "replaceProofOfPayment", "correctDepositAmount"] as const;

test("every correction is permissioned exactly like the stage it corrects", () => {
  for (const name of ["rescheduleDelivery", "correctDepositAmount"] as const) {
    const body = fn(fulfilment, name);
    assert.match(body, /return asFulfilmentAction\(async \(\) => \{/, `${name} binds the tenant scope`);
    assert.match(body, /requireModuleEnabled\("automotive"\)/, name);
    assert.match(body, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/, name);
  }
  const replace = fulfilment.slice(fulfilment.indexOf("async function replaceStageDocument"), fulfilment.indexOf("export async function replaceInvoice"));
  assert.match(replace, /return asFulfilmentAction\(async \(\) => \{/);
  assert.match(replace, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  for (const name of correctionActions) assert.ok(fulfilment.includes(`export async function ${name}(`), `${name} is exported`);
});

test("the corrections are where people work: desktop board AND mobile queue, one component", () => {
  const page = src("src/app/(app)/deliveries/page.tsx");
  const uses = page.match(/\{canManage && <FulfilmentCorrections quote=\{quote\} \/>\}/g) ?? [];
  assert.equal(uses.length, 2, "rendered in both the mobile and desktop views, behind deliveries.manage");
  const mobile = page.slice(page.indexOf("<MobileOnly"), page.indexOf("<DesktopOnly"));
  assert.match(mobile, /<FulfilmentCorrections quote=\{quote\} \/>/, "the mobile queue has them");
  const component = page.slice(page.indexOf("function FulfilmentCorrections"), page.indexOf("export default async function"));
  for (const action of ["replaceInvoice", "correctDepositAmount", "replaceProofOfPayment", "rescheduleDelivery"]) {
    assert.match(component, new RegExp(`action=\\{${action}\\.bind\\(null, quote\\.id\\)\\}`), `${action} is offered`);
  }
});

test("the stock unit shows the recorded reservation deposit amount", () => {
  const page = src("src/app/(app)/stock/[id]/page.tsx");
  assert.match(page, /Deposit recorded: \{unit\.depositReceivedCents != null \? formatZAR\(unit\.depositReceivedCents\)/);
  assert.match(page, /r\."depositReceivedCents"/);
});

test("rescheduling is audited old → new and moves the calendar entry", () => {
  const body = fn(fulfilment, "rescheduleDelivery");
  assert.match(body, /action: "fulfilment\.delivery_rescheduled"/);
  assert.match(body, /moved from \$\{previous\.toLocaleDateString\("en-ZA"\)\} to \$\{when\.toLocaleDateString\("en-ZA"\)\}/);
  assert.match(body, /activity\.updateMany\(\{[\s\S]*note: `Fulfilment of quote Q-\$\{quote\.number\}\.`/);
  assert.match(body, /deliveryScheduledFor: previous \}/, "conditional on the date that was read");
});

test("replacing an invoice or proof of payment keeps the old file and is audited", () => {
  const replace = strip(fulfilment.slice(fulfilment.indexOf("async function replaceStageDocument"), fulfilment.indexOf("export async function replaceInvoice")));
  assert.match(replace, /attachStageDocument\(/, "the new file goes through the same private-storage helper");
  assert.match(replace, /data: \{ replacedById: nextId \}/, "the old one is versioned, not removed");
  assert.doesNotMatch(replace, /deleteFile|deleteOwnedBlob|document\.delete|deletedAt/, "never deleted");
  assert.match(replace, /"fulfilment\.invoice_replaced" : "fulfilment\.pop_replaced"/);
});

test("deposit amounts are stored in cents and every change is audited", () => {
  const paid = fn(fulfilment, "markDepositPaid");
  assert.match(paid, /data: \{ depositPaidAt: new Date\(\), depositPaidCents: amountCents \}/);
  assert.match(paid, /deposit of \$\{formatZAR\(amountCents\)\} received/);
  const corrected = fn(fulfilment, "correctDepositAmount");
  assert.match(corrected, /action: "fulfilment\.deposit_amount_corrected"/);
  assert.match(corrected, /changed from \$\{[\s\S]*?\} to \$\{formatZAR\(amountCents\)\}/);
  assert.match(fulfilment, /const cents = parseRands\(raw\);/);

  const reservation = fn(stock, "recordReservationDeposit");
  assert.match(reservation, /requirePermission\("stock\.manage"\)/);
  assert.match(reservation, /depositReceivedCents: amountCents/);
  assert.match(reservation, /action: "stock\.deposit_received"/);
});

test("the deposit columns are additive and nullable", () => {
  const sql = src("prisma/migrations/20260930150000_delivery_deposit_amounts/migration.sql");
  assert.match(sql, /ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "depositPaidCents" INTEGER;/);
  assert.match(sql, /ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "depositReceivedCents" INTEGER;/);
  assert.doesNotMatch(strip(sql).replace(/^--.*$/gm, ""), /NOT NULL|DROP|UPDATE /);
});
