import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAccountStatement,
  isStatementInvoice,
  outstandingCents,
  receivedCents,
  statementInvoiceDate,
  statementInvoiceLabel,
  type StatementPayment,
  type StatementQuote,
} from "../src/lib/accountStatement";

/*
 * A customer statement must be accurate after deposits: invoice total, less the
 * deposit recorded on the deliveries board, less every later payment recorded on
 * the deal — and nothing it cannot place may silently change the balance.
 */

const day = (iso: string) => new Date(`${iso}T09:00:00.000Z`);

function quote(overrides: Partial<StatementQuote> = {}): StatementQuote {
  return {
    id: "q1",
    number: 101,
    status: "accepted",
    invoiceNumber: 512_340,
    invoicedAt: day("2026-09-01"),
    signedAt: null,
    createdAt: day("2026-08-20"),
    deletedAt: null,
    supersededAt: null,
    depositPaidAt: null,
    depositPaidCents: null,
    taxInclusive: true,
    depositType: "percent",
    depositValue: 10,
    // R200 000 cart + R5 000 delivery, VAT inclusive → payable R205 000.
    items: [{ qty: 1, unitPriceCents: 20_000_000, taxRatePct: 15 }],
    fees: [{ amountCents: 500_000, taxRatePct: 15 }],
    ...overrides,
  };
}

function payment(overrides: Partial<StatementPayment> = {}): StatementPayment {
  return {
    id: "p1",
    quoteId: "q1",
    amountCents: 10_000_000,
    receivedAt: day("2026-09-20"),
    method: "eft",
    reference: "FNB 4471",
    voidedAt: null,
    ...overrides,
  };
}

test("invoice total includes fees and delivery — the payable figure, not the line subtotal", () => {
  const statement = buildAccountStatement([quote()], []);
  assert.equal(statement.totalInvoicedCents, 20_500_000);
  assert.equal(statement.balanceCents, 20_500_000);
  assert.equal(statement.lines.length, 1);
  assert.equal(statement.lines[0].kind, "invoice");
  assert.equal(statement.lines[0].invoiceLabel, "INV-512340");
});

test("the recorded deposit is deducted, using the amount RECEIVED, not the deposit terms", () => {
  // Terms say 10% (R20 500) but the customer actually paid R25 000.
  const q = quote({ depositPaidAt: day("2026-09-05"), depositPaidCents: 2_500_000 });
  const statement = buildAccountStatement([q], []);
  assert.equal(statement.totalPaidCents, 2_500_000);
  assert.equal(statement.balanceCents, 20_500_000 - 2_500_000);
  assert.deepEqual(statement.lines.map((line) => [line.kind, line.balanceCents]), [
    ["invoice", 20_500_000],
    ["deposit", 18_000_000],
  ]);
});

test("deposit plus later payments settle the invoice to exactly zero", () => {
  const q = quote({ depositPaidAt: day("2026-09-05"), depositPaidCents: 2_500_000 });
  const statement = buildAccountStatement([q], [
    payment({ id: "p1", amountCents: 10_000_000, receivedAt: day("2026-09-20") }),
    payment({ id: "p2", amountCents: 8_000_000, receivedAt: day("2026-10-01"), method: "finance", reference: null }),
  ]);
  assert.equal(statement.totalPaidCents, 20_500_000);
  assert.equal(statement.balanceCents, 0);
  assert.equal(statement.invoices[0].outstandingCents, 0);
  assert.equal(statement.lines.at(-1)?.balanceCents, 0);
  assert.deepEqual(statement.warnings, []);
});

test("a voided payment is kept on the record but counts for nothing", () => {
  const statement = buildAccountStatement([quote()], [payment({ voidedAt: day("2026-09-21") })]);
  assert.equal(statement.totalPaidCents, 0);
  assert.equal(statement.balanceCents, 20_500_000);
  assert.ok(statement.lines.every((line) => line.kind === "invoice"));
});

test("a deposit marked received WITHOUT an amount is not guessed — it is flagged for staff", () => {
  const q = quote({ depositPaidAt: day("2026-09-05"), depositPaidCents: null });
  const statement = buildAccountStatement([q], []);
  assert.equal(statement.totalPaidCents, 0, "the expected deposit must not be assumed paid");
  assert.equal(statement.balanceCents, 20_500_000);
  assert.equal(statement.warnings.length, 1);
  assert.match(statement.warnings[0], /without an amount/);
});

test("only accepted, live quotes are invoices — drafts, cancelled, superseded and trashed are not", () => {
  assert.equal(isStatementInvoice({ status: "accepted", deletedAt: null, supersededAt: null }), true);
  assert.equal(isStatementInvoice({ status: "sent", deletedAt: null, supersededAt: null }), false);
  assert.equal(isStatementInvoice({ status: "cancelled", deletedAt: null, supersededAt: null }), false);
  assert.equal(isStatementInvoice({ status: "accepted", deletedAt: day("2026-09-02"), supersededAt: null }), false);
  assert.equal(isStatementInvoice({ status: "accepted", deletedAt: null, supersededAt: day("2026-09-02") }), false);

  const statement = buildAccountStatement(
    [quote(), quote({ id: "q2", number: 102, status: "sent", invoiceNumber: null })],
    [],
  );
  assert.equal(statement.invoices.length, 1);
  assert.equal(statement.totalInvoicedCents, 20_500_000);
});

test("money held on a quote that is no longer an invoice is never silently dropped", () => {
  const cancelled = quote({ id: "q2", number: 102, status: "cancelled", depositPaidAt: day("2026-09-05"), depositPaidCents: 1_000_000 });
  const statement = buildAccountStatement([quote(), cancelled], [payment({ id: "p9", quoteId: "q2", amountCents: 50_000 })]);
  // Off the customer's figures — we cannot say what that money should do to them…
  assert.equal(statement.totalPaidCents, 0);
  assert.equal(statement.balanceCents, 20_500_000);
  // …but staff are told, with the amount.
  assert.equal(statement.warnings.length, 1);
  assert.match(statement.warnings[0], /Q-102 is cancelled/);
  assert.match(statement.warnings[0], /10500\.00/);
});

test("an overpaid invoice shows a credit and warns", () => {
  const statement = buildAccountStatement([quote()], [payment({ amountCents: 21_000_000 })]);
  assert.equal(statement.balanceCents, -500_000);
  assert.match(statement.warnings.join(" "), /more than its total/);
});

test("lines run in date order across invoices, invoice before payment on the same day", () => {
  const first = quote({ id: "a", number: 1, invoiceNumber: 10, invoicedAt: day("2026-08-01") });
  const second = quote({
    id: "b",
    number: 2,
    invoiceNumber: 11,
    invoicedAt: day("2026-09-01"),
    items: [{ qty: 2, unitPriceCents: 100_000, taxRatePct: 15 }],
    fees: [],
  });
  const statement = buildAccountStatement(
    [second, first],
    [
      payment({ id: "same-day", quoteId: "b", amountCents: 50_000, receivedAt: day("2026-09-01") }),
      payment({ id: "early", quoteId: "a", amountCents: 1_000_000, receivedAt: day("2026-08-15") }),
    ],
  );
  assert.deepEqual(
    statement.lines.map((line) => line.key),
    ["invoice:a", "payment:early", "invoice:b", "payment:same-day"],
  );
  assert.deepEqual(
    statement.lines.map((line) => line.balanceCents),
    [20_500_000, 19_500_000, 19_700_000, 19_650_000],
  );
  assert.equal(statement.balanceCents, 19_650_000);
  assert.deepEqual(statement.invoices.map((invoice) => invoice.invoiceLabel), ["INV-000010", "INV-000011"]);
});

test("a payment for a quote not on the account is reported, not lost", () => {
  const statement = buildAccountStatement([quote()], [payment({ quoteId: "elsewhere" })]);
  assert.equal(statement.totalPaidCents, 0);
  assert.match(statement.warnings.join(" "), /not on this account/);
});

test("labels and dates fall back sensibly for older invoices", () => {
  assert.equal(statementInvoiceLabel({ number: 45, invoiceNumber: null }), "Q-45");
  assert.equal(statementInvoiceLabel({ number: 45, invoiceNumber: 7 }), "INV-000007");
  assert.equal(statementInvoiceDate({ invoicedAt: null, signedAt: day("2026-09-09"), createdAt: day("2026-09-01") }).toISOString(), day("2026-09-09").toISOString());
  assert.equal(statementInvoiceDate({ invoicedAt: null, signedAt: null, createdAt: day("2026-09-01") }).toISOString(), day("2026-09-01").toISOString());
});

test("receivedCents / outstandingCents agree with the statement", () => {
  const q = quote({ depositPaidAt: day("2026-09-05"), depositPaidCents: 2_500_000 });
  const pays = [payment(), payment({ id: "void", voidedAt: day("2026-09-30") })];
  assert.equal(receivedCents(q, pays), 12_500_000);
  assert.equal(outstandingCents(q, pays), 8_000_000);
  assert.equal(buildAccountStatement([q], pays).invoices[0].outstandingCents, 8_000_000);
});

test("tax-exclusive invoices are billed incl. VAT", () => {
  const q = quote({ taxInclusive: false, items: [{ qty: 1, unitPriceCents: 100_000, taxRatePct: 15 }], fees: [] });
  assert.equal(buildAccountStatement([q], []).totalInvoicedCents, 115_000);
});
