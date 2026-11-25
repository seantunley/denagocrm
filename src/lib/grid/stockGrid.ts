import type { GridColumnDef, GridSort } from "./grid";

/**
 * The live inventory list on /stock as a grid (W2-04): its columns and which of
 * them sort. The SQL for each sort lives next to the query in lib/stockPlatform.ts
 * (STOCK_ORDER) — a fixed fragment per column id, so a URL can only pick one.
 */

export const STOCK_GRID_ID = "stock";

export const STOCK_COLUMNS: readonly GridColumnDef[] = [
  { id: "unit", label: "Unit", sortable: true, required: true, width: 260, mobile: "primary" },
  { id: "status", label: "Status", sortable: true, width: 170, mobile: "field" },
  { id: "customer", label: "Customer / quote", width: 180, mobile: "field" },
  { id: "location", label: "Location", sortable: true, width: 140, mobile: "field" },
  { id: "age", label: "Age", sortable: true, width: 80, mobile: "field" },
  // Only for people with stock.manage — the page removes it for everyone else,
  // which also stops anyone sorting by a figure they cannot see.
  { id: "cost", label: "Landed cost", sortable: true, align: "right", width: 130 },
];

/** Status first (hold, damaged, ready … incoming), oldest within a status — the list's order before the grid. */
export const STOCK_DEFAULT_SORT: GridSort = { column: "status", dir: "asc" };
