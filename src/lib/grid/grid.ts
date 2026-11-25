/**
 * The configurable data grid (W2-04) — the pure part: column declarations, the
 * per-user preferences a person keeps for a list, the URL sort, and the bulk
 * selection model.
 *
 * Pure on purpose — no database, no React — so every rule here is unit-tested
 * directly (tests/dataGrid.test.ts). The grid only ever ORDERS and PRESENTS rows
 * the page has already scoped; nothing in this file can add to or widen a query's
 * `where`.
 */

import { pageHref, type ListSearchParams } from "@/lib/listPaging";

export type GridAlign = "left" | "center" | "right";
export type GridDensity = "comfortable" | "compact";
export type SortDir = "asc" | "desc";

export type GridColumnDef = {
  id: string;
  label: string;
  /** Sortable on the SERVER — the consumer maps the id to an orderBy. */
  sortable?: boolean;
  /** Shown until the person hides it. Defaults to true. */
  defaultVisible?: boolean;
  /** The row's identity (its name): always shown, cannot be hidden. */
  required?: boolean;
  /** Default width in px. Omitted = the table shares space out itself. */
  width?: number;
  align?: GridAlign;
  /** On a phone: the card's title, or one of its labelled fields. Omitted = desktop only. */
  mobile?: "primary" | "field";
};

export type GridPrefs = {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  density: GridDensity;
};

export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 640;
const DENSITIES: readonly GridDensity[] = ["comfortable", "compact"];

/** Where one person's preferences for one list live, inside their workspace's settings. */
export const gridPrefsKey = (gridId: string, userId: string) => `GRID_PREFS:${gridId}:${userId}`;

export function defaultPrefs(columns: readonly GridColumnDef[]): GridPrefs {
  return {
    order: columns.map((c) => c.id),
    hidden: columns.filter((c) => c.defaultVisible === false && !c.required).map((c) => c.id),
    widths: {},
    density: "comfortable",
  };
}

/**
 * Saved preferences, made safe against the columns the list declares TODAY.
 *
 * Preferences outlive code: a column is renamed, removed or added after someone
 * saved their layout. So nothing stored is trusted — unknown ids are dropped, new
 * columns appear in their declared place at the end, widths are clamped, a
 * required column can never be hidden, and anything unreadable is the default.
 * A stale or tampered preference can change how a list LOOKS, never break it.
 */
export function normalisePrefs(raw: unknown, columns: readonly GridColumnDef[]): GridPrefs {
  const fallback = defaultPrefs(columns);
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  const known = new Map(columns.map((c) => [c.id, c]));
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && known.has(x)) : null);

  const savedOrder = strings(input.order);
  const order = savedOrder ? [...new Set(savedOrder)] : [];
  for (const c of columns) if (!order.includes(c.id)) order.push(c.id);

  const savedHidden = strings(input.hidden);
  const hidden = savedHidden
    ? [...new Set(savedHidden)].filter((id) => !known.get(id)?.required)
    : fallback.hidden;
  // Hiding every column would leave a list of empty rows; show them all instead.
  const safeHidden = hidden.length >= columns.length ? [] : hidden;

  const widths: Record<string, number> = {};
  if (input.widths && typeof input.widths === "object" && !Array.isArray(input.widths)) {
    for (const [id, w] of Object.entries(input.widths as Record<string, unknown>)) {
      if (!known.has(id) || typeof w !== "number" || !Number.isFinite(w)) continue;
      widths[id] = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));
    }
  }

  const density = DENSITIES.includes(input.density as GridDensity) ? (input.density as GridDensity) : fallback.density;
  return { order, hidden: safeHidden, widths, density };
}

/** The columns to draw, in the person's order, without the hidden ones. */
export function visibleColumns<C extends GridColumnDef>(prefs: GridPrefs, columns: readonly C[]): C[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  return prefs.order
    .map((id) => byId.get(id))
    .filter((c): c is C => !!c && !prefs.hidden.includes(c.id));
}

export const columnWidth = (prefs: GridPrefs, column: GridColumnDef) => prefs.widths[column.id] ?? column.width;

/* ------------------------------------------------------------------ sort */

export type GridSort = { column: string; dir: SortDir };

const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw);

/**
 * `?sort=&dir=` as a sort the list actually supports. Anything else — an unknown
 * or unsortable column, a crafted value — is the list's default, so a URL can
 * only ever choose among the orders the page declared.
 */
export function parseSort(
  sortRaw: string | string[] | undefined,
  dirRaw: string | string[] | undefined,
  columns: readonly GridColumnDef[],
  fallback: GridSort,
): GridSort {
  const column = columns.find((c) => c.sortable && c.id === first(sortRaw));
  if (!column) return fallback;
  const dir = first(dirRaw);
  return { column: column.id, dir: dir === "desc" ? "desc" : "asc" };
}

/**
 * The orderBy for a sort, ALWAYS ending in the row id. Two rows with the same
 * name or date otherwise come back in whatever order the database likes, and a
 * row can then appear on page 1 and again on page 2 while another is never shown.
 */
export function gridOrderBy<O>(
  sort: GridSort,
  map: Record<string, (dir: SortDir) => O[]>,
): (O | { id: SortDir })[] {
  const by = map[sort.column];
  return [...(by ? by(sort.dir) : []), { id: sort.dir }];
}

/**
 * The header link for a column: same column flips direction, a new one starts
 * ascending. Every other param (search, view, filters) is kept; the page number
 * is dropped, because page 3 of a different order is a meaningless place.
 */
export function sortHref(path: string, params: ListSearchParams, column: string, current: GridSort): string {
  const dir: SortDir = current.column === column && current.dir === "asc" ? "desc" : "asc";
  const rest: ListSearchParams = { ...params, sort: column, dir };
  return pageHref(path, rest, 1);
}

/* ------------------------------------------------------------- selection */

/**
 * What the person has ticked. `allMatching` is ONLY ever set by the explicit
 * "Select all N" button — ticking every row on the page selects that page, never
 * the rows on pages nobody has seen.
 */
export type GridSelection = { ids: string[]; allMatching: boolean };
export const EMPTY_SELECTION: GridSelection = { ids: [], allMatching: false };

export function toggleRow(sel: GridSelection, id: string): GridSelection {
  if (sel.allMatching) return sel; // locked while "all matching" is on — clear it first
  return { ids: sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id], allMatching: false };
}

export function togglePage(sel: GridSelection, pageIds: readonly string[]): GridSelection {
  if (sel.allMatching) return sel;
  const allOn = pageIds.length > 0 && pageIds.every((id) => sel.ids.includes(id));
  return {
    ids: allOn ? sel.ids.filter((id) => !pageIds.includes(id)) : [...new Set([...sel.ids, ...pageIds])],
    allMatching: false,
  };
}

export const selectAllMatching = (): GridSelection => ({ ids: [], allMatching: true });

export const selectedCount = (sel: GridSelection, total: number) => (sel.allMatching ? total : sel.ids.length);

/** The largest explicit id list the server will check in one go. */
export const MAX_SELECTED_IDS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A selection as the server receives it — the ONLY things a client can say:
 * these ids, or "every row matching this search". Never a filter, a scope or a
 * tenant: the server rebuilds the scope itself and intersects.
 */
export type SelectionRequest =
  | { mode: "ids"; ids: string[] }
  | { mode: "all"; q: string; shownTotal: number };

export function parseSelectionRequest(raw: unknown): SelectionRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (input.mode === "all") {
    const shownTotal = Number(input.shownTotal);
    if (!Number.isSafeInteger(shownTotal) || shownTotal < 0) return null;
    return { mode: "all", q: typeof input.q === "string" ? input.q.trim().slice(0, 200) : "", shownTotal };
  }
  if (input.mode === "ids" && Array.isArray(input.ids)) {
    const ids = [...new Set(input.ids.filter((x): x is string => typeof x === "string" && ID_PATTERN.test(x)))];
    if (ids.length === 0 || ids.length > MAX_SELECTED_IDS) return null;
    return { mode: "ids", ids };
  }
  return null;
}

/** Every requested id re-checked against what this person may see now. */
export function checkSelectedIds(requested: readonly string[], accessible: readonly string[]) {
  const allowed = new Set(accessible);
  const ok = requested.filter((id) => allowed.has(id));
  return { allowed: ok, refused: requested.length - ok.length };
}

/** The most rows one bulk action will change, even with "Select all". */
export const MAX_BULK_ROWS = 2000;

/**
 * What a bulk action DID, row by row. Rows it could not touch are counted, never
 * named: naming them would tell the person about records they may not see.
 */
export function bulkResultText(
  noun: { one: string; many: string },
  labels: { done: string; unchanged: string },
  result: { done: number; unchanged: number; refused: number },
): string {
  const name = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? noun.one : noun.many}`;
  const parts = result.done > 0 ? [`${name(result.done)} ${labels.done}`] : ["Nothing changed"];
  if (result.unchanged > 0) parts.push(`${name(result.unchanged)} ${labels.unchanged}`);
  if (result.refused > 0) parts.push(`${name(result.refused)} couldn't be changed — no longer available to you`);
  return parts.join(" · ");
}

/** The preview sentence: what an action WOULD touch, and what was left out and why. */
export function selectionPreviewText(
  noun: { one: string; many: string },
  result: { allowed: number; refused: number; shownTotal?: number },
): string {
  const name = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? noun.one : noun.many}`;
  const parts = [`${name(result.allowed)} in this selection`];
  if (result.refused > 0) parts.push(`${name(result.refused)} left out — no longer available to you`);
  if (result.shownTotal !== undefined && result.shownTotal !== result.allowed) {
    parts.push(`the list showed ${result.shownTotal.toLocaleString("en")}; it has changed since`);
  }
  return parts.join(" · ");
}
