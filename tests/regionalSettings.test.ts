import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEFAULT_REGIONAL, formatDate, formatZAR, formatZARCompact, regionalFrom, type Regional } from "../src/lib/format";
import { vatRateLabel } from "../src/lib/pricing";
import { feeRowsFor, itemRowsFor, priorById } from "../src/lib/quoteRows";
import { quoteValidDays } from "../src/lib/quoteExpiry";
import { lineItemCell, renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { standardQuoteTemplate } from "../src/lib/doceditor/factory";
import { showcaseQuoteTemplate } from "../src/lib/doceditor/standardTemplates";

/**
 * Gap #8: VAT, currency and time zone were fixed in code, and the built-in quote
 * wording said "valid 14 days" while Settings → Quotes said 7.
 *
 * They are workspace settings now (Settings → Quotes → Tax, currency & time
 * zone), and three things must hold:
 *   (a) the document render paths take them from the setting, not a literal;
 *   (b) changing the VAT setting never re-prices a quote that already exists —
 *       its lines carry the rate they were issued at;
 *   (c) validity wording comes from the quote's own date, which the setting set.
 */

// merge.ts is server-only; the marker module is the only thing in the way of running it here.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const merge = createRequire(import.meta.url)("../src/lib/docbuilder/merge.ts") as typeof import("../src/lib/docbuilder/merge");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const USD: Regional = { vatRatePct: 16, currency: "USD", locale: "en-US", timeZone: "America/New_York" };
const SA16: Regional = { ...DEFAULT_REGIONAL, vatRatePct: 16 };

/** A quote as stored: every line and fee carries the rate it was issued at. */
function storedQuote(over: Record<string, unknown> = {}) {
  const createdAt = new Date("2026-09-30T23:30:00Z"); // 1 Oct in Johannesburg, 30 Sep in New York
  return {
    number: 2001, createdAt, validUntil: new Date(createdAt.getTime() + quoteValidDays("7") * 86_400_000),
    status: "sent", taxInclusive: true, depositType: null, depositValue: null, fleetId: null, invoicedAt: null,
    items: [{ id: "i1", description: "Rover XL", qty: 1, unitPriceCents: 11_500_000, discountPct: 0, taxRatePct: 15, colorPreference: null, optional: false, selected: true, costCents: 0, kind: "product", productId: null }],
    fees: [{ id: "f1", label: "Delivery", kind: "delivery", amountCents: 115_000, taxRatePct: 15, sortOrder: 0 }],
    contact: { firstName: "Thandi", lastName: "Nkosi", phone: null, email: null, address: null, suburb: null, city: null, province: null, postalCode: null, vatNumber: null },
    lead: null,
    createdBy: { name: "Sean" },
    ...over,
  } as unknown as Parameters<typeof merge.buildQuoteContext>[0];
}

// ── defaults are today's behaviour ──────────────────────────────────────────

test("an unset workspace formats exactly as before: 15%, rand, en-ZA, Johannesburg", () => {
  assert.deepEqual(regionalFrom({}), { vatRatePct: 15, currency: "ZAR", locale: "en-ZA", timeZone: "Africa/Johannesburg" });
  const legacy = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 }).format(1234.56);
  assert.equal(formatZAR(123_456), legacy);
  assert.equal(formatZAR(123_456, regionalFrom({})), legacy);
  assert.equal(formatZARCompact(227_000_000), "R 2,27m");
  assert.equal(formatZARCompact(37_000_000), "R 370k");
});

test("a stored value Intl can't use falls back field by field — a PDF render never throws", () => {
  assert.deepEqual(regionalFrom({ vatRatePct: "abc", currency: "XX", locale: "!!", timeZone: "Mars/Base" }), { ...DEFAULT_REGIONAL });
  assert.deepEqual(regionalFrom({ vatRatePct: "16", currency: "usd", locale: "en-US", timeZone: "America/New_York" }), USD);
  assert.equal(regionalFrom({ vatRatePct: "0" }).vatRatePct, 0, "zero-rated is a real rate, not 'unset'");
  assert.equal(regionalFrom({ vatRatePct: "101" }).vatRatePct, 15);
});

test("the currency, locale and time zone reach the customer's document", () => {
  const ctx = merge.buildQuoteContext(storedQuote(), null, USD);
  assert.match(ctx.tokens["quote.total"], /^\$/, "a USD workspace prints dollars");
  assert.equal(ctx.tokens["quote.date"], formatDate(new Date("2026-09-30T23:30:00Z"), USD));
  assert.match(ctx.tokens["quote.date"], /Sep.*30|30.*Sep/, "dated in New York, where it is still the 30th");
  assert.match(merge.buildQuoteContext(storedQuote(), null, DEFAULT_REGIONAL).tokens["quote.date"], /^0?1 Oct/, "…and the 1st in Johannesburg");
});

// ── (b) historic quotes do not change ───────────────────────────────────────

test("changing the VAT setting never re-prices a quote that already exists", () => {
  const before = merge.buildQuoteContext(storedQuote(), null, DEFAULT_REGIONAL).tokens;
  const after = merge.buildQuoteContext(storedQuote(), null, SA16).tokens;
  for (const key of ["quote.subtotal", "quote.vat", "quote.total", "quote.deposit", "quote.balance", "quote.vatRate"]) {
    assert.equal(after[key], before[key], `${key} moved when only the setting changed`);
  }
  assert.equal(after["quote.vatRate"], "15%", "the wording names the rate the quote was ISSUED at");
  assert.equal(after["quote.vat"], formatZAR(1_515_000), "R116 150 incl. at 15% carries R15 150 VAT");
});

test("re-saving an issued draft keeps each line's own rate; only a NEW line takes the new setting", () => {
  const incoming = (id: string | null) => ({ id, description: "x", qty: 1, unitPriceCents: 100, productId: null, colorPreference: null, discountPct: 0, taxRatePct: null });
  const prior = priorById([{ id: "old", kind: "product", taxRatePct: 15, costCents: 0, optional: false, selected: true }]);
  const [kept, added] = itemRowsFor([incoming("old"), incoming(null)], prior, 16);
  assert.equal(kept.taxRatePct, 15, "an existing line was re-priced at the workspace's new rate");
  assert.equal(added.taxRatePct, 16, "a new line must start at the workspace's rate, not a built-in 15");
  const [fee] = feeRowsFor([{ id: null, label: "Delivery", kind: "delivery", amountCents: 100, taxRatePct: null }], new Map(), 16);
  assert.equal(fee.taxRatePct, 16);
});

test("derived VAT columns use the line's own rate — not the template's, not the setting's — in the right units", () => {
  const ctx = merge.buildQuoteContext(storedQuote(), null, SA16);
  const vehicle = ctx.items[0];
  // Block says 99% and the workspace says 16%: neither applies to a line issued at 15%.
  assert.equal(lineItemCell("subtotal", vehicle, 99, SA16), formatZAR(10_000_000), "R115 000 incl. is R100 000 excl.");
  assert.equal(lineItemCell("vat", vehicle, 99, SA16), formatZAR(1_500_000));
  assert.equal(lineItemCell("unitPriceExVat", vehicle, 99, SA16), formatZAR(10_000_000));
  assert.equal(vatRateLabel([{ qty: 1, unitPriceCents: 1, taxRatePct: 15 }], [{ amountCents: 1, taxRatePct: 0 }]), "15% / 0%");
});

// ── (c) validity wording agrees with the setting ────────────────────────────

test("QUOTE_VALID_DAYS is read one way everywhere", () => {
  assert.equal(quoteValidDays(null), 7);
  assert.equal(quoteValidDays(""), 7);
  assert.equal(quoteValidDays("30"), 30);
  assert.equal(quoteValidDays("0"), 7, "a zero-day quote is expired on arrival");
  for (const rel of ["src/app/actions/quotes.ts", "src/app/api/quick-create/route.ts", "src/app/(app)/quotes/page.tsx"]) {
    assert.doesNotMatch(read(rel), /QUOTE_VALID_DAYS/, `${rel} reads the setting itself instead of quoteFromLeadDefaults()`);
  }
  assert.match(read("src/lib/quoteFromLead.ts"), /quoteValidDays\(validDaysRaw\)/);
});

test("the built-in quote wording states the quote's own dates and rate, never a fixed number of days", () => {
  for (const [name, doc] of [["standard", standardQuoteTemplate()], ["showcase", showcaseQuoteTemplate()]] as const) {
    const text = JSON.stringify(doc);
    assert.doesNotMatch(text, /\d+\s*days/i, `${name} template hard-codes a validity period`);
    assert.doesNotMatch(text, /\d+\s*%\s*VAT|VAT\s*\(\d/, `${name} template hard-codes a VAT rate`);
    assert.match(text, /\{\{quote\.validUntil\}\}/, `${name} template must print the quote's own expiry`);
  }
  const quote = storedQuote();
  const ctx = { ...merge.buildQuoteContext(quote, null, DEFAULT_REGIONAL), bound: true, regional: DEFAULT_REGIONAL };
  for (const doc of [standardQuoteTemplate(), showcaseQuoteTemplate()]) {
    const html = renderDocumentHtml(doc, ctx);
    assert.ok(html.includes(`Quote valid until ${formatDate(quote.validUntil)}.`), "the terms print the date the setting produced");
    assert.ok(html.includes("including 15% VAT"), "the terms name the quote's own rate");
    assert.ok(!html.includes("{{quote."), "no unresolved quote token reaches the customer");
  }
});

// ── (a) nothing hard-coded in the main render paths ─────────────────────────

/** Files that print money or dates on a customer-facing document or message. */
const RENDER_PATHS = [
  "src/lib/docbuilder/merge.ts",
  "src/lib/docbuilder/quoteDocs.ts",
  "src/lib/docbuilder/jobCardFields.ts",
  "src/lib/docbuilder/deliveryServiceContext.ts",
  "src/lib/docbuilder/leadWarrantyContext.ts",
  "src/lib/deliveryServicePrint.ts",
  "src/lib/customDocs.ts",
  "src/lib/pdf/QuoteDoc.tsx",
  "src/components/print/PrintDocShell.tsx",
  "src/app/(print)/quotes/[id]/invoice/page.tsx",
  "src/app/(print)/quotes/[id]/agreement/page.tsx",
  "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
  "src/app/(print)/jobcards/[id]/print/page.tsx",
  "src/app/(print)/jobcards/[id]/service-report/page.tsx",
  "src/app/(print)/warranty/[id]/print/page.tsx",
  "src/app/(print)/leads/[id]/indemnity/page.tsx",
  "src/app/portal/page.tsx",
  "src/lib/serviceReminders.ts",
  "src/lib/botAnswers.ts",
  "src/lib/botAi.ts",
  "src/lib/flowRun.ts",
  "src/components/quotes/QuoteEditorDialog.tsx",
];

/** Where VAT is computed or worded. */
const VAT_PATHS = [
  ...RENDER_PATHS,
  "src/lib/pricing.ts",
  "src/lib/quoteRows.ts",
  "src/lib/quoteFromLead.ts",
  "src/app/actions/quotes.ts",
  "src/lib/doceditor/serialize.ts",
  "src/lib/doceditor/showcaseRender.ts",
  "src/lib/doceditor/factory.ts",
  "src/lib/doceditor/standardTemplates.ts",
  "src/lib/signing/autoEnvelope.ts",
];

test("no render path hard-codes the currency, locale, time zone or VAT rate", () => {
  const forbidden: [RegExp, string][] = [
    [/["']ZAR["']/, "the rand"],
    [/["']en-ZA["']/, "the en-ZA locale"],
    [/Africa\/Johannesburg/, "the Johannesburg time zone"],
    [/\?\?\s*15\b|taxRatePct:\s*15\b/, "a 15% VAT fallback"],
    [/[/*]\s*1\.15\b|\/\s*115\b/, "a ÷1.15 VAT split"],
    [/\b15\s*%/, "a 15% wording"],
    [/valid for \d+ days/i, "a fixed validity period"],
  ];
  for (const rel of VAT_PATHS) {
    const code = withoutComments(read(rel));
    for (const [pattern, what] of forbidden) {
      assert.ok(!pattern.test(code), `${rel} hard-codes ${what}: ${code.match(pattern)?.[0]}`);
    }
  }
});

/** Code only — the comments explaining what used to be hard-coded may say so. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every call of `name(` in `code`, with its argument list split at top-level commas. */
function callArgs(code: string, name: string): string[][] {
  const calls: string[][] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/function\s+$|export\s+function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 1;
    let arg = "";
    const args: string[] = [];
    for (let i = m.index + m[0].length; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (depth === 0) break;
      if (ch === "," && depth === 1) { args.push(arg); arg = ""; } else arg += ch;
    }
    args.push(arg);
    calls.push(args.map((a) => a.trim()).filter(Boolean));
  }
  return calls;
}

test("every money and date on a customer document is formatted with the workspace's settings", () => {
  for (const rel of RENDER_PATHS) {
    const code = withoutComments(read(rel));
    for (const fn of ["formatZAR", "formatDate", "formatDateTime", "formatZARCompact"]) {
      for (const args of callArgs(code, fn)) {
        assert.ok(args.length >= 2, `${rel}: ${fn}(${args.join(", ")}) uses the built-in default instead of the workspace's format`);
      }
    }
  }
});
