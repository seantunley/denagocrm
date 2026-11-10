import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildXeroInvoice,
  readXeroInvoice,
  totalsDiffer,
  xeroErrorMessage,
  xeroReference,
  xeroStatusLabel,
  type XeroQuoteInput,
} from "../src/lib/xeroInvoice";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";
import { isSecretSettingKey } from "../src/lib/settings";

const quote = (over: Partial<XeroQuoteInput> = {}): XeroQuoteInput => ({
  number: 1029,
  invoiceNumber: 123,
  taxInclusive: true,
  currency: null,
  invoicedAt: new Date("2026-11-10T22:30:00Z"), // 11 Nov in Johannesburg
  items: [
    { description: "Denago Rover XL", qty: 1, unitPriceCents: 24_000_000, discountPct: 5, colorPreference: "Ocean Blue", taxRatePct: 15 },
    { description: "Roof", qty: 1, unitPriceCents: 450_000, optional: true, selected: false, taxRatePct: 15 },
    { description: "Trade-in", qty: 1, unitPriceCents: -5_000_000, taxRatePct: 15 },
  ],
  fees: [{ label: "Cape Town", kind: "delivery", amountCents: 550_000 }],
  billTo: { name: "Len Smith", email: "len@example.com" },
  ...over,
});

test("a quote becomes a DRAFT sales invoice with our numbers in the Reference", () => {
  const x = buildXeroInvoice(quote(), "");
  assert.equal(x.Type, "ACCREC");
  assert.equal(x.Status, "DRAFT");
  assert.equal(x.Reference, "INV-000123 · Q-1029");
  assert.equal(x.Date, "2026-11-11");
  assert.equal(x.LineAmountTypes, "Inclusive");
  assert.deepEqual(x.Contact, { Name: "Len Smith", EmailAddress: "len@example.com" });
  assert.equal(x.CurrencyCode, undefined);
});

test("lines match the CRM's own invoice: untaken optional left out, discount kept, fees as rows", () => {
  const x = buildXeroInvoice(quote(), "4000");
  assert.deepEqual(x.LineItems, [
    { Description: "Denago Rover XL — Ocean Blue", Quantity: 1, UnitAmount: 240000, AccountCode: "4000", DiscountRate: 5 },
    { Description: "Trade-in", Quantity: 1, UnitAmount: -50000, AccountCode: "4000" },
    { Description: "Delivery — Cape Town", Quantity: 1, UnitAmount: 5500, AccountCode: "4000" },
  ]);
});

test("exclusive quotes, foreign currency, the default account and a missing name", () => {
  const x = buildXeroInvoice(quote({ taxInclusive: false, currency: "USD", billTo: { name: " ", email: "" } }), "  ");
  assert.equal(x.LineAmountTypes, "Exclusive");
  assert.equal(x.CurrencyCode, "USD");
  assert.equal(x.LineItems[0].AccountCode, "200");
  assert.deepEqual(x.Contact, { Name: "Customer" });
  assert.equal(xeroReference({ number: 7, invoiceNumber: null }), "Q-7");
});

test("Xero's answers are read safely", () => {
  assert.deepEqual(readXeroInvoice({ Invoices: [{ InvoiceID: "abc", InvoiceNumber: "INV-0042", Status: "DRAFT", Total: 2345.67 }] }), {
    id: "abc", number: "INV-0042", status: "DRAFT", totalCents: 234567,
  });
  assert.equal(readXeroInvoice({}), null);
  assert.equal(readXeroInvoice(null), null);
  assert.equal(
    xeroErrorMessage({ Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code." }] }] }, 400),
    "Account code '999' is not a valid code.",
  );
  assert.equal(xeroErrorMessage({ Detail: "TokenExpired" }, 401), "TokenExpired");
  assert.equal(xeroErrorMessage(null, 503), "Xero answered 503.");
  assert.equal(totalsDiffer(100_001, 100_000), false);
  assert.equal(totalsDiffer(100_500, 100_000), true);
  assert.equal(totalsDiffer(null, 100_000), false);
  assert.equal(xeroStatusLabel("AUTHORISED"), "Awaiting payment");
});

test("Xero is a per-workspace integration whose secrets are encrypted", () => {
  const xero = TENANT_CREDENTIAL_INTEGRATIONS.find((i) => i.id === "xero");
  assert.ok(xero);
  assert.ok(isSecretSettingKey("XERO_CLIENT_SECRET"));
  assert.ok(isSecretSettingKey("XERO_REFRESH_TOKEN"));
  assert.equal(isSecretSettingKey("XERO_CLIENT_ID"), false);
});

test("wiring: granular scopes, draft-only, one invoice per quote, same door as invoicing", () => {
  const scopes = readFileSync("src/lib/xero.ts", "utf8").match(/export const XERO_SCOPES = "([^"]+)"/)?.[1] ?? "";
  assert.match(scopes, /accounting\.invoices accounting\.contacts/);
  assert.doesNotMatch(scopes, /accounting\.transactions/, "new Xero apps refuse the legacy umbrella scope");
  assert.match(scopes, /offline_access/);
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  assert.match(actions, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  assert.match(actions, /xeroStatus: "SENDING"/);
  assert.match(actions, /createXeroInvoice\(tenantId, payload, `crm-quote-\$\{quote\.id\}`\)/);
  assert.doesNotMatch(readFileSync("src/lib/xeroInvoice.ts", "utf8"), /Status: "AUTHORISED"/);
  const callback = readFileSync("src/app/api/integrations/xero/callback/route.ts", "utf8");
  assert.match(callback, /activeTenantId !== pending\.tenantId/);
});
