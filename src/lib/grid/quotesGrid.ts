import type { Prisma } from "@prisma/client";
import type { GridColumnDef, GridSort, SortDir } from "./grid";

/**
 * The quote register as a grid (W2-04): its columns and which of them sort.
 *
 * WHICH quotes are listed is NOT decided here — that stays quoteListFilter
 * (lib/quoteListQuery.ts), shared with the CSV export. This only orders them.
 */

export const QUOTES_GRID_ID = "quotes";

export const QUOTE_COLUMNS: readonly GridColumnDef[] = [
  { id: "number", label: "#", sortable: true, required: true, width: 110, mobile: "primary" },
  { id: "customer", label: "Customer", sortable: true, width: 200, mobile: "field" },
  { id: "lead", label: "Lead", sortable: true, width: 220 },
  // Not sortable: the total is worked out from the lines, and the register can
  // hold more than one currency — ordering 100 USD against 100 ZAR means nothing.
  { id: "total", label: "Total", width: 140, mobile: "field" },
  { id: "status", label: "Status", sortable: true, width: 120, mobile: "field" },
  { id: "validUntil", label: "Valid until", sortable: true, width: 130 },
  { id: "created", label: "Created", sortable: true, width: 190 },
  { id: "actions", label: "Actions", align: "right", width: 320 },
];

/** Newest first — what the register has always shown. */
export const QUOTE_DEFAULT_SORT: GridSort = { column: "created", dir: "desc" };

/** Column → orderBy. `gridOrderBy` appends the id tie-breaker. */
export const QUOTE_SORTS: Record<string, (dir: SortDir) => Prisma.QuoteOrderByWithRelationInput[]> = {
  number: (dir) => [{ number: dir }],
  customer: (dir) => [{ contact: { firstName: dir } }, { contact: { lastName: dir } }],
  lead: (dir) => [{ lead: { title: dir } }],
  status: (dir) => [{ status: dir }],
  validUntil: (dir) => [{ validUntil: dir }],
  created: (dir) => [{ createdAt: dir }],
};
