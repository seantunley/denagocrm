import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { jobCardTotals, jobLineCents } from "../src/lib/workshop-constants";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The job card equivalent of the quote-fee divergence.
 *
 * `kind` is a free-text column with a default, and the record page, the printed
 * job card, the builder documents and the profit report each totalled it as
 * "part" + "labour" on their own. Any line with another kind was printed in the
 * items table and left out of the total — a document whose rows don't add up.
 */

test("a line that is neither part nor labour still gets charged for", () => {
  const lines = [
    { kind: "part", qty: 2, unitPriceCents: 15_000 },
    { kind: "labour", qty: 1.5, unitPriceCents: 65_000 },
    { kind: "sublet", qty: 1, unitPriceCents: 40_000 },
  ];
  const totals = jobCardTotals(lines);
  assert.equal(totals.partsCents, 30_000);
  assert.equal(totals.labourCents, 97_500);
  assert.equal(totals.otherCents, 40_000, "the third line is a real charge, not a rounding error");
  assert.equal(totals.totalCents, 167_500);
  assert.equal(
    totals.totalCents,
    totals.partsCents + totals.labourCents + totals.otherCents,
    "the breakdown must account for the whole total",
  );
});

test("parts + labour alone is short by exactly the dropped line", () => {
  const lines = [
    { kind: "part", qty: 1, unitPriceCents: 15_000 },
    { kind: "consumable", qty: 1, unitPriceCents: 9_900 },
  ];
  const totals = jobCardTotals(lines);
  assert.equal(totals.partsCents + totals.labourCents, 15_000, "…which is what the old sum produced");
  assert.equal(totals.totalCents, 24_900, "…while the customer is charged this");
});

test("fractional labour rounds once, per line", () => {
  // Labour quantities are fractional (1.5 hours), so a line can land on a half
  // cent. Rounding the grand total instead of each line made the signed PDF and
  // the printed job card disagree by a cent.
  const line = { kind: "labour", qty: 1.5, unitPriceCents: 33_333 };
  assert.equal(jobLineCents(line), 50_000);
  assert.equal(jobCardTotals([line, line]).totalCents, 100_000);
});

test("every workshop surface uses the one calculation", () => {
  const surfaces = [
    "src/app/(app)/jobcards/page.tsx", // list + work-in-progress KPI
    "src/app/(app)/jobcards/[id]/page.tsx", // the record
    "src/app/(print)/jobcards/[id]/print/page.tsx", // the customer's printed job card
    "src/app/(print)/jobcards/[id]/service-report/page.tsx", // the service report
    "src/lib/docbuilder/merge.ts", // {{jobcard.total}} in builder documents
    "src/lib/workshop.ts", // profit / margin
    "src/app/(app)/settings/workshop/page.tsx", // service packages, copied onto job cards
  ];
  for (const rel of surfaces) {
    assert.match(src(rel), /jobCardTotals\(/, `${rel} totals a job card without the shared helper`);
  }
});

test("nothing filters job card items down to part + labour to make a total", () => {
  // The shape of the original bug, in the files that used to carry it.
  for (const rel of [
    "src/app/(app)/jobcards/[id]/page.tsx",
    "src/app/(print)/jobcards/[id]/print/page.tsx",
    "src/lib/docbuilder/merge.ts",
    "src/lib/workshop.ts",
  ]) {
    assert.doesNotMatch(
      src(rel),
      /filter\(\(i\) => i\.kind === "labour"\)[\s\S]{0,80}?reduce\(/,
      `${rel} still builds a total from a kind filter — a line of any other kind vanishes`,
    );
  }
});
