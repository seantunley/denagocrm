import test from "node:test";
import assert from "node:assert/strict";
import { rankPaymentMatches, type PaymentCandidate } from "../src/lib/paymentMatch";

const quote = (quoteNumber: number, over: Partial<PaymentCandidate> = {}): PaymentCandidate => ({
  quoteNumber, invoiceNumber: null, customerNames: ["Anna", "Smith", null], owingCents: 10_000_000, depositDueCents: 0, ...over,
});
const numbers = (r: ReturnType<typeof rankPaymentMatches>) => r.matches.map((m) => m.candidate.quoteNumber);

test("the deposit due, on one quote: one clear match", () => {
  const r = rankPaymentMatches([quote(1030, { depositDueCents: 2_500_000 }), quote(1031, { customerNames: ["Ben"] })], { amountCents: 2_500_000 });
  assert.equal(r.clear?.candidate.quoteNumber, 1030);
  assert.deepEqual(r.clear?.reasons, ["deposit"]);
  assert.deepEqual(numbers(r), [1030]);
});

test("the balance owing: one clear match", () => {
  const r = rankPaymentMatches([quote(1030, { owingCents: 7_500_000 }), quote(1031)], { amountCents: 7_500_000 });
  assert.deepEqual(r.clear?.reasons, ["balance"]);
  assert.equal(r.clear?.candidate.quoteNumber, 1030);
});

test("the reference names the invoice or the quote, in the ways a bank line writes it", () => {
  const list = [quote(1030, { invoiceNumber: 15 }), quote(1031, { invoiceNumber: 16 })];
  for (const reference of ["INV-000015", "inv15", "Q-1030", "q1030 anna", "1030"]) {
    const r = rankPaymentMatches(list, { amountCents: 100_00, reference });
    assert.equal(r.clear?.candidate.quoteNumber, 1030, reference);
  }
  // "INV" names an invoice number only: invoice 1031 is not quote Q-1031.
  assert.equal(rankPaymentMatches(list, { amountCents: 100_00, reference: "INV1031" }).matches.length, 0);
});

test("a reference names a quote only when written as one (review of #942)", () => {
  const list = [quote(1030, { invoiceNumber: 1030 }), quote(2026, { invoiceNumber: 2026 }), quote(11, { invoiceNumber: 11 }), quote(2, { invoiceNumber: 2 }),
    quote(25, { invoiceNumber: 25 }), quote(123456, { invoiceNumber: 123456 })];
  const named = (reference: string) => rankPaymentMatches(list, { amountCents: 100_00, reference }).matches.map((m) => m.candidate.quoteNumber);
  for (const reference of ["Q-1030", "Q1030", "q 1030", "INV1030", "INV-1030", "INV-001030", "quote 1030", "Quote1030", "invoice 1030", "Invoice no. 1030", "invoice #1030", "1030", " #1030 ", "Anna Q1030 deposit"]) {
    assert.deepEqual(named(reference), [1030], reference);
  }
  for (const reference of [
    "Payment 2026-11-02", "2026-11-02", "02/11/2026", "2/11/2026", "2 Nov 2026", "02.11.2026", "Q-2026-11-02", // dates
    "FNB 1234567890", "Ref 000123456789", "000123456789", "TRF 20261102123456", "ABSA 123456 REF", // bank references
    "R25 000", "25000.00", "R 25,000.00", "Q 25,000", // amounts
    "0821234567", "+27 82 123 4567", "Acc 62012345678", "Anna 1030 deposit", "SEQ1030", // phones, accounts, stray digits
  ]) {
    assert.deepEqual(named(reference), [], reference);
  }
});

test("two quotes owing the same amount: both offered, no single pick", () => {
  const r = rankPaymentMatches([quote(1030, { depositDueCents: 2_500_000 }), quote(1031, { owingCents: 2_500_000 })], { amountCents: 2_500_000 });
  assert.equal(r.clear, null);
  assert.deepEqual(numbers(r).sort(), [1030, 1031]);
});

test("the same amount on two, the reference or the payer settles it", () => {
  const two = [quote(1030, { depositDueCents: 2_500_000 }), quote(1031, { depositDueCents: 2_500_000, customerNames: ["Ben", "Botha"] })];
  assert.equal(rankPaymentMatches(two, { amountCents: 2_500_000, reference: "INV1031 X" }).clear, null, "INV1031 is no invoice here");
  assert.equal(rankPaymentMatches(two, { amountCents: 2_500_000, reference: "Q1031" }).clear?.candidate.quoteNumber, 1031);
  assert.equal(rankPaymentMatches(two, { amountCents: 2_500_000, payer: "MR B BOTHA" }).clear?.candidate.quoteNumber, 1031);
});

test("conflicting evidence (amount says one, reference another) is a choice, never a guess", () => {
  const r = rankPaymentMatches([quote(1030, { depositDueCents: 2_500_000 }), quote(1031)], { amountCents: 2_500_000, reference: "Q1031" });
  assert.equal(r.clear, null);
  assert.deepEqual(numbers(r), [1031, 1030]);
});

test("the payer's name alone is offered, never a clear match", () => {
  const r = rankPaymentMatches([quote(1030)], { amountCents: 1_000_00, payer: "A SMITH" });
  assert.deepEqual(numbers(r), [1030]);
  assert.equal(r.clear, null);
  // Bank noise names nobody.
  assert.equal(rankPaymentMatches([quote(1030, { customerNames: ["Smith Trading (Pty) Ltd"] })], { amountCents: 1_000_00, payer: "JONES TRADING PTY LTD" }).matches.length, 0);
});

test("nothing owing, or more than is owing: never offered", () => {
  const r = rankPaymentMatches([quote(1030, { owingCents: 0 }), quote(1031, { owingCents: 1_000_000 })], { amountCents: 2_000_000, reference: "Q1031" });
  assert.equal(r.matches.length, 0);
  assert.equal(r.clear, null);
});
