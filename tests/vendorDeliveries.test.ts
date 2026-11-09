import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bookingDay, bookingMessage, canMoveDelivery, nextDeliveryStatuses } from "../src/lib/vendorDeliveryRules";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a booking moves forward one step at a time, and can be cancelled only before collection", () => {
  assert.deepEqual(nextDeliveryStatuses("requested"), ["confirmed", "cancelled"]);
  assert.deepEqual(nextDeliveryStatuses("confirmed"), ["collected", "cancelled"]);
  assert.deepEqual(nextDeliveryStatuses("collected"), ["delivered"]);
  assert.deepEqual(nextDeliveryStatuses("delivered"), []);
  assert.deepEqual(nextDeliveryStatuses("cancelled"), []);
  assert.equal(canMoveDelivery("requested", "delivered"), false, "no skipping");
  assert.equal(canMoveDelivery("collected", "cancelled"), false);
  assert.equal(canMoveDelivery("nonsense", "confirmed"), false);
});

test("the day is a real calendar day", () => {
  assert.equal(bookingDay("2026-11-14")?.toISOString(), "2026-11-14T00:00:00.000Z");
  for (const bad of ["2026-02-30", "14/11/2026", "", null]) assert.equal(bookingDay(bad), null, String(bad));
});

test("the message names the job, the day, both addresses and what is moving — and the brand", () => {
  const { subject, text } = bookingMessage({
    brand: "Denago Cape Town", vendorName: "Swift Transport", reference: "Q-1029", dayLabel: "Saturday, 14 November 2026",
    fromAddress: "1 Warehouse Rd, Epping", toAddress: "5 Beach Rd, Muizenberg", items: ["1 × Rover XL"], note: "Gate code 4411",
  });
  assert.equal(subject, "Delivery booking Q-1029 — Saturday, 14 November 2026");
  for (const part of ["Hi Swift Transport", "Denago Cape Town would like to book", "Collect from: 1 Warehouse Rd, Epping", "Deliver to: 5 Beach Rd, Muizenberg", "- 1 × Rover XL", "Gate code 4411"]) {
    assert.ok(text.includes(part), part);
  }
});

test("booking: the right permission per direction, own workspace, module, and nothing left saying it was sent when it wasn't", () => {
  const action = src("src/app/actions/vendorDeliveries.ts");
  assert.match(action, /requireQuoteAccess\(target\.quoteId, "deliveries\.manage"\) : await requirePermission\("stock\.manage"\)/);
  assert.match(action, /isModuleEnabled\("suppliers"\)/);
  assert.match(action, /quote\.findFirst\(\{\s*where: \{ id: target\.quoteId, tenantId,/);
  assert.match(action, /purchaseOrder\.findFirst\(\{\s*where: \{ id: target\.purchaseOrderId, tenantId,/);
  assert.match(action, /vendor\.findFirst\(\{\s*where: \{ id: String\(formData\.get\("vendorId"\) \?\? ""\), tenantId, deletedAt: null \}/);
  assert.match(action, /if \(!sent\.ok\) \{[\s\S]*?vendorDelivery\.deleteMany\(\{ where: \{ id: booking\.id, tenantId \} \}\)/);
  assert.match(action, /linkVendorToDeal\(/, "a customer delivery puts the company on the deal, so its papers are expected");
  // Only "email" sends; "copy" and "record" never reach sendEmail.
  assert.match(action, /const send = choice === "copy" \|\| choice === "record" \? choice : "email";/);
  assert.match(action, /if \(send === "email"\) \{\s*const sent = await sendEmail\(/);
  assert.equal((action.match(/sendEmail\(/g) ?? []).length, 1, "one send, behind the email choice");
  assert.match(action, /if \(send === "record"\) return \{ success: "Booking recorded — nothing was sent" \};/);
  assert.match(action, /action: "delivery\.booked"/);
});

test("status changes: own workspace, allowed step only, and only from the status that was read", () => {
  const action = src("src/app/actions/vendorDeliveries.ts");
  assert.match(action, /vendorDelivery\.findFirst\(\{\s*where: \{ id: bookingId, tenantId \}/);
  assert.match(action, /canMoveDelivery\(booking\.status, status\)/);
  assert.match(action, /updateMany\(\{ where: \{ id: booking\.id, tenantId, status: booking\.status \}/);
  assert.match(action, /moved\.count !== 1/);
  assert.match(action, /action: "delivery\.status_changed"/);
});

test("a booking belongs to exactly one deal or purchase order, in its own workspace", () => {
  const sql = src("prisma/migrations/20261110020000_vendor_deliveries/migration.sql");
  assert.match(sql, /CHECK \(\("quoteId" IS NULL\) <> \("purchaseOrderId" IS NULL\)\)/);
  for (const fk of ["vendorId", "quoteId", "purchaseOrderId"]) assert.match(sql, new RegExp(`FOREIGN KEY \\("tenantId", "${fk}"\\)`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
});

test("bookings show only with the Suppliers module on", () => {
  assert.match(src("src/app/(app)/deliveries/page.tsx"), /const bookable = \(await isModuleEnabled\("suppliers"\)\)/);
  assert.match(src("src/app/(app)/stock/page.tsx"), /vendors !== null && openPos\.length/);
});
