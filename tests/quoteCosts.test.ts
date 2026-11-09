import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { isSupplierQuote } from "../src/lib/dealFile";
import { quotePricing } from "../src/lib/pricing";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("only a supplier quote offers its prices as costs", () => {
  assert.equal(isSupplierQuote("Supplier quote"), true);
  assert.equal(isSupplierQuote("supplier QUOTE"), true);
  assert.equal(isSupplierQuote("Supplier invoice"), false);
  assert.equal(isSupplierQuote("Quote"), false);
  assert.equal(isSupplierQuote(null), false);
});

test("a cost per unit (excl. VAT) gives the margin the box shows", () => {
  // Two carts at R115 000 incl. 15% VAT = R200 000 net; supplier cost R80 000 each excl. VAT.
  const pricing = quotePricing([{ qty: 2, unitPriceCents: 11_500_000, taxRatePct: 15, costCents: 8_000_000 }], [], { taxInclusive: true });
  assert.equal(pricing.costCents, 16_000_000);
  assert.equal(pricing.marginCents, 4_000_000);
  assert.equal(pricing.marginPct, 20);
});

test("saving costs: quote access, own workspace, the editor's lock, never a superseded quote, audited", () => {
  const action = src("src/app/actions/quoteCosts.ts");
  assert.match(action, /requireQuoteAccess\(quoteId, "quotes\.edit"\)/);
  assert.match(action, /isModuleEnabled\("suppliers"\)/);
  assert.match(action, /FOR UPDATE/, "same row lock as saveQuoteDraft, which rewrites every line");
  assert.match(action, /SELECT id FROM "Quote" WHERE id = \$\{quoteId\} AND "tenantId" = \$\{actingTenant\} FOR UPDATE/);
  assert.match(action, /where: \{ id: quoteId, tenantId: actingTenant \}/);
  assert.match(action, /quoteItem\.updateMany\(\{ where: \{ id: update\.id, quoteId, tenantId: actingTenant \}/);
  assert.match(action, /if \(quote\.supersededAt\) refuse\(/);
  assert.match(action, /parsed\.cents < 0\) refuse\(/);
  assert.match(action, /action: "quote\.costs_set"/);
});

test("the editor's save keeps a cost set from a supplier quote", () => {
  // saveQuoteDraft rewrites every row; the cost survives only because itemRowsFor inherits it by id.
  assert.match(src("src/lib/quoteRows.ts"), /costCents: keepCost \? previous\?\.costCents \?\? 0 : 0/);
});

test("cost never reaches the customer's document or a signing record", () => {
  for (const file of ["src/lib/pdf/QuoteDoc.tsx", "src/lib/signing/render.ts"]) assert.doesNotMatch(src(file), /costCents/, file);
});

test("the costs box needs the Suppliers module, a supplier quote on file, and quotes.edit", () => {
  const panel = src("src/components/DocumentsPanel.tsx");
  assert.match(panel, /vendors === null \|\| !\(quoteGroups \?\? \[\]\)\.length \|\| !\(await hasPermission\(await requireUser\(\), "quotes\.edit"\)\)/);
  assert.match(panel, /!group\.superseded && group\.documents\.some\(\(doc\) => isSupplierQuote\(doc\.tag\)\)/);
});
