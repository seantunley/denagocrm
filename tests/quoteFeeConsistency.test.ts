import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { documentTotals, includedLines, lineNetCents, quotePricing, quoteTotalCents } from "../src/lib/pricing";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * There are two totals for a quote and they are NOT interchangeable:
 *
 *   quoteTotalCents(items)              — the line-items subtotal
 *   quotePricing(items, fees, …).total  — what the customer actually pays
 *
 * A quote with a R5 500 delivery fee showed R545 500 on its own page and
 * R540 000 on the deliveries board, because the board used the first one.
 */

const items = [{ qty: 2, unitPriceCents: 27_000_000, discountPct: 0, taxRatePct: 15 }];
const fees = [{ amountCents: 550_000, taxRatePct: 15 }];

test("the two totals genuinely differ once a fee exists", () => {
  const subtotal = quoteTotalCents(items);
  const payable = quotePricing(items, fees, { taxInclusive: true }).totalCents;
  assert.equal(subtotal, 54_000_000);
  assert.equal(payable, 54_550_000, "fees must be part of what the customer pays");
  assert.notEqual(subtotal, payable, "…which is exactly why the board disagreed with the quote");
});

test("the deliveries board shows what the customer pays, not the subtotal", () => {
  const code = src("src/app/(app)/deliveries/page.tsx");
  assert.match(code, /fees: true/, "the board must LOAD the fees before it can count them");
  assert.match(code, /quotePricing\(/, "the board must use the payable total");
  assert.doesNotMatch(
    code,
    /quoteTotalCents\(quote\.items\)/,
    "the board must not fall back to the line-items subtotal",
  );
});

test("a locked quote still shows what the fees were", () => {
  // The breakdown used to sit behind `editable`, so it vanished the moment a
  // quote was sent — leaving a rolled-up figure with no way to see what the
  // customer had been charged for. The surface moved to the editor when the
  // record page was retired; the property did not.
  const code = src("src/components/quotes/QuoteEditorDialog.tsx");
  const cardAt = code.indexOf("Fees &amp; delivery");
  assert.ok(cardAt > 0, "the fees card must exist");
  // The rows render from `draft.fees` unconditionally — only the INPUTS are
  // disabled — so a frozen quote still shows every fee it is charging for.
  assert.match(code, /\{draft\.fees\.map\(\(fee\) => \(/, "the fee rows must not be gated on editability");
  assert.match(code, /disabled=\{!editable\}/, "…they are read-only, not absent");
  assert.doesNotMatch(
    code,
    /\{editable && draft\.fees\.map/,
    "gating the BREAKDOWN on editability is the bug this guards",
  );
});

test("the editor promises no screen that isn't there", () => {
  const code = src("src/components/quotes/QuoteEditorDialog.tsx");
  // The rendered LABEL, not prose about it — the comment explaining the rename
  // legitimately contains the old wording.
  assert.doesNotMatch(
    code,
    />\s*Signing & delivery\s*</,
    "that label promised a screen that does not exist",
  );
  // This once required BOTH links to the record page to share one name. There is
  // no record page now — its URL redirects to this editor — so the links are
  // gone entirely, which settles the question the rule was asking.
  assert.ok(
    !shipped("src/components/quotes/QuoteEditorDialog.tsx").includes("Open full record"),
    "a link that redirects back to the editor you are already in is not a destination",
  );
});

test("nothing outside pricing.ts states a quote total without fees", () => {
  // The real defence. Fixing the surfaces one by one is how they diverged in the
  // first place: quoteTotalCents(items) is the LINE-ITEMS SUBTOTAL, and every
  // customer-facing, legal and reporting surface had quietly adopted it.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next") walk(full, out);
      } else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  const offenders = walk(path.join(root, "src"))
    .filter((file) => !file.endsWith(path.join("lib", "pricing.ts")))
    .filter((file) => /quoteTotalCents\s*\(/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).split(path.sep).join("/"));

  assert.deepEqual(
    offenders,
    [],
    `these state a quote total that excludes fees — use payableTotalCents():\n  ${offenders.join("\n  ")}`,
  );
});

test("every surface that renders a quote loads its fees", () => {
  // Loading `items` without `fees` is the other half of the same bug: the total
  // silently drops the delivery charge because the data was never fetched.
  const surfaces = [
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
    "src/app/api/pdf/quote/[id]/route.tsx",
    "src/lib/signing/render.ts",
    "src/lib/signing/autoEnvelope.ts",
    "src/lib/signing/postComplete.ts",
    "src/lib/doceditor/generate.ts",
    "src/lib/customDocs.ts",
    "src/app/(app)/deliveries/page.tsx",
    // The customer's own copy of their quote — it has to agree with the one
    // they signed.
    "src/app/portal/page.tsx",
    // setQuoteStatus() writes the value of the sale into the audit trail.
    "src/app/actions/quotes.ts",
  ];
  for (const rel of surfaces) {
    assert.match(src(rel), /fees:/, `${rel} renders a quote total but never loads its fees`);
  }

  // The printable quote no longer loads the quote itself — it renders the same
  // builder document the customer signs, and bindCtx() (in signing/render.ts,
  // asserted above) is what fetches the fees. Assert the delegation instead, so
  // a future edit that goes back to loading its own quote is still caught here.
  const print = src("src/lib/quotePrintDocument.ts");
  assert.match(print, /bindCtx\(opts\.quoteId, null\)/, "the printed quote must bind through the shared context");
  assert.doesNotMatch(print, /quote\.findUnique/, "loading the quote here would reintroduce a second fee-less path");
});

test("no quote total is summed by hand", () => {
  // The `quoteTotalCents` ban only catches surfaces that reached for the WRONG
  // helper. These reached for no helper at all — a local `.reduce` over the
  // items — so they dropped fees, discounts, per-line VAT rates, or all three:
  //   buildQuoteContext()  → every signing/builder document
  //   saveQuote()          → the audit record of the sale
  //   the customer portal  → the customer's own view of their quote
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next") walk(full, out);
      } else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  // `[^;]` keeps the match inside one statement — otherwise it spans from an
  // unrelated `.reduce` to the next mention of unitPriceCents and cries wolf.
  const offenders = walk(path.join(root, "src"))
    .filter((file) => /\.reduce\([^;]{0,220}?unitPriceCents/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).split(path.sep).join("/"));

  assert.deepEqual(
    offenders,
    [],
    `these total money by hand instead of through a pricing helper:\n  ${offenders.join("\n  ")}`,
  );
});

test("the rows a customer can see add up to the total, in BOTH tax modes", () => {
  // The invariant every printed document has to hold: whatever a reader totals
  // up from the table equals the FIRST line of the totals block. Tax-inclusive
  // rows are gross and reach the payable total directly; tax-exclusive rows are
  // ex-VAT and reach the subtotal, with VAT shown separately to bridge the gap.
  for (const taxInclusive of [true, false]) {
    const lines = documentTotals({ items, fees, taxInclusive });
    const visible =
      items.reduce((sum, item) => sum + lineNetCents(item), 0) +
      fees.reduce((sum, fee) => sum + fee.amountCents, 0);
    assert.equal(
      lines[0].amountCents,
      visible,
      `taxInclusive=${taxInclusive}: the first totals line must equal the sum of the printed rows`,
    );
    const payable = quotePricing(items, fees, { taxInclusive }).totalCents;
    assert.equal(lines[lines.length - 1].amountCents, payable, "the bottom line is what the customer pays");
    assert.equal(lines[lines.length - 1].strong, true, "the payable total is the emphasised line");
  }
});

test("a tax-exclusive document shows the VAT that bridges rows to total", () => {
  // The reported case: rows totalling R110 printed under "Total incl. VAT
  // R126.50" with nothing in between to explain the R16.50.
  const exclusiveItems = [{ qty: 1, unitPriceCents: 11_000, discountPct: 0, taxRatePct: 15 }];
  const lines = documentTotals({ items: exclusiveItems, fees: [], taxInclusive: false });
  assert.deepEqual(
    lines.map((line) => [line.label, line.amountCents]),
    [
      ["Subtotal", 11_000],
      ["VAT", 1_650],
      ["Total incl. VAT", 12_650],
    ],
  );
  assert.equal(lines[0].amountCents + lines[1].amountCents, lines[2].amountCents, "…and it reconciles");
});

test("a tax-inclusive document does not invent a subtotal it cannot show", () => {
  const lines = documentTotals({ items, fees, taxInclusive: true });
  assert.equal(lines.length, 1, "the rows already include VAT — one band, matching them");
  assert.equal(lines[0].label, "Total incl. VAT");
});

test("an unselected optional add-on is not printed as a charge", () => {
  // quotePricing excludes it from the total, but every renderer still printed
  // it — so the page showed a priced line the total had never counted.
  const withOption = [
    { qty: 1, unitPriceCents: 54_000_000, discountPct: 0, taxRatePct: 15 },
    { qty: 1, unitPriceCents: 900_000, discountPct: 0, taxRatePct: 15, optional: true, selected: false },
    { qty: 1, unitPriceCents: 400_000, discountPct: 0, taxRatePct: 15, optional: true, selected: true },
  ];
  const printed = includedLines(withOption);
  assert.equal(printed.length, 2, "the unselected option is not a row");
  assert.ok(!printed.includes(withOption[1]), "…specifically that one");
  assert.ok(printed.includes(withOption[2]), "a SELECTED option is still charged and still printed");

  // The invariant again: printed rows reach the first totals line.
  const lines = documentTotals({ items: withOption, fees: [], taxInclusive: true });
  const visible = printed.reduce((sum, line) => sum + lineNetCents(line), 0);
  assert.equal(lines[0].amountCents, visible);
  assert.equal(lines[0].amountCents, 54_400_000, "R900 000 of unselected extra is not charged");
});

test("every quote document takes its rows from includedLines", () => {
  const renderers = [
    "src/components/print/QuotePrintDoc.tsx",
    "src/lib/pdf/QuoteDoc.tsx",
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
    "src/lib/docbuilder/merge.ts",
  ];
  for (const rel of renderers) {
    assert.match(src(rel), /includedLines\(/, `${rel} prints rows its own total may not count`);
    assert.doesNotMatch(
      src(rel),
      /\{quote\.items\.map\(|\.\.\.quote\.items,/,
      `${rel} still renders the raw item list`,
    );
  }
});

test("the editor shows an unselected option without pricing it", () => {
  // Internal, so the row stays — staff need to see what was offered — but the
  // total has never counted it, so it must not be priced as a normal line.
  // Carried over from the record page when that was retired; the editor is now
  // the only surface where staff see a declined add-on at all.
  const code = src("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(code, /Optional — not selected/, "the row must say why it isn't charged");
  assert.match(
    code,
    /optional: line\.optional,\s*\n\s*selected: line\.selected,/,
    "and pricing must be told, or quotePricing counts a line the customer declined",
  );
  // The customer's copy drops it entirely — printing it would show a charge the
  // total does not include.
  assert.match(code, /if \(line\.optional && !line\.selected\) return null;/, "the Preview must not print it");
});

test("a declined add-on survives a save instead of being silently re-included", () => {
  // The editor edits none of these columns, and saveQuoteDraft replaces every
  // row — so a save used to flip `selected` back to the schema default and
  // quietly charge for something the customer had turned down. The inheritance
  // itself is exercised directly in quoteRowInheritance.test.ts, including the
  // consecutive-save case that made it work only once; this pins the wiring.
  const code = src("src/app/actions/quotes.ts");
  assert.match(
    code,
    /itemRowsFor\(normalizedItems, priorById\(existing\.items\)\)/,
    "an update must inherit from the rows it is replacing",
  );
  assert.match(code, /feeRowsFor\(normalizedFees, priorById\(existing\.fees\)\)/);
  const rows = src("src/lib/quoteRows.ts");
  assert.match(rows, /optional: previous\?\.optional \?\? false/);
  assert.match(rows, /selected: previous\?\.selected \?\? true/);
});

test("every priced quote document builds its totals from documentTotals", () => {
  // Passing a bare payable total next to ex-VAT rows is what broke reconciliation.
  const priced = [
    "src/components/print/QuotePrintDoc.tsx",
    "src/lib/pdf/QuoteDoc.tsx",
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
  ];
  for (const rel of priced) {
    assert.match(src(rel), /documentTotals\(/, `${rel} prints a price without a reconciling totals block`);
  }
});

test("a priced delivery note itemises the fees it is charging for", () => {
  // It used the fee-inclusive payable total but passed only quote.items to the
  // table, so switching "Show prices" on produced rows that didn't add up.
  const code = src("src/app/(print)/quotes/[id]/delivery-note/page.tsx");
  assert.match(
    code,
    /prices === true\s*\?\s*\[\.\.\.includedLines\(quote\.items\), \.\.\.feeRows\(quote\.fees\)\]/,
    "a priced delivery note must list the fee rows counted in its total",
  );
});

test("a quote that charges for delivery says so on the document", () => {
  // Counting fees in the total but rendering only `items` is a quote whose
  // visible lines do not add up to its own total — the customer has no way to
  // see what the extra money is for.
  const renderers = [
    "src/components/print/QuotePrintDoc.tsx", // the branded quotation + signed PDF
    "src/lib/pdf/QuoteDoc.tsx", // the React-PDF quotation
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/lib/docbuilder/merge.ts", // {{merge}} documents and the signing envelope
    // The editor's own Preview tab — the last surface with the defect, and the
    // one a rep actually looks at before sending. Its total came from
    // quotePricing(lines, fees, …) while its table listed only draft.lines, so
    // a R2 750 delivery charge landed in the total with no row to explain it.
    "src/components/quotes/QuoteEditorDialog.tsx",
  ];
  for (const rel of renderers) {
    assert.match(
      src(rel),
      /feeRows\(/,
      `${rel} counts fees in the total but never itemises them`,
    );
  }
});

test("the editor preview prices its fee rows off the same fees it totals", () => {
  // feeRows() being present is not enough — it has to be fed the SAME list
  // quotePricing() charges for, including the label fallback the save path
  // applies, or the preview shows rows the saved quote won't have.
  const code = src("src/components/quotes/QuoteEditorDialog.tsx");
  const memo = code.slice(code.indexOf("const calculated = useMemo("), code.indexOf("function updateLine("));
  assert.match(memo, /quotePricing\(lines, fees,/, "the total counts `fees`");
  assert.match(memo, /feeRows\(fees\)/, "…and the rows must itemise that same `fees`");
  assert.match(
    memo,
    /fee\.kind === "delivery" \? "Delivery" : "Fee"/,
    "an unlabelled fee must preview under the name it will save under",
  );
});
