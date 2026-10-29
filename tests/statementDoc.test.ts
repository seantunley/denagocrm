import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAccountStatement, type StatementQuote } from "../src/lib/accountStatement";
import { statementAccountLines, statementDocTokens, statementRows } from "../src/lib/statementDoc";
import type { QuoteBillTo } from "../src/lib/quoteBillTo";

/*
 * The statement printed from the document editor (Settings → Documents →
 * Statement) is filled from these values. They are the statement's own figures,
 * formatted — nothing here re-computes a balance.
 */

const day = (iso: string) => new Date(`${iso}T09:00:00.000Z`);
// en-ZA money uses non-breaking spaces between digit groups; compare as plain text.
const plain = (value: string | undefined) => (value ?? "").replace(/[\u00A0\u202F]/g, " ");
const quote = (overrides: Partial<StatementQuote> = {}): StatementQuote => ({
  id: "q1", number: 101, status: "accepted", invoiceNumber: 512_340, invoicedAt: day("2026-09-01"), signedAt: null,
  createdAt: day("2026-08-20"), deletedAt: null, supersededAt: null, depositPaidAt: day("2026-09-05"), depositPaidCents: 2_500_000,
  taxInclusive: true, depositType: null, depositValue: null,
  items: [{ qty: 1, unitPriceCents: 10_000_000, taxRatePct: 15 }], fees: [], ...overrides,
});
const billTo: QuoteBillTo = {
  name: "Lagoon Lodge (Pty) Ltd", attention: "Anna Jacobs", phone: "021 555 0101", email: "accounts@lagoon.example",
  address: "1 Beach Rd, Hermanus", addressLines: ["1 Beach Rd", "Hermanus, Western Cape, 7200"],
  vatNumber: "4123456789", registrationNumber: "2015/123456/07", isFleet: true,
};

test("the totals and the label say what is owed", () => {
  const statement = buildAccountStatement([quote()], []);
  const { tokens, vars } = statementDocTokens(statement, billTo, day("2026-10-28"));
  assert.equal(plain(tokens["statement.invoiced"]), "R 100 000,00");
  assert.equal(plain(tokens["statement.paid"]), "R 25 000,00");
  assert.equal(plain(tokens["statement.balance"]), "R 75 000,00");
  assert.equal(tokens["statement.balanceLabel"], "BALANCE DUE");
  assert.deepEqual(vars.statement, { owing: true, inCredit: false, paidUp: false, openInvoices: 1, lines: 2 });
});

test("in credit is shown as a positive amount with its own label; paid up says so", () => {
  const credit = statementDocTokens(buildAccountStatement([quote({ depositPaidCents: 10_100_000 })], []), billTo, day("2026-10-28"));
  assert.equal(plain(credit.tokens["statement.balance"]), "R 1 000,00");
  assert.equal(credit.tokens["statement.balanceLabel"], "IN CREDIT");
  const paid = statementDocTokens(buildAccountStatement([quote({ depositPaidCents: 10_000_000 })], []), billTo, day("2026-10-28"));
  assert.equal(paid.tokens["statement.balanceLabel"], "PAID UP");
});

test("the payment reference is the one open invoice, else the account", () => {
  const one = statementDocTokens(buildAccountStatement([quote()], []), billTo, day("2026-10-28"));
  assert.equal(one.tokens["statement.reference"], "INV-512340");
  const two = statementDocTokens(
    buildAccountStatement([quote(), quote({ id: "q2", number: 102, invoiceNumber: 512_341 })], []),
    billTo,
    day("2026-10-28"),
  );
  assert.equal(two.tokens["statement.reference"], "Lagoon Lodge (Pty) Ltd");
});

test("the account block carries the same lines as the invoice's BILL TO, plus reg and VAT numbers", () => {
  assert.equal(
    statementAccountLines(billTo),
    ["Attention: Anna Jacobs", "021 555 0101", "accounts@lagoon.example", "1 Beach Rd", "Hermanus, Western Cape, 7200", "Reg no: 2015/123456/07", "VAT no: 4123456789"].join("\n"),
  );
  const { tokens } = statementDocTokens(buildAccountStatement([], []), billTo, day("2026-10-28"));
  assert.equal(tokens["statement.accountName"], "Lagoon Lodge (Pty) Ltd");
  assert.equal(tokens["customer.name"], "Lagoon Lodge (Pty) Ltd");
  assert.equal(tokens["statement.date"], "28 Oct 2026");
});

test("rows are the statement's lines, formatted, with blanks where a line neither charges nor pays", () => {
  const rows = statementRows(buildAccountStatement([quote()], []));
  assert.deepEqual(rows.map((row) => [row.kind, row.reference, plain(row.charges), plain(row.payments), plain(row.balance)]), [
    ["invoice", "INV-512340", "R 100 000,00", "", "R 100 000,00"],
    ["deposit", "INV-512340", "", "R 25 000,00", "R 75 000,00"],
  ]);
  assert.equal(rows[0].date, "01 Sept 2026");
});
