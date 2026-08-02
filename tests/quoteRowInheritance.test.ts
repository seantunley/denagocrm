import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  feeRowsFor,
  itemRowsFor,
  priorById,
  type IncomingItem,
  type PriorItem,
} from "../src/lib/quoteRows";
import { payableTotalCents } from "../src/lib/pricing";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * saveQuoteDraft replaces every item and fee row. The editor's payload carries
 * only what it can edit, so `kind`, `costCents`, `optional`, `selected` and
 * per-line VAT must be inherited from the row being replaced — otherwise every
 * save reverts them to schema defaults, zeroing the cost basis behind the
 * margin figure and charging for add-ons the customer had declined.
 */

/** A line as the editor sends it: no CPQ columns, because it cannot edit them. */
const asEditorSends = (id: string | null, over: Partial<IncomingItem> = {}): IncomingItem => ({
  id,
  description: "Denago EV Nomad XL",
  qty: 1,
  unitPriceCents: 22_000_000,
  productId: null,
  colorPreference: null,
  discountPct: 0,
  taxRatePct: null,
  ...over,
});

/** A row already in the database, carrying values no screen can set. */
const inDatabase = (over: Partial<PriorItem> = {}): PriorItem => ({
  id: "item-1",
  kind: "product",
  taxRatePct: 15,
  costCents: 18_000_000,
  optional: false,
  selected: true,
  ...over,
});

test("the hidden columns survive a save", () => {
  const [row] = itemRowsFor([asEditorSends("item-1")], priorById([inDatabase()]));
  assert.equal(row.costCents, 18_000_000, "the margin's cost basis must not be zeroed");
  assert.equal(row.kind, "product");
  assert.equal(row.taxRatePct, 15);
});

test("a declined add-on stays declined", () => {
  const prior = inDatabase({ id: "extra", optional: true, selected: false, costCents: 0 });
  const [row] = itemRowsFor([asEditorSends("extra")], priorById([prior]));
  assert.equal(row.optional, true);
  assert.equal(row.selected, false, "a save must not quietly re-include what the customer turned down");
});

/**
 * The regression this file exists for.
 *
 * Inheriting by id worked exactly once. Rows were recreated with FRESH ids while
 * the dialog kept the old ones — it builds its draft at mount and never re-reads
 * it — so the second save matched nothing and fell straight back to defaults.
 */
test("…and survive a SECOND save, from a dialog that never reloaded", () => {
  const original = inDatabase({ id: "item-1", costCents: 18_000_000, optional: true, selected: false, taxRatePct: 0 });

  // Save one: the editor sends the id it was mounted with.
  const afterFirst = itemRowsFor([asEditorSends("item-1", { qty: 2 })], priorById([original]));
  assert.equal(afterFirst[0].id, "item-1", "a surviving row must KEEP its id, or the next save cannot find it");

  // Save two: the dialog is still mounted, so it sends the same id again. What
  // is in the database is whatever save one wrote.
  const persisted: PriorItem[] = afterFirst.map((row) => ({
    id: row.id!,
    kind: row.kind,
    taxRatePct: row.taxRatePct,
    costCents: row.costCents,
    optional: row.optional,
    selected: row.selected,
  }));
  const afterSecond = itemRowsFor([asEditorSends("item-1", { qty: 3 })], priorById(persisted));

  assert.equal(afterSecond[0].costCents, 18_000_000, "cost basis lost on the second save");
  assert.equal(afterSecond[0].optional, true);
  assert.equal(afterSecond[0].selected, false, "the declined add-on was silently re-included");
  assert.equal(afterSecond[0].taxRatePct, 0, "a non-default per-line VAT rate was reset");
  assert.equal(afterSecond[0].qty, 3, "…while the edit the user actually made still lands");
});

test("fees keep their identity across consecutive saves too", () => {
  const prior = [{ id: "fee-1", taxRatePct: 0 }];
  const incoming = [{ id: "fee-1", label: "Delivery", kind: "delivery", amountCents: 275_000, taxRatePct: null }];
  const first = feeRowsFor(incoming, priorById(prior));
  assert.equal(first[0].id, "fee-1");
  assert.equal(first[0].taxRatePct, 0, "a zero-rated fee must not jump to 15%");

  const second = feeRowsFor(incoming, priorById([{ id: first[0].id!, taxRatePct: first[0].taxRatePct }]));
  assert.equal(second[0].taxRatePct, 0, "…on the second save either");
  assert.equal(second[0].sortOrder, 0);
});

test("a new line is new — and cannot choose its own primary key", () => {
  // An id that matches no row of THIS quote is dropped, so a caller cannot hand
  // one in and have it become the record's id.
  const [fresh] = itemRowsFor([asEditorSends(null)], priorById([inDatabase()]));
  assert.equal(fresh.id, undefined, "a new row takes a generated id");
  assert.equal(fresh.costCents, 0);
  assert.equal(fresh.selected, true);

  const [forged] = itemRowsFor([asEditorSends("item-from-another-quote")], priorById([inDatabase()]));
  assert.equal(forged.id, undefined, "an unverified id must never reach the primary key");
  assert.equal(forged.costCents, 0, "…and inherits nothing");
});

test("an explicit tax rate from the caller still wins over the inherited one", () => {
  const [row] = itemRowsFor([asEditorSends("item-1", { taxRatePct: 0 })], priorById([inDatabase({ taxRatePct: 15 })]));
  assert.equal(row.taxRatePct, 0, "null means 'unstated', not 'zero'");
});

/**
 * The audit trail records what a quote was worth. Built from the REQUEST it
 * counted every line, because the request carries no optional/selected — so a
 * quote with a declined add-on logged a sale worth more than the database, the
 * preview and the printed document all agree it is.
 */
test("the audited value matches the rows actually written", () => {
  const prior = [
    inDatabase({ id: "vehicle", costCents: 0 }),
    inDatabase({ id: "extra", optional: true, selected: false, costCents: 0 }),
  ];
  const incoming = [asEditorSends("vehicle"), asEditorSends("extra", { unitPriceCents: 900_000 })];
  const rows = itemRowsFor(incoming, priorById(prior));

  const audited = payableTotalCents({ items: rows, fees: [], taxInclusive: true });
  assert.equal(audited, 22_000_000, "the declined R9 000 add-on is not part of the sale");

  // What it did before: the same lines without the inherited state.
  const fromRequest = payableTotalCents({
    items: incoming.map(({ id: _id, taxRatePct, ...line }) => ({ ...line, taxRatePct: taxRatePct ?? 15 })),
    fees: [],
    taxInclusive: true,
  });
  assert.equal(fromRequest, 22_900_000);
  assert.notEqual(audited, fromRequest, "…which is exactly the discrepancy this fixes");
});

test("saveQuoteDraft audits the persisted rows, not the request", () => {
  const code = src("src/app/actions/quotes.ts");
  assert.match(
    code,
    /payableTotalCents\(\{ items: itemRows, fees: feeRows/,
    "the audit total must be computed from the rows that were written",
  );
  assert.doesNotMatch(
    code,
    /payableTotalCents\(\{ items: normalizedItems/,
    "the request does not carry optional/selected, so it overstates the sale",
  );
  // Both branches must go through the shared builders, or the create path
  // reintroduces a second definition of what a row is.
  assert.match(code, /itemRowsFor\(normalizedItems, priorById\(existing\.items\)\)/);
  assert.match(code, /itemRowsFor\(normalizedItems, new Map\(\)\)/, "a new quote has nothing to inherit");
});
