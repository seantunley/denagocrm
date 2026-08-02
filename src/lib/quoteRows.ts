/**
 * Rebuilding a quote's item and fee rows without losing what the editor never
 * sends.
 *
 * saveQuoteDraft replaces every row on each save. The editor's payload carries
 * only what it can edit — description, qty, price, discount, product, colour —
 * so `kind`, `costCents`, `optional`, `selected` and per-line VAT have to be
 * inherited from the row being replaced or they revert to schema defaults: the
 * cost basis the margin figure needs, zeroed, and add-ons the customer had
 * DECLINED, silently charged for.
 *
 * Inheriting by id is only half of it. Recreating rows with fresh ids made the
 * inheritance work exactly once: the dialog builds its draft at mount and never
 * re-reads it, so after one save its in-memory ids matched nothing and the
 * second save fell back to the very defaults this exists to prevent. A row that
 * survives the rewrite therefore keeps its id.
 *
 * Reusing an id is safe because it is verified first — it must belong to a row
 * of THIS quote, which is what `prior` holds — and because nothing in the
 * schema holds a foreign key to QuoteItem or QuoteFee, so the delete has no
 * cascade victims to strand. An id the caller made up simply finds no prior row
 * and is dropped, so it can never choose a new record's primary key.
 *
 * Pure and dependency-free so consecutive saves can be tested directly, which
 * is the case that regressed.
 */

export type PriorItem = {
  id: string;
  kind: string;
  taxRatePct: number;
  costCents: number;
  optional: boolean;
  selected: boolean;
};

export type PriorFee = { id: string; taxRatePct: number };

export type IncomingItem = {
  id?: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  productId: string | null;
  colorPreference: string | null;
  discountPct: number;
  /** null means "the caller didn't say" — inherit, don't overwrite. */
  taxRatePct: number | null;
};

export type IncomingFee = {
  id?: string | null;
  label: string;
  kind: string;
  amountCents: number;
  taxRatePct: number | null;
};

export type ItemRow = Omit<IncomingItem, "id" | "taxRatePct"> & {
  id?: string;
  taxRatePct: number;
  kind: string;
  costCents: number;
  optional: boolean;
  selected: boolean;
};

export type FeeRow = Omit<IncomingFee, "id" | "taxRatePct"> & {
  id?: string;
  taxRatePct: number;
  sortOrder: number;
};

/** Index prior rows by id. Empty for a brand-new quote — nothing to inherit. */
export function priorById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function itemRowsFor(incoming: IncomingItem[], prior: Map<string, PriorItem>): ItemRow[] {
  return incoming.map(({ id, taxRatePct, ...rest }) => {
    const previous = id ? prior.get(id) : undefined;
    return {
      // Only a VERIFIED id is carried; an unknown one is dropped, so a new row
      // still gets a generated primary key rather than a caller-chosen one.
      ...(previous ? { id: previous.id } : {}),
      ...rest,
      taxRatePct: taxRatePct ?? previous?.taxRatePct ?? 15,
      kind: previous?.kind ?? "product",
      costCents: previous?.costCents ?? 0,
      optional: previous?.optional ?? false,
      selected: previous?.selected ?? true,
    };
  });
}

export function feeRowsFor(incoming: IncomingFee[], prior: Map<string, PriorFee>): FeeRow[] {
  return incoming.map(({ id, taxRatePct, ...rest }, index) => {
    const previous = id ? prior.get(id) : undefined;
    return {
      ...(previous ? { id: previous.id } : {}),
      ...rest,
      taxRatePct: taxRatePct ?? previous?.taxRatePct ?? 15,
      sortOrder: index,
    };
  });
}
