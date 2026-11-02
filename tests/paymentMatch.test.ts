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
