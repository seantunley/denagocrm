import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { quotePricing, quoteTotalCents } from "../src/lib/pricing";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

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
  // The whole card used to be behind `editable`, so the breakdown vanished the
  // moment a quote was sent — leaving only a rolled-up figure with no way to
  // see what the customer had been charged for.
  const code = src("src/app/(app)/quotes/[id]/page.tsx");
  const cardAt = code.indexOf("Fees, delivery &amp; deposit");
  assert.ok(cardAt > 0, "the fees card must exist");
  const gate = code.slice(Math.max(0, cardAt - 400), cardAt);
  assert.doesNotMatch(
    gate,
    /\{editable && \(\s*<div className="card space-y-4">\s*$/,
    "the fee BREAKDOWN must not be gated on editability",
  );
  assert.match(code, /editable \|\| quote\.fees\.length > 0/, "a locked quote with fees must still render them");
});

test("the editor has one name for one destination", () => {
  const code = src("src/components/quotes/QuoteEditorDialog.tsx");
  // The rendered LABEL, not prose about it — the comment explaining the rename
  // legitimately contains the old wording.
  assert.doesNotMatch(
    code,
    />\s*Signing & delivery\s*</,
    "that label promised a screen that does not exist — it is the full record page",
  );
  const recordLinks = (code.match(/Open full record/g) ?? []).length;
  assert.ok(recordLinks >= 2, "both links to the record page should now say the same thing");
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
    "src/app/(print)/quotes/[id]/print/page.tsx",
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
  ];
  for (const rel of surfaces) {
    assert.match(src(rel), /fees:/, `${rel} renders a quote total but never loads its fees`);
  }
});
