import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { depositFromXero, readXeroInvoice } from "../src/lib/xeroInvoice";
import { ROUTE_RULES } from "../src/lib/routeAccess";

/**
 * Sean, 2026-11-11: "invoicing and too much stuff is happening around that
 * deliveries board. Getting very cramped and the flow also is difficult to
 * understand" → "Build them all": money off the board onto an Invoices page;
 * Send-to-Xero IS the invoice step; the deposit comes from Xero; one next step per
 * card with Details behind it; columns that say what blocks the handover.
 */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const board = src("src/app/(app)/deliveries/page.tsx");
const desktop = board.slice(board.indexOf("<DesktopOnly"), board.indexOf("function FulfilmentCorrections"));
const actions = src("src/app/actions/xero.ts");

test("columns: what stands between the sale and the handover", () => {
  assert.match(board, /type Col = "payment" \| "schedule" \| "deliver" \| "delivered";/);
  assert.match(
    board,
    /quote\.deliveredAt \? "delivered" : !quote\.invoicedAt \|\| !quote\.depositPaidAt \? "payment" : !quote\.deliveryScheduledFor \? "schedule" : "deliver"/,
    "invoice and deposit are one 'Awaiting payment' step",
  );
  for (const title of ["Awaiting payment", "Ready to schedule", "Scheduled", "Delivered this month"]) assert.ok(board.includes(`title: "${title}"`), title);
  // Delivered this month: its own query, same access filter as the live board.
  assert.match(board, /deliveredAt: \{ gte: monthStart \},[\s\S]{0,120}\.\.\.\(quoteIds === null \? \{\} : \{ id: \{ in: quoteIds \} \}\)/);
});

test("each desktop card: chips, ONE next step, the rest behind Details", () => {
  // With Xero connected, sending IS the invoice step; the upload form is the fallback.
  assert.match(desktop, /column\.key === "payment" && !quote\.invoicedAt && \(\s*xeroConnected && quote\.invoiceNumber \? \(\s*<XeroInvoiceControl/);
  assert.match(desktop, /\) : \(\s*<SaveForm success="Invoice recorded"[^>]*action=\{markInvoiced\.bind\(null, quote\.id\)\}/);
  // Deposit: from Xero by Refresh, or by hand behind a link.
  assert.match(desktop, /Refresh records the deposit once Xero shows a payment\./);
  assert.match(desktop, /<ModalTrigger label="Record the deposit by hand"[\s\S]{0,300}action=\{markDepositPaid\.bind\(null, quote\.id\)\}/);
  // Details holds print links, corrections, Xero (when it isn't the next step) and bookings.
  const details = desktop.slice(desktop.indexOf("{/* DETAILS"), desktop.indexOf('{canManage && column.key === "deliver" && ('));
  for (const piece of ["quotePrintLinks(quote)", "<FulfilmentCorrections", '{xeroConnected && column.key !== "payment" && <XeroInvoiceControl', "{deliveryBookings(quote)}"]) {
    assert.ok(details.includes(piece), `Details has ${piece}`);
  }
  // The handover is one button that opens the checklist / signing / photos.
  assert.match(desktop, /label=\{<span className="inline-flex items-center gap-1\.5"><PackageCheck className="size-4" \/> Open handover<\/span>\}/);
  const handover = desktop.slice(desktop.indexOf("Open handover"));
  for (const piece of ["<ChecklistCard", "<GuidedDeliveryCompletion", "<ProofOfDelivery", "<DirectPhotoUploader"]) assert.ok(handover.includes(piece), piece);
});

test("sending to Xero marks the invoice invoiced — in the same transaction that records the send", () => {
  const recorded = actions.slice(actions.indexOf("const recorded = await prisma.$transaction("), actions.indexOf("if (!recorded) {"));
  assert.ok(recorded.indexOf("where: ourClaim") < recorded.indexOf("invoicedAt: null"), "only while our claim stands");
  assert.match(recorded, /tx\.quote\.updateMany\(\{ where: \{ id: quoteId, tenantId, invoicedAt: null \}, data: \{ invoicedAt: new Date\(\) \} \}\)/, "never overwrites an earlier invoice date");
  assert.match(actions, /action: "fulfilment\.invoiced",\s*summary: `Q-\$\{quote\.number\} invoiced — sent to Xero as/);
});

test("the deposit from Xero: what Xero received less the deal's payments, through the locked ledger, never past the total", () => {
  const invoiced = { invoicedAt: new Date(), depositPaidAt: null };
  assert.equal(depositFromXero(invoiced, 5_000_000, 0), 5_000_000, "Xero received R50 000 → that is the deposit");
  assert.equal(depositFromXero(invoiced, 5_000_000, 2_000_000), 3_000_000, "less what's already recorded as payments on the deal");
  assert.equal(depositFromXero(invoiced, 2_000_000, 2_000_000), null, "the deal's payments already account for it");
  assert.equal(depositFromXero(invoiced, 0, 0), null, "nothing received");
  assert.equal(depositFromXero({ invoicedAt: new Date(), depositPaidAt: new Date() }, 5_000_000, 0), null, "deposit already in");
  assert.equal(depositFromXero({ invoicedAt: null, depositPaidAt: null }, 5_000_000, 0), null, "not invoiced");
  assert.equal(readXeroInvoice({ Invoices: [{ InvoiceID: "x", AmountPaid: 50000 }] })?.amountPaidCents, 5_000_000);

  const record = actions.slice(actions.indexOf("async function recordDepositFromXero("), actions.indexOf("async function tryFilePdf("));
  assert.match(record, /const ledger = await lockQuoteLedger\(tx, input\.quoteId, input\.tenantId\);/, "under the same lock as every money change");
  assert.match(record, /if \(cents === null \|\| cents \+ ledger\.paymentsCents > ledger\.totalCents\) return null;/, "never past the CRM invoice's total");
  assert.match(record, /where: \{ id: input\.quoteId, tenantId: input\.tenantId, depositPaidAt: null \}/, "once");
  assert.match(record, /recorded from Xero/, "audited as coming from Xero");
  // Both Refresh paths use it.
  assert.match(actions, /const depositCents = await recordDepositFromXero\(\{ tenantId, quoteId, xeroPaidCents: invoice\.amountPaidCents, user \}\);/);
});

test("Refresh all from Xero: this person's own open invoices in THIS workspace, capped, one failure never hides the rest", () => {
  const all = actions.slice(actions.indexOf("export async function refreshAllXeroInvoices("), actions.indexOf("async function refreshOneFromXero("));
  assert.match(all, /requireAnyPermission\("deliveries\.manage"\)/);
  assert.match(all, /where: \{\s*tenantId,\s*status: "accepted",/);
  assert.match(all, /\.\.\.\(accessible === null \? \{\} : \{ id: \{ in: accessible \} \}\)/);
  assert.match(all, /take: REFRESH_ALL_CAP,/);
  assert.match(all, /failed\.push\(`Q-\$\{quote\.number\}`\);/);
  assert.match(actions, /const REFRESH_ALL_SKIPS = \["PAID", "VOIDED", "DELETED", "SENDING", XERO_UNCONFIRMED\];/, "never refreshes over a send still to settle");
});

test("Invoices page: the board's door, this workspace, only invoices this person may open", () => {
  const page = src("src/app/(app)/invoices/page.tsx");
  assert.match(page, /const user = await requireRoute\("\/invoices"\);/);
  assert.deepEqual(ROUTE_RULES.find((r) => r.prefix === "/invoices"), { prefix: "/invoices", anyOf: ["deliveries.view", "deliveries.manage"] });
  assert.match(page, /where: \{\s*tenantId,\s*status: "accepted",\s*supersededAt: null,\s*invoiceNumber: \{ not: null \},\s*\.\.\.\(quoteIds === null \? \{\} : \{ id: \{ in: quoteIds \} \}\),/);
  assert.match(page, /prisma\.quotePayment\.findMany\(\{\s*where: \{ tenantId, quoteId: \{ in: quotes\.map/);
  // The same money rules the statement and the deal use.
  assert.match(page, /const total = invoiceTotalCents\(quote\);\s*const received = receivedCents\(quote,/);
  assert.match(src("src/components/nav-config.ts"), /if \(can\("deliveries\.view", "deliveries\.manage"\)\) crmLinks\.push\(\{ href: "\/invoices", label: "Invoices"/);
  assert.match(src("src/lib/modules/registry.ts"), /"\/deliveries", "\/invoices",/, "module-gated with the board");
});
