import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  EMPTY_SELECTION,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  checkSelectedIds,
  defaultPrefs,
  gridOrderBy,
  gridPrefsKey,
  normalisePrefs,
  parseSelectionRequest,
  parseSort,
  selectAllMatching,
  selectedCount,
  selectionPreviewText,
  sortHref,
  togglePage,
  toggleRow,
  visibleColumns,
  type GridColumnDef,
} from "../src/lib/grid/grid";
import { CONTACT_COLUMNS, CONTACT_DEFAULT_SORT, CONTACT_SORTS, contactListWhere } from "../src/lib/grid/contactsGrid";

/**
 * W2-04 — the configurable data grid. The grid may change how a list LOOKS and
 * the ORDER it comes in; it must never change WHAT is in it, and it must never
 * select rows nobody chose.
 */

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const COLS: GridColumnDef[] = [
  { id: "name", label: "Name", sortable: true, required: true },
  { id: "email", label: "Email", sortable: true, width: 200 },
  { id: "tags", label: "Tags" },
  { id: "city", label: "City", sortable: true, defaultVisible: false },
];

test("defaults: declared order, default-hidden columns hidden, comfortable", () => {
  assert.deepEqual(defaultPrefs(COLS), { order: ["name", "email", "tags", "city"], hidden: ["city"], widths: {}, density: "comfortable" });
  assert.equal(gridPrefsKey("contacts", "u1"), "GRID_PREFS:contacts:u1", "per grid AND per user");
});

test("saved prefs: unknown ids dropped, new columns appended, widths clamped, junk ignored", () => {
  const saved = JSON.stringify({
    order: ["tags", "gone", "name", "tags", 7],
    hidden: ["email", "gone"],
    widths: { email: 9999, tags: 3, gone: 120, name: "wide", city: Number.NaN },
    density: "compact",
  });
  const prefs = normalisePrefs(saved, COLS);
  assert.deepEqual(prefs.order, ["tags", "name", "email", "city"], "stale id gone, duplicates gone, missing columns appended");
  assert.deepEqual(prefs.hidden, ["email"]);
  assert.deepEqual(prefs.widths, { email: MAX_COLUMN_WIDTH, tags: MIN_COLUMN_WIDTH });
  assert.equal(prefs.density, "compact");
});

test("saved prefs can never hide the row's name, nor every column, and garbage is the default", () => {
  assert.deepEqual(normalisePrefs({ hidden: ["name", "email"] }, COLS).hidden, ["email"]);
  const two: GridColumnDef[] = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  assert.deepEqual(normalisePrefs({ hidden: ["a", "b"] }, two).hidden, [], "hiding all shows all");
  for (const junk of [null, undefined, "{not json", "[]", 42, { density: "huge" }]) {
    const p = normalisePrefs(junk, COLS);
    assert.deepEqual(p.order, ["name", "email", "tags", "city"]);
    assert.equal(p.density, "comfortable");
  }
});

test("visible columns follow the saved order and skip hidden ones", () => {
  const prefs = normalisePrefs({ order: ["city", "name"], hidden: ["tags"] }, COLS);
  assert.deepEqual(visibleColumns(prefs, COLS).map((c) => c.id), ["city", "name", "email"]);
});

test("sort params: only declared sortable columns, otherwise the default", () => {
  const fallback = { column: "name", dir: "asc" as const };
  assert.deepEqual(parseSort("email", "desc", COLS, fallback), { column: "email", dir: "desc" });
  assert.deepEqual(parseSort("email", "sideways", COLS, fallback), { column: "email", dir: "asc" });
  assert.deepEqual(parseSort(["city", "x"], undefined, COLS, fallback), { column: "city", dir: "asc" });
  assert.deepEqual(parseSort("tags", "desc", COLS, fallback), fallback, "declared but not sortable");
  assert.deepEqual(parseSort("tenantId", "desc", COLS, fallback), fallback, "undeclared");
  assert.deepEqual(parseSort(undefined, undefined, COLS, fallback), fallback);
});

test("every order ends in the id tie-breaker, so paging never repeats or skips a row", () => {
  assert.deepEqual(gridOrderBy({ column: "customer", dir: "asc" }, CONTACT_SORTS), [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }]);
  assert.deepEqual(gridOrderBy({ column: "owner", dir: "desc" }, CONTACT_SORTS), [{ owner: { name: "desc" } }, { id: "desc" }]);
  // The default is exactly the order the contacts list always had.
  assert.deepEqual(gridOrderBy(CONTACT_DEFAULT_SORT, CONTACT_SORTS), [{ createdAt: "desc" }, { id: "desc" }]);
  // Every sortable contact column has an orderBy, and nothing else does.
  const sortable = CONTACT_COLUMNS.filter((c) => c.sortable).map((c) => c.id).sort();
  assert.deepEqual(Object.keys(CONTACT_SORTS).sort(), sortable);
});

test("sort links keep search and view, flip direction, and go back to page 1", () => {
  const params = { q: "smith", view: "list", page: "3" };
  assert.equal(sortHref("/contacts", params, "customer", CONTACT_DEFAULT_SORT), "/contacts?q=smith&view=list&sort=customer&dir=asc");
  assert.equal(sortHref("/contacts", { ...params, sort: "customer", dir: "asc" }, "customer", { column: "customer", dir: "asc" }), "/contacts?q=smith&view=list&sort=customer&dir=desc");
  assert.equal(sortHref("/contacts", {}, "added", { column: "added", dir: "desc" }), "/contacts?sort=added&dir=asc");
});

test("selecting every row on a page selects THAT page — all-across-pages is only ever explicit", () => {
  const page = ["a", "b", "c"];
  let sel = togglePage(EMPTY_SELECTION, page);
  assert.deepEqual(sel, { ids: ["a", "b", "c"], allMatching: false });
  assert.equal(selectedCount(sel, 1200), 3, "not 1,200");
  sel = toggleRow(sel, "b");
  assert.deepEqual(sel.ids, ["a", "c"]);
  sel = togglePage(sel, page);
  assert.deepEqual(sel.ids, ["a", "c", "b"]);
  sel = togglePage(sel, page);
  assert.deepEqual(sel.ids, [], "page box clears the page");

  const all = selectAllMatching();
  assert.equal(selectedCount(all, 1200), 1200);
  assert.equal(toggleRow(all, "a"), all, "locked while all-matching is on");
  assert.equal(togglePage(all, page), all);
  // And the only way the UI reaches it is the explicit button.
  const client = src("src/components/grid/GridClient.tsx");
  assert.equal((client.match(/selectAllMatching\(\)/g) ?? []).length, 1);
  assert.match(client, /onClick=\{\(\) => setSel\(selectAllMatching\(\)\)\}/);
});

test("a selection request can only name ids or 'all matching this search' — never a scope", () => {
  assert.deepEqual(parseSelectionRequest({ mode: "ids", ids: ["a", "a", "b", 3, "x'; drop", ""] }), { mode: "ids", ids: ["a", "b"] });
  assert.equal(parseSelectionRequest({ mode: "ids", ids: [] }), null);
  assert.equal(parseSelectionRequest({ mode: "ids", ids: Array.from({ length: 501 }, (_, i) => `id${i}`) }), null);
  assert.deepEqual(
    parseSelectionRequest({ mode: "all", q: " smith ", shownTotal: 40, tenantId: "other", accessibleIds: null, where: {} }),
    { mode: "all", q: "smith", shownTotal: 40 },
    "extra keys are dropped, not honoured",
  );
  assert.equal(parseSelectionRequest({ mode: "all", shownTotal: -1 }), null);
  assert.equal(parseSelectionRequest({ mode: "everything" }), null);
  assert.equal(parseSelectionRequest(null), null);
});

test("the bulk re-check refuses ids the person cannot see, and says so", () => {
  const { allowed, refused } = checkSelectedIds(["mine1", "theirs", "mine2", "deleted"], ["mine1", "mine2", "mine3"]);
  assert.deepEqual(allowed, ["mine1", "mine2"]);
  assert.equal(refused, 2);
  assert.equal(
    selectionPreviewText({ one: "contact", many: "contacts" }, { allowed: 2, refused: 2 }),
    "2 contacts in this selection · 2 contacts left out — no longer available to you",
  );
  assert.equal(
    selectionPreviewText({ one: "contact", many: "contacts" }, { allowed: 1199, refused: 0, shownTotal: 1200 }),
    "1,199 contacts in this selection · the list showed 1,200; it has changed since",
  );
  // The action re-checks in the database, inside the workspace and the caller's access.
  const action = src("src/app/actions/grid.ts");
  assert.match(action, /where: \{ AND: \[contactListWhere\(\{ tenantId, accessibleIds \}\), \{ id: \{ in: request\.ids \} \}\] \}/);
  assert.match(action, /checkSelectedIds\(request\.ids, found\.map\(\(row\) => row\.id\)\)/);
  assert.match(action, /where: contactListWhere\(\{ tenantId, accessibleIds, q: request\.q \}\)/);
});

test("the contacts scope cannot be widened by grid params", () => {
  const where = contactListWhere({ tenantId: "t1", accessibleIds: ["a", "b"], q: "smith" });
  const parts = (where.AND as object[]);
  assert.deepEqual(parts[0], { tenantId: "t1" }, "always names the workspace");
  assert.deepEqual(parts[1], { id: { in: ["a", "b"] } }, "always the viewer's access");
  // The search only ever ANDs on — it cannot OR its way past the scope.
  assert.equal(parts.length, 3);
  assert.deepEqual(contactListWhere({ tenantId: null, accessibleIds: null }).AND, [{ id: { in: [] } }, {}], "no workspace = nothing");

  // The page builds its rows from that where alone; sort/dir/page only order and window it.
  const page = src("src/app/(app)/contacts/page.tsx");
  assert.match(page, /const where = contactListWhere\(\{ tenantId, accessibleIds, q \}\);/);
  assert.match(page, /orderBy: gridOrderBy\(sort, CONTACT_SORTS\)/);
  assert.doesNotMatch(page, /params\.(sort|dir)[^\n]*where/);
  assert.match(page, /pageWindow\(parsePage\(params\.page\), total\)/);
});

test("prefs are saved per user, per workspace, only for a known list, and validated server-side", () => {
  const action = src("src/app/actions/grid.ts");
  assert.match(action, /Object\.hasOwn\(GRIDS, gridId\)/);
  assert.match(action, /if \(!grid \|\| !\(await hasAnyPermission\(user, \.\.\.grid\.read\)\)\) refuse\(/);
  assert.match(action, /putWorkspaceSetting\(tenantId, key, prefs === null \? "" : JSON\.stringify\(normalisePrefs\(prefs, grid\.columns\)\)\)/);
  assert.match(action, /const key = gridPrefsKey\(gridId, user\.id\);/);
  const page = src("src/app/(app)/contacts/page.tsx");
  assert.match(page, /getWorkspaceSetting\(tenantId, gridPrefsKey\(CONTACTS_GRID_ID, user\.id\)\)/);
  assert.match(page, /normalisePrefs\(savedPrefs, columns\)/);
});

test("phones get cards, not a sideways-scrolling table", () => {
  const grid = src("src/components/grid/DataGrid.tsx");
  assert.match(grid, /<ResponsiveDataView mobile=\{mobile\} desktop=\{desktop\} \/>/);
  assert.match(grid, /<MobileDataCard key=\{rowId\(row\)\}>/);
  assert.match(grid, /<thead className="sticky top-0/);
  assert.match(grid, /aria-sort=/);
});
