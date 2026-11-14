import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextXeroRefreshBatch, parseXeroDate, planXeroPaymentSync, readXeroInvoice, receivedAfterSync, xeroOwnsPayments, xeroPaymentsComplete } from "../src/lib/xeroInvoice";
import { isPaymentMethod, paymentMethodLabel } from "../src/lib/accountStatement";
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
/** Refresh, the payments sync and the PDF filing — shared by the Refresh buttons and the hourly check. */
const lib = src("src/lib/xeroSync.ts");
const refreshAll = actions.slice(actions.indexOf("export async function refreshAllXeroInvoices("), actions.indexOf("\nexport ", actions.indexOf("export async function refreshAllXeroInvoices(") + 1));

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
  assert.match(desktop, /column\.key === "payment" && !quote\.invoicedAt && \(\s*xeroConnected && quote\.invoiceNumber && !quote\.xeroExcludedAt \? \(\s*<XeroInvoiceControl/);
  assert.match(desktop, /\) : \(\s*<SaveForm success="Invoice recorded"[^>]*action=\{markInvoiced\.bind\(null, quote\.id\)\}/);
  // Deposit: from Xero by Refresh while payments come from Xero; by hand otherwise.
  assert.match(desktop, /\{xeroOwnsPayments\(quote, paymentsFromXero\) \? \(\s*<p[^>]*>Record the payment in Xero, then press Refresh — the first payment becomes the deposit\.<\/p>\s*\) : \(\s*<ModalTrigger label="Record the deposit by hand"/);
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

// ── Payments come from Xero (Sean, 2026-11-11) ──────────────────────────────
// "Invoices get made in CRM, pushed to Xero. Payments get recorded in Xero and pushed back to the CRM."
// "The invoices and statements must match in the CRM. Do not remove the payments functionality."

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
const xp = (id: string, d: number, rand: number, reference: string | null = null) => ({ id, date: day(d), amountCents: rand * 100, reference });
const none = { paidAt: null, cents: null, xeroPaymentId: null, createdFromXero: false };
type Row = { id: string; xeroPaymentId: string | null; amountCents: number; receivedAt: Date; voidedAt: Date | null; createdFromXero: boolean };
const row = (id: string, xeroPaymentId: string | null, rand: number, d: number, extra: Partial<Row> = {}): Row => ({
  id, xeroPaymentId, amountCents: rand * 100, receivedAt: day(d), voidedAt: null, createdFromXero: Boolean(xeroPaymentId), ...extra,
});

test("payments sync: the first Xero payment is the deposit, the rest are payments, and the CRM's received = Xero's", () => {
  const xero = [xp("p2", 5, 30_000, "EFT 2"), xp("p1", 1, 50_000, "EFT 1")];
  const plan = planXeroPaymentSync({ deposit: none, payments: [] }, xero);
  assert.deepEqual(plan.deposit, { kind: "set", xeroPaymentId: "p1", cents: 5_000_000, at: day(1), createdFromXero: true }, "the EARLIEST is the deposit");
  assert.deepEqual(plan.create.map((x) => x.id), ["p2"]);
  assert.equal(receivedAfterSync({ deposit: none, payments: [] }, plan), 8_000_000, "R80 000 — exactly what Xero has");

  // Refresh again with nothing new: nothing changes, nothing comes in twice.
  const after = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: true }, payments: [row("c2", "p2", 30_000, 5)] };
  const again = planXeroPaymentSync(after, xero);
  assert.deepEqual([again.deposit, again.promote, again.create, again.update, again.restore, again.void, again.link], [{ kind: "keep" }, null, [], [], [], [], []]);
  assert.equal(receivedAfterSync(after, again), 8_000_000);
});

test("payments sync: money recorded by hand BEFORE is matched to Xero's, never doubled; what Xero can't account for is said", () => {
  // 1 Oak: deposit and a payment recorded by hand, the same money recorded in Xero → linked, not added again.
  const byHand = {
    deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: null, createdFromXero: false },
    payments: [row("c9", null, 30_000, 4)],
  };
  const plan = planXeroPaymentSync(byHand, [xp("p1", 1, 50_000), xp("p2", 5, 30_000)]);
  assert.deepEqual(plan.deposit, { kind: "link", xeroPaymentId: "p1" });
  assert.deepEqual(plan.link.map((l) => [l.paymentId, l.xero.id]), [["c9", "p2"]]);
  assert.deepEqual(plan.create, [], "nothing duplicated");
  assert.equal(receivedAfterSync(byHand, plan), 8_000_000);
  // A deposit by hand that no Xero payment matches is REPORTED — kept, not dropped, not doubled.
  const odd = planXeroPaymentSync({ deposit: { paidAt: day(1), cents: 4_000_000, xeroPaymentId: null, createdFromXero: false }, payments: [] }, [xp("p1", 1, 50_000)]);
  assert.equal(odd.unmatched.depositCents, 4_000_000);
  assert.deepEqual(odd.create.map((x) => x.id), ["p1"], "Xero's payment still comes in, and the mismatch is said");
});

test("payments sync: removed in Xero → voided here; changed in Xero → corrected", () => {
  const state = {
    deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: true },
    payments: [row("c2", "p2", 30_000, 5), row("c3", "p3", 10_000, 6)],
  };
  const changed = planXeroPaymentSync(state, [xp("p1", 1, 50_000), xp("p2", 5, 35_000)]);
  assert.deepEqual(changed.void, ["c3"], "p3 was removed in Xero");
  assert.deepEqual(changed.update.map((u) => [u.paymentId, u.xero.amountCents]), [["c2", 3_500_000]], "p2 corrected in Xero");
  assert.equal(receivedAfterSync(state, changed), 8_500_000);
  assert.deepEqual(planXeroPaymentSync({ deposit: state.deposit, payments: [] }, []).deposit, { kind: "clear" }, "no payments left in Xero");
});

test("review of #1071 (1): deposit reversed in Xero → the earliest surviving payment BECOMES the deposit, counted once", () => {
  // R50 000 deposit (p1) + R30 000 payment (p2, already a CRM payment record). p1 is reversed in Xero.
  const state = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: true }, payments: [row("c2", "p2", 30_000, 5)] };
  const plan = planXeroPaymentSync(state, [xp("p2", 5, 30_000)]);
  assert.deepEqual(plan.deposit, { kind: "set", xeroPaymentId: "p2", cents: 3_000_000, at: day(5), createdFromXero: true }, "not left in Awaiting payment");
  assert.equal(plan.promote, "c2", "its payment record is retired…");
  assert.deepEqual(plan.void, [], "…not voided as 'removed in Xero'");
  assert.equal(receivedAfterSync(state, plan), 3_000_000, "…and the R30 000 is counted once, = Xero's");
  // The next Refresh leaves it alone.
  const next = { deposit: { paidAt: day(5), cents: 3_000_000, xeroPaymentId: "p2", createdFromXero: true }, payments: [row("c2", "p2", 30_000, 5, { voidedAt: day(9) })] };
  const again = planXeroPaymentSync(next, [xp("p2", 5, 30_000)]);
  assert.deepEqual([again.deposit, again.promote, again.restore, again.create], [{ kind: "keep" }, null, [], []]);
  // A promoted record that was recorded BY HAND keeps that provenance on the deposit.
  const byHand = planXeroPaymentSync({ deposit: state.deposit, payments: [row("c2", "p2", 30_000, 5, { createdFromXero: false })] }, [xp("p2", 5, 30_000)]);
  assert.equal(byHand.deposit.kind === "set" && byHand.deposit.createdFromXero, false);
});

test("re-review of #1071: money recorded BY HAND, matched, then removed in Xero is KEPT — unlinked and reported", () => {
  // A R30 000 payment recorded by hand, matched to Xero's p2; p2 is then removed in Xero.
  const payment = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: true }, payments: [row("c2", "p2", 30_000, 5, { createdFromXero: false })] };
  const p = planXeroPaymentSync(payment, [xp("p1", 1, 50_000)]);
  assert.deepEqual(p.void, [], "never voided");
  assert.deepEqual(p.unlink, ["c2"], "only its Xero link is cleared");
  assert.deepEqual(p.unmatched.payments, [{ id: "c2", amountCents: 3_000_000 }], "and it is reported for reconciling");
  assert.equal(receivedAfterSync(payment, p), 8_000_000, "the CRM still counts it");
  // A R50 000 deposit recorded by hand, matched to Xero's p1; p1 is then removed in Xero.
  const deposit = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: false }, payments: [] };
  const d = planXeroPaymentSync(deposit, [xp("p2", 5, 30_000)]);
  assert.deepEqual(d.deposit, { kind: "unlink" }, "never cleared");
  assert.equal(d.unmatched.depositCents, 5_000_000, "reported");
  assert.deepEqual(d.create.map((x) => x.id), ["p2"], "Xero's own payment still comes in, as a payment");
  assert.equal(receivedAfterSync(deposit, d), 8_000_000);
  // The same, CREATED from Xero: voided / cleared as before.
  assert.deepEqual(planXeroPaymentSync({ ...payment, payments: [row("c2", "p2", 30_000, 5)] }, [xp("p1", 1, 50_000)]).void, ["c2"]);
  assert.deepEqual(planXeroPaymentSync({ deposit: { ...deposit.deposit, createdFromXero: true }, payments: [] }, []).deposit, { kind: "clear" });
  // Applied: the deposit keeps its money, the payment keeps its row.
  const sync = lib.slice(lib.indexOf("async function syncPaymentsFromXero("), lib.indexOf("async function tryFilePdf("));
  assert.match(sync, /if \(d\.kind === "unlink"\) await tx\.quote\.updateMany\(\{ where: ours, data: \{ xeroDepositPaymentId: null, xeroDepositCreated: false \} \}\);/);
  assert.match(sync, /where: \{ id: \{ in: plan\.unlink \}, tenantId: input\.tenantId, quoteId: input\.quoteId \}, data: \{ xeroPaymentId: null \}/);
});

test("re-review of #1071: a hand-recorded payment whose Xero payment is REPLACED (new PaymentID) is re-matched, never counted twice", () => {
  // R30 000 recorded by hand (c2), matched to Xero p2; in Xero p2 is replaced by p5 for the same R30 000.
  const state = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: true }, payments: [row("c2", "p2", 30_000, 5, { createdFromXero: false })] };
  const plan = planXeroPaymentSync(state, [xp("p1", 1, 50_000), xp("p5", 6, 30_000)]);
  assert.deepEqual(plan.link.map((l) => [l.paymentId, l.xero.id]), [["c2", "p5"]], "re-linked to the replacement");
  assert.deepEqual([plan.create, plan.unlink, plan.void, plan.unmatched.payments], [[], [], [], []], "nothing new, nothing lost, nothing reported");
  assert.equal(receivedAfterSync(state, plan), 8_000_000, "R80 000 — counted once, = Xero's");
  // The deposit, the same: recorded by hand, matched to p1, p1 replaced by p6 for the same amount.
  const dep = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: false }, payments: [] };
  const d = planXeroPaymentSync(dep, [xp("p6", 2, 50_000)]);
  assert.deepEqual(d.deposit, { kind: "link", xeroPaymentId: "p6" });
  assert.deepEqual([d.create, d.unmatched.depositCents], [[], null]);
  assert.equal(receivedAfterSync(dep, d), 5_000_000);
  // Replaced by a DIFFERENT amount: not the same money — kept, unlinked, reported; Xero's comes in.
  const differs = planXeroPaymentSync(state, [xp("p1", 1, 50_000), xp("p5", 6, 25_000)]);
  assert.deepEqual([differs.unlink, differs.create.map((x) => x.id)], [["c2"], ["p5"]]);
  // The re-link is applied whatever the old link was.
  const sync = lib.slice(lib.indexOf("async function syncPaymentsFromXero("), lib.indexOf("async function tryFilePdf("));
  assert.match(sync, /where: \{ id: paymentId, tenantId: input\.tenantId, quoteId: input\.quoteId, voidedAt: null \}, data: \{ xeroPaymentId: xero\.id \}/);
});

test("money recorded by hand that Xero split differently: nothing changes, and the message says what's wrong and how to fix it", () => {
  // Q-1037 as it is on live: R100 000 deposit + R156 500 payment by hand; suppose Xero holds ONE R256 500 payment.
  const q1037 = { deposit: { paidAt: day(1), cents: 10_000_000, xeroPaymentId: null, createdFromXero: false }, payments: [row("c1", null, 156_500, 3, { createdFromXero: false })] };
  const plan = planXeroPaymentSync(q1037, [xp("x1", 3, 256_500)]);
  assert.equal(plan.unmatched.depositCents, 10_000_000);
  assert.deepEqual(plan.unmatched.payments, [{ id: "c1", amountCents: 15_650_000 }]);
  assert.ok(receivedAfterSync(q1037, plan) > 25_650_000, "both counted would pass the total → the sync refuses and changes nothing");
  const sync = lib.slice(lib.indexOf("async function syncPaymentsFromXero("), lib.indexOf("async function tryFilePdf("));
  assert.match(sync, /are split differently from Xero's payments \(\$\{xeros\}\), so they can't be matched — counting both would go past the invoice total, so nothing was changed\./);
  assert.match(sync, /untick "Payments come from Xero" in Settings → Integrations → Xero, void the CRM's records on this invoice, tick it again and press Refresh/);
  assert.ok(sync.indexOf("if (handDeposit || handPayments.length)") < sync.indexOf("Xero shows more received"), "the 'Xero has too much' wording is only for when nothing was recorded by hand");
  // The same split, matched one-for-one, changes nothing and counts once.
  const matched = planXeroPaymentSync(q1037, [xp("x1", 1, 100_000), xp("x2", 3, 156_500)]);
  assert.deepEqual([matched.deposit.kind, matched.link.length, matched.create.length], ["link", 1, 0]);
  assert.equal(receivedAfterSync(q1037, matched), 25_650_000);
});

test("review of #1071 (2): a partial answer from Xero changes NOTHING", () => {
  // Xero says R80 000 paid but lists only R50 000 of payments → no sync at all.
  assert.equal(xeroPaymentsComplete({ amountPaidCents: 8_000_000, payments: [xp("p1", 1, 50_000)] }), false);
  assert.equal(xeroPaymentsComplete({ amountPaidCents: 8_000_000, payments: [] }), false, "no details at all");
  assert.equal(xeroPaymentsComplete({ amountPaidCents: 8_000_000, payments: [xp("p1", 1, 50_000), xp("p2", 5, 30_000)] }), true);
  assert.equal(xeroPaymentsComplete({ amountPaidCents: 0, payments: [] }), true, "nothing paid, nothing listed");
  const sync = lib.slice(lib.indexOf("async function syncPaymentsFromXero("), lib.indexOf("async function tryFilePdf("));
  assert.ok(sync.indexOf("if (!xeroPaymentsComplete(input.invoice))") < sync.indexOf("prisma.$transaction("), "checked before anything is written");
  assert.match(sync, /payment details don't add up to that — nothing was changed here/);
});

test("review of #1071 (3): an organisation switch removes only what was BROUGHT IN from Xero; reconnecting restores it", () => {
  const forget = src("src/lib/xero.ts").slice(src("src/lib/xero.ts").indexOf("async function forgetXeroLinks("));
  // Created from Xero → voided, keeping its PaymentID (for a reconnect).
  assert.match(forget, /where: \{ tenantId, xeroPaymentId: \{ not: null \}, method: XERO_PAYMENT_METHOD, voidedAt: null \},\s*data: \{ voidedAt: new Date\(\), voidedByName: "Xero", voidReason:/);
  // Recorded by hand, matched → stays live, only unlinked.
  assert.match(forget, /where: \{ tenantId, xeroPaymentId: \{ not: null \}, NOT: \{ method: XERO_PAYMENT_METHOD \} \},\s*data: \{ xeroPaymentId: null \},/);
  // Deposit created from Xero → cleared; recorded by hand → kept, unlinked.
  assert.match(forget, /where: \{ tenantId, xeroDepositPaymentId: \{ not: null \}, xeroDepositCreated: true \},\s*data: \{ depositPaidAt: null, depositPaidCents: null, xeroDepositPaymentId: null, xeroDepositCreated: false \},/);
  assert.match(forget, /tx\.quote\.updateMany\(\{ where: \{ tenantId, xeroDepositPaymentId: \{ not: null \} \}, data: \{ xeroDepositPaymentId: null \} \}\)/);
  assert.ok(forget.indexOf("xeroDepositCreated: true") < forget.indexOf("data: { xeroDepositPaymentId: null } })"), "created deposits cleared BEFORE the rest are unlinked");
  // Reconnecting the same organisation: the voided copies are restored, not duplicated (the PaymentID is unique).
  const afterSwitch = { deposit: none, payments: [row("c2", "p2", 30_000, 5, { voidedAt: day(10) })] };
  const reconnected = planXeroPaymentSync(afterSwitch, [xp("p1", 1, 50_000), xp("p2", 5, 30_000)]);
  assert.deepEqual(reconnected.deposit, { kind: "set", xeroPaymentId: "p1", cents: 5_000_000, at: day(1), createdFromXero: true });
  assert.deepEqual(reconnected.restore.map((r) => r.paymentId), ["c2"]);
  assert.deepEqual(reconnected.create, [], "never a second record for the same Xero payment");
  assert.equal(receivedAfterSync(afterSwitch, reconnected), 8_000_000);
  // The deposit's provenance is stored with it, and cleared with it.
  const sync = lib.slice(lib.indexOf("async function syncPaymentsFromXero("), lib.indexOf("async function tryFilePdf("));
  assert.match(sync, /xeroDepositCreated: d\.createdFromXero/);
  assert.match(sync, /data: \{ xeroDepositPaymentId: d\.xeroPaymentId, xeroDepositCreated: false \}/, "a matched deposit is recorded-by-hand");
  assert.match(sync, /createdFromXero: p\.method === XERO_PAYMENT_METHOD,/);
});

test("Xero's payments are read from a full invoice, in Xero's own date format", () => {
  const inv = readXeroInvoice({
    Invoices: [{
      InvoiceID: "x", AmountPaid: 80000, AmountCredited: 100,
      Payments: [
        { PaymentID: "p1", Date: "/Date(1762128000000+0000)/", Amount: 50000, Reference: "EFT 1" },
        { PaymentID: "p2", Date: "2026-11-05T00:00:00", Amount: 30000 },
        { PaymentID: "gone", Date: "/Date(1762128000000+0000)/", Amount: 10, Status: "DELETED" },
      ],
    }],
  });
  assert.deepEqual(inv?.payments.map((p) => [p.id, p.amountCents, p.reference]), [["p1", 5_000_000, "EFT 1"], ["p2", 3_000_000, null]]);
  assert.equal(inv?.payments[0].date.toISOString(), "2025-11-03T00:00:00.000Z");
  assert.equal(inv?.amountPaidCents, 8_000_000);
  assert.equal(inv?.amountCreditedCents, 10_000, "credits are said, not brought as payments");
  assert.equal(parseXeroDate("nonsense"), null);
});

test("the sync runs under the ledger lock, only for the still-linked invoice, never past the total, only while payments come from Xero", () => {
  const sync = lib.slice(lib.indexOf("async function syncPaymentsFromXero("), lib.indexOf("async function tryFilePdf("));
  assert.match(sync, /if \(!\(await paymentsComeFromXero\(input\.tenantId\)\)\) return null;/);
  assert.match(sync, /const ledger = await lockQuoteLedger\(tx, input\.quoteId, input\.tenantId\);\s*if \(!ledger \|\| ledger\.quote\.xeroInvoiceId !== input\.invoice\.id\) return null;/, "an organisation switch in between brings nothing (review of #1071)");
  assert.match(sync, /if \(receivedAfterSync\(state, plan\) > ledger\.totalCents\) return \{ kind: "too-much"/);
  assert.match(sync, /const ours = \{ id: input\.quoteId, tenantId: input\.tenantId, xeroInvoiceId: input\.invoice\.id \};/, "every write names the invoice");
  assert.match(sync, /xeroPaymentId: x\.id,/, "each payment remembers its Xero PaymentID");
  assert.match(sync, /voidReason: "Removed in Xero"/);
  assert.match(src("prisma/schema.prisma"), /@@unique\(\[tenantId, xeroPaymentId\]\)/, "and the database refuses the same Xero payment twice");
  // Both paths: Refresh, and an invoice adopted on send (its full read — a search result has no payments).
  assert.match(lib, /const fromXero = await syncPaymentsFromXero\(\{ tenantId, quoteId, invoice, user \}\);/);
  assert.match(actions, /\.getInvoice\(invoice\.id\)\s*\.then\(\(full\) => syncPaymentsFromXero\(\{ tenantId, quoteId, invoice: full, user \}\)\)/);
  // Refresh all still takes a PAID invoice whose payments were never brought back.
  assert.match(lib, /OR: \[\s*\{ xeroStatus: \{ notIn: REFRESH_ALL_SKIPS \} \},\s*\{ xeroStatus: "PAID", xeroAmountPaidCents: null \},/);
});

test("the CRM's own payment forms stay — refused only for an invoice IN Xero while payments come from Xero; a switch brings them back", () => {
  const inXero = { xeroInvoiceId: "x-1", xeroStatus: "AUTHORISED" };
  assert.match(xeroOwnsPayments(inXero, true) ?? "", /come from Xero — record it in Xero, then press Refresh/);
  assert.equal(xeroOwnsPayments(inXero, false), null, "switched back to the CRM: the forms work as before");
  assert.equal(xeroOwnsPayments({ xeroInvoiceId: null, xeroStatus: null }, true), null, "an invoice not in Xero: the forms work");
  assert.equal(xeroOwnsPayments({ xeroInvoiceId: "x-1", xeroStatus: "VOIDED" }, true), null, "voided in Xero: back to the CRM");
  // Every hand-recording path asks it, on the row read under the ledger lock.
  const ledger = src("src/lib/quoteLedger.ts");
  assert.equal((ledger.match(/const xeroOwns = xeroOwnsPayments\(ledger\.quote, input\.paymentsFromXero\);\s*if \(xeroOwns\) refuse\(xeroOwns\);/g) ?? []).length, 2, "record AND void a payment");
  assert.match(ledger, /paymentsFromXero: boolean;/, "a required input: no caller can forget it");
  const fulfilment = src("src/app/actions/fulfilment.ts");
  assert.equal((fulfilment.match(/const xeroOwns = xeroOwnsPayments\(ledger\.quote, paymentsFromXero\);\s*if \(xeroOwns\) refuse\(xeroOwns\);/g) ?? []).length, 2, "record AND correct the deposit");
  // Visible and switchable (nothing hidden from the UI): Settings → Integrations → Xero.
  assert.match(src("src/app/(app)/settings/integrations/page.tsx"), /<input type="checkbox" name="fromXero" defaultChecked=\{paymentsFromXero\}/);
  assert.match(actions, /await putWorkspaceSetting\(tenantId, XERO_PAYMENTS_SOURCE_KEY, fromXero \? "xero" : "crm"\);/, "per workspace, by name");
  // A Xero payment is labelled as such on the statement, but is never one of the CRM form's choices.
  assert.equal(paymentMethodLabel("xero"), "Recorded in Xero");
  assert.ok(!isPaymentMethod("xero"));
});


test("an invoice linked to Xero before the invoice step existed is marked invoiced by Refresh — never over a date", () => {
  // Review of #1071: xeroInvoiceId set, invoicedAt null → stuck in Awaiting payment, no deposit possible.
  const one = lib.slice(lib.indexOf("async function refreshOneFromXero("));
  assert.match(one, /where: \{ id: quoteId, tenantId, xeroInvoiceId: invoice\.id, invoicedAt: null \},\s*data: \{ invoicedAt: new Date\(\) \},/);
  assert.ok(one.indexOf("if (xeroInvoiceCancelled(invoice.status))") < one.indexOf("invoicedAt: null"), "a voided invoice doesn't count");
  assert.ok(one.indexOf("invoicedAt: null") < one.indexOf("syncPaymentsFromXero("), "invoiced first, so the payments can follow in the same Refresh");
});

test("Refresh all advances: 30 open invoices are all reached in two presses", () => {
  // Review of #1071: ordered by when it was SENT, every press took the same oldest 25.
  const base = Date.parse("2026-11-01T00:00:00Z");
  let rows = Array.from({ length: 30 }, (_, i) => ({ id: `q${String(i).padStart(2, "0")}`, xeroCheckedAt: null as Date | null }));
  const press = (now: number) => {
    const batch = nextXeroRefreshBatch(rows, 25);
    const taken = new Set(batch.map((r) => r.id));
    rows = rows.map((r) => (taken.has(r.id) ? { ...r, xeroCheckedAt: new Date(now) } : r)); // marked tried, success or not
    return batch.map((r) => r.id);
  };
  const first = press(base + 1000);
  const second = press(base + 2000);
  assert.equal(first.length, 25);
  assert.deepEqual(new Set([...first, ...second]).size, 30, "every invoice reached");
  for (const id of rows.filter((r) => !first.includes(r.id)).map((r) => r.id)) assert.ok(second.includes(id), `${id} reached on the second press`);
  // The action: marks the batch tried BEFORE trying it, and picks with the same function.
  const all = refreshAll;
  assert.match(all, /const quotes = nextXeroRefreshBatch\(open, REFRESH_ALL_CAP\);/);
  assert.ok(all.indexOf("data: { xeroCheckedAt: new Date() }") < all.indexOf("for (const quote of quotes)"), "marked tried before the attempts");
  assert.match(src("prisma/schema.prisma"), /xeroCheckedAt\s+DateTime\?/);
});

test("Refresh all from Xero: this person's own open invoices in THIS workspace, capped, one failure never hides the rest", () => {
  const all = refreshAll;
  assert.match(all, /requireAnyPermission\("deliveries\.manage"\)/);
  assert.match(all, /where: openXeroInvoicesWhere\(tenantId, accessible\),/);
  const where = lib.slice(lib.indexOf("export function openXeroInvoicesWhere("));
  assert.match(where, /return \{\s*tenantId,\s*status: "accepted",/);
  assert.match(where, /\.\.\.\(accessible === null \? \{\} : \{ id: \{ in: accessible \} \}\)/);
  assert.match(all, /nextXeroRefreshBatch\(open, REFRESH_ALL_CAP\)/);
  assert.match(all, /failed\.push\(`Q-\$\{quote\.number\}`\);/);
  assert.match(lib, /const REFRESH_ALL_SKIPS = \["PAID", "VOIDED", "DELETED", "SENDING", XERO_UNCONFIRMED\];/, "never refreshes over a send still to settle");
});

test("the daily automatic Xero check: Refresh's own routine, per workspace, visible and switchable, never files a PDF", () => {
  // Sean, 2026-11-11: "An automatic background check of Xero for payments. Today it happens when someone presses Refresh."
  // 2026-11-13: "once a day, not once an hour" — 04:40 UTC, 06:40 in South Africa, before the working day.
  assert.match(src("vercel.json"), /"path": "\/api\/cron\/xero-payments",\s*"schedule": "40 4 \* \* \*"/);
  const route = src("src/app/api/cron/xero-payments/route.ts");
  assert.match(route, /if \(!isAuthorizedCron\(req\)\) return/);
  assert.match(route, /runCronPerTenant\(/, "each workspace in its own scope");
  const run = lib.slice(lib.indexOf("export async function runAutomaticXeroCheck("), lib.indexOf("export function openXeroInvoicesWhere("));
  const order = [
    "if (!(await paymentsComeFromXero(tenantId))) return { skipped:",
    "if ((await getWorkspaceSetting(tenantId, XERO_AUTO_CHECK_KEY)) === \"off\") return { skipped: \"switched-off\" };",
    "where: openXeroInvoicesWhere(tenantId, null, {",
    "nextXeroRefreshBatch(open, REFRESH_ALL_CAP)",
    "data: { xeroCheckedAt: new Date() }",
    "await refreshOneFromXero(client, tenantId, quote.id, null);",
    "putWorkspaceSetting(tenantId, XERO_AUTO_CHECKED_AT_KEY,",
  ].map((s) => run.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `gated, picked like Refresh all, marked tried, then refreshed as nobody: ${order}`);
  assert.match(run, /if \(shouldStop\(\)\) break;/, "stops before the run's time is up");
  // No person → no PDF filed; a person's next Refresh files the newer one (xeroPdfStatus).
  const one = lib.slice(lib.indexOf("export async function refreshOneFromXero("));
  assert.match(one, /const pdfFiled = user && pdfStale \? await tryFilePdf\(/);
  assert.match(one, /quote\.xeroPdfStatus !== invoice\.status/);
  assert.match(lib.slice(lib.indexOf("async function fileXeroPdf("), lib.indexOf("export async function tryFilePdf(")), /xeroPdfStatus: input\.invoice\.status/);
  assert.match(src("prisma/schema.prisma"), /xeroPdfStatus\s+String\?/);
  // Visible and switchable, per workspace; on the automatic jobs page.
  const page = src("src/app/(app)/settings/integrations/page.tsx");
  assert.match(page, /\{paymentsFromXero && \(/, "shown only while payments come from Xero");
  assert.match(page, /<input type="checkbox" name="autoCheck" defaultChecked=\{xeroAutoCheck\}/);
  assert.match(actions, /putWorkspaceSetting\(tenantId, XERO_AUTO_CHECK_KEY, autoCheck \? "on" : "off"\)/);
  assert.match(actions, /action: "xero\.auto_check"/);
});

test("review of #1073: a PAID invoice whose payment is reversed in Xero is looked at again, and comes back unpaid", () => {
  // The daily check looks again at PAID invoices each run, inside the same capped batch — but only for their first
  // 30 days in Xero (Sean, 2026-11-13: "checked everytime until the rest of time?" — no).
  const where = lib.slice(lib.indexOf("export function openXeroInvoicesWhere("), lib.indexOf("export async function refreshOneFromXero("));
  assert.match(where, /\[\{ xeroStatus: "PAID", xeroSentAt: \{ gte: paid\.sentAfter \}, OR: \[\{ xeroCheckedAt: null \}, \{ xeroCheckedAt: \{ lt: paid\.checkedBefore \} \}\] \}\]/);
  assert.match(lib, /export const XERO_PAID_RECHECK_DAYS = 30;/);
  const run = lib.slice(lib.indexOf("export async function runAutomaticXeroCheck("), lib.indexOf("export function openXeroInvoicesWhere("));
  assert.match(run, /checkedBefore: new Date\(Date\.now\(\) - XERO_PAID_REVISIT_MS\),\s*sentAfter: new Date\(Date\.now\(\) - XERO_PAID_RECHECK_DAYS \* 24 \* 60 \* 60 \* 1000\),/);
  // A little under a day, so a run that starts a few minutes earlier than yesterday's still includes them.
  assert.match(lib, /export const XERO_PAID_REVISIT_MS = 20 \* 60 \* 60 \* 1000;/);
  assert.match(refreshAll, /where: openXeroInvoicesWhere\(tenantId, accessible\),/, "a person's Refresh all is unchanged");
  // A paid invoice checked yesterday is picked before open ones checked an hour ago — it's the longest-ago tried.
  const now = Date.parse("2026-11-12T12:00:00Z");
  const batch = nextXeroRefreshBatch(
    [
      { id: "open-recent", xeroCheckedAt: new Date(now - 3_600_000) },
      { id: "paid-yesterday", xeroCheckedAt: new Date(now - 25 * 3_600_000) },
    ],
    1,
  );
  assert.deepEqual(batch.map((q) => q.id), ["paid-yesterday"]);
  // Xero now holds only the deposit — the R30 000 payment was reversed. Brought from Xero: voided here, and the total drops.
  const paid = { deposit: { paidAt: day(1), cents: 5_000_000, xeroPaymentId: "p1", createdFromXero: true }, payments: [row("c2", "p2", 30_000, 5)] };
  const reversed = planXeroPaymentSync(paid, [xp("p1", 1, 50_000)]);
  assert.deepEqual(reversed.void, ["c2"], "the reversed payment is voided in the CRM");
  assert.equal(receivedAfterSync(paid, reversed), 5_000_000, "received = what Xero still holds");
  assert.equal(xeroPaymentsComplete({ amountPaidCents: 5_000_000, payments: [xp("p1", 1, 50_000)] }), true, "and that answer is complete, so it is applied");
  // Everything reversed: the deposit brought from Xero is cleared too.
  assert.deepEqual(planXeroPaymentSync(paid, []).deposit, { kind: "clear" });
});

test("Invoices page: deposit, payments and the statement from each row — the deal page's own panel and rules", () => {
  // Sean, 2026-11-11: "In the invoice page, can we have the option to record deposits, payments and get statements?"
  const page = src("src/app/(app)/invoices/page.tsx");
  assert.match(page, /<DealPayments quote=\{quote\} payments=\{own\} canRecord=\{canManage\} fromXero=\{fromXero\} statementHref=\{statementHref\} today=\{today\} moneyFmt=\{fmt\} \/>/);
  assert.match(page, /canManage && !fromXero && !quote\.depositPaidAt && \(\s*quote\.invoicedAt \? \(\s*<SaveForm success="Deposit recorded"[^>]*action=\{markDepositPaid\.bind\(null, quote\.id\)\}/, "deposit by hand only once invoiced, behind deliveries.manage, and not when Xero owns it");
  assert.match(page, /const xeroDiffers = fromXero && quote\.xeroAmountPaidCents != null && quote\.xeroAmountPaidCents !== received;/, "the CRM says when its figure differs from Xero's");
  // The statement link only where this person can open it — the deal page's rule.
  assert.match(page, /billTo\.isFleet && quote\.fleetId\s*\? canSeeFleets \? `\/fleets\/\$\{quote\.fleetId\}\/statement\$\{currency\}` : null\s*: quote\.contactId && openableContacts\.has\(quote\.contactId\)/);
  assert.match(page, /prisma\.quotePayment\.findMany\(\{ where: \{ tenantId, quoteId: \{ in: quotes\.map/, "payments from this workspace only");
  // Recording either refreshes the Invoices page.
  assert.match(src("src/app/actions/quotePayments.ts"), /revalidatePath\("\/deliveries"\);\s*revalidatePath\("\/invoices"\);/);
  assert.match(src("src/app/actions/fulfilment.ts"), /revalidatePath\("\/deliveries"\); revalidatePath\("\/invoices"\);/);
});

test("'Not for Xero': a historical invoice, marked by hand, is never offered to or sent to Xero; Undo takes it back", () => {
  // Sean, 2026-11-11: INV-043153 / INV-043152 "are historical and were processed in a different way… Their invoices do not belong in Xero."
  const set = actions.slice(actions.indexOf("export async function setNotForXero("), actions.indexOf("export async function setXeroPaymentsSource("));
  assert.match(set, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  assert.match(set, /if \(quote\.xeroInvoiceId && !xeroInvoiceCancelled\(quote\.xeroStatus\)\) refuse\(/, "an invoice already in Xero is voided there first");
  assert.match(set, /if \(xeroSendUncertain\(quote\.xeroStatus\)\) refuse\(/, "not mid-send");
  assert.match(set, /\{ id: quoteId, tenantId, xeroExcludedAt: null, xeroInvoiceId: quote\.xeroInvoiceId, xeroStatus: quote\.xeroStatus \}/, "the write re-checks what was read");
  assert.match(set, /action: exclude \? "quote\.not_for_xero" : "quote\.for_xero_again"/, "audited both ways");
  // Sending refuses it — on the read AND in the claim.
  assert.match(actions, /if \(quote\.xeroExcludedAt\) refuse\(`\$\{formatInvoiceNumber\(quote\.invoiceNumber\)\} is marked "Not for Xero"/);
  assert.match(actions, /invoiceNumber: \{ not: null \},\s*xeroExcludedAt: null,\s*xeroInvoiceId: quote\.xeroInvoiceId,/);
  // Shown as "Not for Xero · Undo" instead of the send button; offered beside it otherwise.
  const control = src("src/components/XeroInvoiceControl.tsx");
  assert.ok(control.indexOf("if (quote.xeroExcludedAt)") < control.indexOf("const sendButton"), "a marked invoice never shows the send button");
  assert.match(control, /setNotForXero\.bind\(null, quote\.id, false\)/);
  assert.match(control, /setNotForXero\.bind\(null, quote\.id, true\)/);
  // Not counted as waiting for Xero; the board's invoice step falls back to the upload.
  assert.match(src("src/app/(app)/invoices/page.tsx"), /const notInXero = rows\.filter\(\(r\) => !r\.quote\.xeroInvoiceId && !r\.quote\.xeroExcludedAt\);/);
  assert.match(board, /xeroConnected && quote\.invoiceNumber && !quote\.xeroExcludedAt \? \(/);
  // Its payments work as before: not in Xero, so xeroOwnsPayments never refuses them.
  assert.equal(xeroOwnsPayments({ xeroInvoiceId: null, xeroStatus: null }, true), null);
});

test("Invoices page: the board's door, this workspace, only invoices this person may open", () => {
  const page = src("src/app/(app)/invoices/page.tsx");
  assert.match(page, /const user = await requireRoute\("\/invoices"\);/);
  assert.deepEqual(ROUTE_RULES.find((r) => r.prefix === "/invoices"), { prefix: "/invoices", anyOf: ["deliveries.view", "deliveries.manage"] });
  assert.match(page, /where: \{\s*tenantId,\s*status: "accepted",\s*supersededAt: null,\s*invoiceNumber: \{ not: null \},\s*\.\.\.\(quoteIds === null \? \{\} : \{ id: \{ in: quoteIds \} \}\),/);
  // The same money rules the statement and the deal use.
  assert.match(page, /const total = invoiceTotalCents\(quote\);[\s\S]{0,120}const received = receivedCents\(quote, own\);/);
  assert.match(src("src/components/nav-config.ts"), /if \(can\("deliveries\.view", "deliveries\.manage"\)\) salesLinks\.push\(\{ href: "\/invoices", label: "Invoices"/);
  assert.match(src("src/lib/modules/registry.ts"), /"\/deliveries", "\/invoices",/, "module-gated with the board");
});
