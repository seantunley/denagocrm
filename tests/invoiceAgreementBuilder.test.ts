import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  agreementNumber,
  builderDocRedirect,
  invoiceNumber,
  legacyDocTextTokens,
  quoteDocTokens,
} from "../src/lib/docbuilder/quoteDocs";
import { defaultTemplate } from "../src/lib/docTemplates";
import { formatDate, formatZAR } from "../src/lib/format";
import type { QuoteBillTo } from "../src/lib/quoteBillTo";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const person: QuoteBillTo = {
  name: "Jane Buyer",
  attention: null,
  phone: "082 000 0000",
  email: "jane@example.com",
  address: "1 Main Rd, Cape Town",
  vatNumber: "",
  registrationNumber: "",
  isFleet: false,
};
const fleet: QuoteBillTo = {
  ...person,
  name: "Estate Fleet (Pty) Ltd",
  attention: "Jane Buyer",
  vatNumber: "4123456789",
  registrationNumber: "2020/123456/07",
  isFleet: true,
};
const money = { depositCents: 5_000_00, balanceCents: 15_000_00 };

// ── the switch ──────────────────────────────────────────────────────────────

test("an unpublished invoice / agreement layout leaves the old page printing", async () => {
  for (const key of ["invoice", "agreement"] as const) {
    assert.equal(await builderDocRedirect("q1", key, {}, async () => null), null);
  }
});

test("a published layout sends the page to the builder route for its own key", async () => {
  assert.equal(await builderDocRedirect("q1", "invoice", {}, async () => ({ id: "t" })), "/quotes/q1/doc/invoice");
  assert.equal(await builderDocRedirect("q1", "agreement", {}, async () => ({ id: "t" })), "/quotes/q1/doc/agreement");
});

test("?tpl= (old-template preview) and ?legacy=1 (builder fallback) stay on the old page", async () => {
  let looked = false;
  const published = async () => { looked = true; return { id: "t" }; };
  assert.equal(await builderDocRedirect("q1", "invoice", { tpl: "old-id" }, published), null);
  assert.equal(await builderDocRedirect("q1", "invoice", { legacy: "1" }, published), null);
  assert.equal(looked, false, "no template lookup needed when the page is pinned to the old layout");
});

test("each print page gates on its OWN key, and the gate requires a published version", () => {
  for (const key of ["invoice", "agreement"]) {
    const src = read(`src/app/(print)/quotes/[id]/${key}/page.tsx`);
    assert.ok(
      src.includes(`builderDocRedirect(id, "${key}", search, () => publishedBuilderTemplateFor("${key}"))`),
      `${key} page must gate on the ${key} template`,
    );
    assert.match(src, /if \(builderHref\) redirect\(builderHref\)/);
  }
  const helper = read("src/lib/docbuilder/published.ts");
  assert.match(helper, /publishedVersion != null \? template : null/);
  // The route must never bounce straight back to a page that would redirect again.
  assert.match(read("src/app/(print)/quotes/[id]/doc/[key]/route.ts"), /\?legacy=1/);
});

// ── the context ─────────────────────────────────────────────────────────────

test("numbering is exactly what the old pages print", () => {
  assert.equal(invoiceNumber(1234), "INV-1234");
  assert.equal(agreementNumber(1234), "SA-1234");
  const tokens = quoteDocTokens({ number: 77, status: "accepted" }, person, money);
  assert.equal(tokens["invoice.number"], "INV-77");
  assert.equal(tokens["agreement.number"], "SA-77");
  // Old pages: number={`INV-${quote.number}`} and number={`SA-${quote.number}`}.
  assert.match(read("src/app/(print)/quotes/[id]/invoice/page.tsx"), /number=\{`INV-\$\{quote\.number\}`\}/);
  assert.match(read("src/app/(print)/quotes/[id]/agreement/page.tsx"), /number=\{`SA-\$\{quote\.number\}`\}/);
});

test("the invoice is dated when it was invoiced, else today", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  const invoicedAt = new Date("2026-08-01T10:00:00Z");
  assert.equal(quoteDocTokens({ number: 1, status: "won", invoicedAt }, person, money, now)["invoice.date"], formatDate(invoicedAt));
  assert.equal(quoteDocTokens({ number: 1, status: "won", invoicedAt: null }, person, money, now)["invoice.date"], formatDate(now));
  assert.equal(quoteDocTokens({ number: 1, status: "won" }, person, money, now)["agreement.date"], formatDate(now));
});

test("party blocks carry the same lines as the old info blocks, blanks dropped", () => {
  const p = quoteDocTokens({ number: 1, status: "sent" }, person, money);
  assert.equal(p["invoice.billedTo"], "082 000 0000\njane@example.com\n1 Main Rd, Cape Town");
  assert.equal(p["agreement.purchaser"], p["invoice.billedTo"]);

  const f = quoteDocTokens({ number: 1, status: "sent" }, fleet, money);
  assert.equal(
    f["invoice.billedTo"],
    "Attention: Jane Buyer\n082 000 0000\njane@example.com\n1 Main Rd, Cape Town\nVAT no: 4123456789",
  );
  assert.equal(
    f["agreement.purchaser"],
    "Attention: Jane Buyer\n082 000 0000\njane@example.com\n1 Main Rd, Cape Town\nReg. no: 2020/123456/07\nVAT no: 4123456789",
  );
  assert.equal(f["quote.status"], "sent");
  assert.equal(f["quote.deposit"], formatZAR(5_000_00));
  assert.equal(f["quote.balance"], formatZAR(15_000_00));
});

test("banking, payment terms and clauses come from the old template, and a section switched off is empty", () => {
  const inv = defaultTemplate("invoice");
  const on = legacyDocTextTokens("invoice", { ...inv, terms: "30 days" });
  assert.equal(on.tokens["invoice.bankingDetails"], inv.bodyText);
  assert.equal(on.tokens["invoice.paymentTerms"], "30 days");
  assert.equal(on.tokens["invoice.intro"], "Thank you for your business.");
  assert.equal(on.vars.invoice.bankingDetails, inv.bodyText);

  const off = legacyDocTextTokens("invoice", { ...inv, terms: "30 days", sections: { banking: false, terms: false } });
  assert.equal(off.tokens["invoice.bankingDetails"], "");
  assert.equal(off.tokens["invoice.paymentTerms"], "");

  const ag = defaultTemplate("agreement");
  assert.equal(legacyDocTextTokens("agreement", ag).tokens["agreement.clauses"], ag.bodyText);
  assert.equal(legacyDocTextTokens("agreement", { ...ag, sections: { clauses: false } }).tokens["agreement.clauses"], "");
});

test("buildQuoteContext carries the new tokens and the tax mode", () => {
  const merge = read("src/lib/docbuilder/merge.ts");
  assert.match(merge, /\.\.\.quoteDocTokens\(quote, billTo, pricing\)/);
  assert.match(merge, /taxInclusive: quote\.taxInclusive !== false/);
});

// ── the seeded layouts ──────────────────────────────────────────────────────

function bound(tokens: Record<string, string>, vars: Record<string, unknown>) {
  return {
    tokens: {
      "company.name": "Denago Cape Town",
      "quote.number": "Q-77",
      "quote.total": "R 100,000.00",
      "quote.subtotal": "R 86,956.52",
      "quote.vat": "R 13,043.48",
      "customer.name": "Jane Buyer",
      ...quoteDocTokens({ number: 77, status: "accepted" }, person, money),
      ...tokens,
    },
    items: [],
    vars,
    bound: true,
  };
}

test("the seeded invoice prints its number, and the banking box only when there is banking text", () => {
  const doc = standardTemplateFor("invoice");
  const withText = legacyDocTextTokens("invoice", defaultTemplate("invoice"));
  const html = renderDocumentHtml(doc, bound(withText.tokens, { quote: { taxInclusive: true }, ...withText.vars }));
  assert.match(html, /INV-77/);
  assert.match(html, /PAYMENT DETAILS/);
  assert.match(html, /Banking details:/);
  assert.doesNotMatch(html, /PAYMENT TERMS/, "no payment terms set → no box");
  assert.doesNotMatch(html, /Subtotal:/, "inclusive quote → one total line, as documentTotals()");
  assert.doesNotMatch(html, /\{\{/, "every token resolves");

  const none = legacyDocTextTokens("invoice", { ...defaultTemplate("invoice"), sections: { banking: false } });
  const bare = renderDocumentHtml(doc, bound(none.tokens, { quote: { taxInclusive: false }, ...none.vars }));
  assert.doesNotMatch(bare, /PAYMENT DETAILS/);
  assert.match(bare, /Subtotal: R 86,956\.52/, "exclusive quote → subtotal and VAT above the total");
});

test("the seeded agreement prints SA-, the purchase price band, clauses and both signature lines", () => {
  const doc = standardTemplateFor("agreement");
  const text = legacyDocTextTokens("agreement", defaultTemplate("agreement"));
  const html = renderDocumentHtml(doc, bound(text.tokens, { quote: { taxInclusive: true }, ...text.vars }));
  assert.match(html, /SA-77/);
  assert.match(html, /PURCHASE PRICE/);
  assert.match(html, /TERMS OF SALE/);
  assert.match(html, /Ownership passes on receipt of full payment/);
  assert.match(html, /Purchaser signature · Date/);
  assert.match(html, /For Denago Cape Town · Date/);
});
