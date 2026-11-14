import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseSteps, invoicesArgs } from "../src/lib/crmAssistantPlan";
import { parseInvoiceNumber } from "../src/lib/invoiceNumber";

test("an invoice number names ONE invoice: the CRM's exactly, else a whole Xero reference, else none (review of #1109)", () => {
  assert.deepEqual(parseInvoiceNumber("INV-000123"), { crm: 123 });
  assert.deepEqual(parseInvoiceNumber("inv123"), { crm: 123 });
  assert.deepEqual(parseInvoiceNumber("123"), { crm: 123 });
  // Not the first run of digits: the whole reference, for Xero.
  assert.deepEqual(parseInvoiceNumber("XERO-2026-00142"), { xero: "XERO-2026-00142" });
  assert.deepEqual(parseInvoiceNumber("XINV-ABC"), { xero: "XINV-ABC" });
  // Nothing parseable: no invoice — never "no filter".
  assert.equal(parseInvoiceNumber("%"), null);
  assert.equal(parseInvoiceNumber(""), null);
  assert.equal(parseInvoiceNumber("a".repeat(40)), null);
});

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("invoices: a lookup DAX can ask for, with its arguments cleaned and capped", () => {
  const step = parseSteps('{"tool":"invoices","args":{"status":"unpaid","olderThanDays":30,"xero":"not_sent","limit":500}}')?.[0];
  assert.deepEqual(step, { tool: "invoices", args: { status: "unpaid", olderThanDays: 30, xero: "not_sent", limit: 60 } });
  assert.deepEqual(parseSteps('{"tool":"invoices","args":{}}')?.[0], { tool: "invoices", args: {} });
  assert.equal(invoicesArgs.safeParse({ status: "overdue" }).success, false, "no 'overdue': invoices carry no due date");
  assert.equal(invoicesArgs.safeParse({ bank: "x" }).success, false, "strict");
});

test("invoices are held to the Invoices page's own rule, and read only", () => {
  const lib = code("src/lib/assistantInvoicesLookup.ts");
  // The page's door: deliveries.view/.manage (routeAccess) and the Automotive module (/invoices is in it).
  assert.match(lib, /hasAnyPermission\(user, "deliveries\.view", "deliveries\.manage"\)/);
  assert.match(lib, /isModuleEnabled\("automotive"\)/);
  assert.match(code("src/lib/routeAccess.ts"), /prefix: "\/invoices", anyOf: \["deliveries\.view", "deliveries\.manage"\]/);
  // Only quotes this person may open, ANDed — never spread over by what was asked for; the workspace named.
  assert.match(lib, /const quoteIds = await getAccessibleQuoteIds\(user\);/);
  assert.match(lib, /AND: \[\s*\.\.\.\(quoteIds === null \? \[\] : \[\{ id: \{ in: quoteIds \} \}\]\)/);
  assert.match(lib, /where: \{\s*tenantId,\s*status: "accepted",\s*supersededAt: null,\s*invoiceNumber: \{ not: null \}/);
  assert.match(lib, /quotePayment\.findMany\(\{ where: \{ tenantId, quoteId: \{ in:/);
  // Never a payment reference, bank detail or Xero token; never a write; never logged.
  assert.doesNotMatch(lib, /reference: true|bankAccount|bankName|accountNumber|iban|xeroDepositPaymentId|accessToken|refreshToken/i);
  assert.doesNotMatch(lib, /\.(create|update|upsert|delete)(Many)?\(|logError|console\./);
  // A Xero reference: exact and case-folded via ciExact (never ILIKE), ANDed into the guarded query.
  assert.match(lib, /await ciExactIdFilter\("quoteXeroInvoiceNumber", asked\.xero\)/);
  assert.match(code("src/lib/ciExact.ts"), /quoteXeroInvoiceNumber: \{ table: "Quote", column: "xeroInvoiceNumber", fold: "upper" \}/);
  assert.doesNotMatch(lib, /match\(\/\\d\+\/\)/, "never the first run of digits");
  // Ages and date filters in SA calendar days.
  assert.match(lib, /const issued = johannesburgDateKey\(statementInvoiceDate\(quote\)\);\s*const age = today - dayOrdinal\(issued\);/);
  assert.match(lib, /if \(args\.olderThanDays && r\.age < args\.olderThanDays\) return false;/);
  // Owing per currency, never added across.
  assert.match(lib, /formatTotals\(totalsByCurrency\(matches, \(r\) => \(\{ cents: r\.owing, currency: r\.quote\.currency \}\)/);
  const plan = code("src/lib/crmAssistantPlan.ts");
  assert.match(plan, /Invoices have NO due date in the CRM: never call one "overdue"/);
  assert.match(code("src/lib/crmAssistant.ts"), /case "invoices": return invoicesLookup\(user, step\.args\);/);
});
