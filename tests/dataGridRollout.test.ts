import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { MAX_BULK_ROWS, bulkResultText, gridOrderBy, parseSort, sortHref } from "../src/lib/grid/grid";
import { QUOTE_COLUMNS, QUOTE_DEFAULT_SORT, QUOTE_SORTS } from "../src/lib/grid/quotesGrid";
import { STOCK_COLUMNS, STOCK_DEFAULT_SORT } from "../src/lib/grid/stockGrid";

/**
 * W2-04, second slice: the grid on the quote register and the stock list, and
 * the grid's one bulk action (Add tag on contacts). The grid may change how a
 * list looks and the order it comes in — never which rows are in it — and a
 * bulk action may only touch rows that were chosen, checked and allowed.
 */

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const body = (file: string, name: string) => {
  const code = src(file);
  const start = code.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} in ${file}`);
  const next = code.indexOf("\nexport ", start + 1);
  return code.slice(start, next === -1 ? undefined : next);
};

/* ------------------------------------------------------------- bulk text */

test("a bulk result counts what it did and what it skipped — and never names a skipped row", () => {
  const noun = { one: "contact", many: "contacts" };
  const labels = { done: "tagged", unchanged: "already had it" };
  assert.equal(bulkResultText(noun, labels, { done: 7, unchanged: 0, refused: 2 }), "7 contacts tagged · 2 contacts couldn't be changed — no longer available to you");
  assert.equal(bulkResultText(noun, labels, { done: 1, unchanged: 3, refused: 0 }), "1 contact tagged · 3 contacts already had it");
  assert.equal(bulkResultText(noun, labels, { done: 0, unchanged: 0, refused: 4 }), "Nothing changed · 4 contacts couldn't be changed — no longer available to you");
  assert.equal(bulkResultText(noun, labels, { done: 1500, unchanged: 0, refused: 0 }), "1,500 contacts tagged");
  assert.equal(MAX_BULK_ROWS, 2000);
});

/* ---------------------------------------------------------------- quotes */

test("quotes: the default order is exactly the register's old one, and every order ends in the id", () => {
  assert.deepEqual(gridOrderBy(QUOTE_DEFAULT_SORT, QUOTE_SORTS), [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(gridOrderBy({ column: "customer", dir: "asc" }, QUOTE_SORTS), [
    { contact: { firstName: "asc" } },
    { contact: { lastName: "asc" } },
    { id: "asc" },
  ]);
  const sortable = QUOTE_COLUMNS.filter((c) => c.sortable).map((c) => c.id).sort();
  assert.deepEqual(Object.keys(QUOTE_SORTS).sort(), sortable, "every sortable column has an orderBy, and nothing else does");
});

test("quotes: the total never sorts — quotes in different currencies cannot be ordered against each other", () => {
  assert.equal(QUOTE_COLUMNS.find((c) => c.id === "total")?.sortable, undefined);
  assert.deepEqual(parseSort("total", "desc", QUOTE_COLUMNS, QUOTE_DEFAULT_SORT), QUOTE_DEFAULT_SORT);
  const page = src("src/app/(app)/quotes/page.tsx");
  // Each row in its own currency; the headline still totals per currency.
  assert.match(page, /formatZAR\(Math\.round\(payableTotalCents\(quote\)\), withCurrency\(moneyFmt, quote\.currency\)\)/);
  assert.match(page, /totalsByCurrency\(openQuotes,/);
});

test("quotes: the rows still come from quoteListFilter; the grid only orders and windows them", () => {
  const page = src("src/app/(app)/quotes/page.tsx");
  assert.match(page, /const \{ where, all \} = await quoteListFilter\(user, \{ q, status \}\)/);
  assert.match(page, /prisma\.quote\.findMany\(\{\s*where,[\s\S]{0,160}orderBy: gridOrderBy\(sort, QUOTE_SORTS\),/);
  assert.match(page, /const sort = parseSort\(params\.sort, params\.dir, QUOTE_COLUMNS, QUOTE_DEFAULT_SORT\);/);
  assert.doesNotMatch(page, /params\.(sort|dir)[^\n]*where/);
  assert.match(page, /getWorkspaceSetting\(scope\.tenantId, gridPrefsKey\(QUOTES_GRID_ID, user\.id\)\)/);
  // The filter form keeps the sort; old links (?q=&status=&page=&edit=) need nothing new.
  assert.match(page, /\{params\.sort && <><input type="hidden" name="sort" value=\{sort\.column\} \/><input type="hidden" name="dir" value=\{sort\.dir\} \/><\/>\}/);
});

test("quotes: sort links never carry ?edit=, so sorting cannot reopen a closed quote (#696)", () => {
  const page = src("src/app/(app)/quotes/page.tsx");
  assert.match(page, /const \{ edit: _edit, \.\.\.gridParams \} = params;/);
  assert.match(page, /params=\{gridParams\}/);
  const { edit: _edit, ...gridParams } = { edit: "cq_old", q: "smith", status: "sent", page: "3" };
  void _edit;
  assert.equal(sortHref("/quotes", gridParams, "number", QUOTE_DEFAULT_SORT), "/quotes?q=smith&status=sent&sort=number&dir=asc");
  // The pager keeps reading the live URL, as before.
  assert.match(page, /<ListPager path="\/quotes" page=\{page\} total=\{total\}/);
});

/* ----------------------------------------------------------------- stock */

test("stock: every sortable column has a fixed SQL fragment, and the URL can only pick one", () => {
  const platform = src("src/lib/stockPlatform.ts");
  const map = platform.slice(platform.indexOf("const STOCK_ORDER"), platform.indexOf("function stockListConditions"));
  const keys = [...map.matchAll(/^\s+(\w+): \(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, STOCK_COLUMNS.filter((c) => c.sortable).map((c) => c.id).sort());
  assert.match(platform, /Object\.hasOwn\(STOCK_ORDER, filters\.sort\?\.column \?\? ""\)/);
  assert.match(platform, /const dir = desc \? Prisma\.sql`DESC` : Prisma\.sql`ASC`;/);
  assert.match(platform, /ORDER BY \$\{order\}, su\."id" \$\{dir\}/, "id tie-breaker on every order");
  assert.deepEqual(STOCK_DEFAULT_SORT, { column: "status", dir: "asc" }, "status first, oldest first — the old order");
});

test("stock: the count and the rows share one set of conditions, and the count names the workspace", () => {
  const platform = src("src/lib/stockPlatform.ts");
  const count = body("src/lib/stockPlatform.ts", "countStockUnits");
  assert.match(count, /WHERE su\."tenantId" = \$\{tenantId\} AND \$\{Prisma\.join\(stockListConditions\(filters\), " AND "\)\}/);
  assert.match(body("src/lib/stockPlatform.ts", "listStockUnits"), /const conditions = stockListConditions\(filters\);/);
  // The search joins are the same, so a search on PO reference or customer counts what it lists.
  for (const join of ['LEFT JOIN "PurchaseOrder" po', 'LEFT JOIN "Lead" l', 'JOIN "Product" p']) {
    assert.ok(count.includes(join), join);
  }
  assert.ok(platform.includes("export async function countStockUnits("));
});

test("stock: paged in the database, filters as before, cost only for stock managers", () => {
  const page = src("src/app/(app)/stock/page.tsx");
  assert.match(page, /const totalUnits = await countStockUnits\(tenantId, filters\);/);
  assert.match(page, /pageWindow\(parsePage\(params\.page\), totalUnits\)/);
  assert.match(page, /listStockUnits\(\{ \.\.\.filters, sort, limit: take, offset: skip \}\)/);
  assert.doesNotMatch(page, /limit: 150/, "no silent cap");
  assert.match(page, /<ListPager path="\/stock" page=\{page\} total=\{totalUnits\}/);
  assert.match(page, /const filters = \{ status, query: params\.q, productId: params\.product, location: params\.location, age: params\.age \};/);
  // Without stock.manage the cost column is gone — and so is sorting by it.
  assert.match(page, /const columns = canManage \? STOCK_COLUMNS : STOCK_COLUMNS\.filter\(\(c\) => c\.id !== "cost"\);/);
  const viewer = STOCK_COLUMNS.filter((c) => c.id !== "cost");
  assert.deepEqual(parseSort("cost", "desc", viewer, STOCK_DEFAULT_SORT), STOCK_DEFAULT_SORT);
  // Status chips and the filter form keep the chosen sort.
  assert.match(page, /if \(params\.sort\) \{ query\.set\("sort", sort\.column\); query\.set\("dir", sort\.dir\); \}/);
  // The PDF report is unchanged: same filters, default order.
  assert.match(src("src/app/api/pdf/stock-report/route.tsx"), /listStockUnits\(\{ status, query: q, productId: product, location, age, limit: REPORT_LIMIT \}\)/);
});

test("layouts can be saved for the two new lists, by people who may open them", () => {
  const action = src("src/app/actions/grid.ts");
  assert.match(action, /\[QUOTES_GRID_ID\]: \{ columns: QUOTE_COLUMNS, path: "\/quotes", read: \["quotes\.view_all", "quotes\.view_owned"\] \}/);
  assert.match(action, /\[STOCK_GRID_ID\]: \{ columns: STOCK_COLUMNS, path: "\/stock", read: \["stock\.view", "stock\.manage"\] \}/);
});

/* ------------------------------------------------------- bulk: add a tag */

test("bulk Add tag: permission first, then every row re-checked in this workspace and the caller's access", () => {
  const fn = body("src/app/actions/grid.ts", "bulkTagContacts");
  assert.match(fn, /^export async function bulkTagContacts\(raw: unknown, tagId: unknown\) \{\n  return withActingStaffScope\(\(\) =>\n    asActionResult\(async \(\) => \{/);
  // The same permission as editing one contact, before anything is read.
  assert.ok(fn.indexOf('requirePermission("contacts.edit")') < fn.indexOf("parseSelectionRequest(raw)"));
  // The tag must already exist in THIS workspace — none is created.
  assert.match(fn, /prisma\.tag\.findFirst\(\{ where: \{ id: tagId, tenantId \}, select: \{ id: true, name: true \} \}\)/);
  assert.doesNotMatch(fn, /tag\.(create|upsert)/);
  assert.match(fn, /const accessibleIds = await getAccessibleContactIds\(user\);/);
  // Ticked ids: intersected in the database with the workspace and the caller's access.
  assert.match(fn, /where: \{ AND: \[contactListWhere\(\{ tenantId, accessibleIds \}\), \{ id: \{ in: request\.ids \} \}\] \}/);
  assert.match(fn, /checkSelectedIds\(request\.ids, found\.map\(\(row\) => row\.id\)\)/);
  // Only allowed rows are written.
  assert.match(fn, /for \(const contactId of allowed\) \{/);
  assert.match(fn, /INSERT INTO "_ContactToTag" \("A","B"\) VALUES \(\$\{contactId\},\$\{tag\.id\}\) ON CONFLICT DO NOTHING/);
  assert.match(fn, /logAudit\(\{ action: "contact\.tagged", summary: `Added tag “\$\{tag\.name\}” \(bulk\)`, contactId, user \}\)/);
  assert.match(fn, /bulkResultText\(/);
});

test("bulk Add tag: 'all matching' is rebuilt from the search alone, capped, and refused if the list has moved", () => {
  const fn = body("src/app/actions/grid.ts", "bulkTagContacts");
  assert.match(fn, /const where = contactListWhere\(\{ tenantId, accessibleIds, q: request\.q \}\);/);
  assert.match(fn, /if \(total !== request\.shownTotal\) refuse\(/);
  assert.match(fn, /if \(total > MAX_BULK_ROWS\) refuse\(/);
});

test("the bulk button appears only after a preview of the SAME ticks, and says what and how many", () => {
  const client = src("src/components/grid/GridClient.tsx");
  // Any change to the ticks drops the preview.
  assert.match(client, /const setSel = \(next: GridSelection\) => \{\n    setSelState\(next\);\n    setResult\(null\);\n    setPreviewed\(false\);\n  \};/);
  assert.match(client, /setPreviewed\(!next\.error\);/);
  assert.match(client, /\{bulk && chosen && previewed && \(/);
  assert.match(client, /\{bulk\.label\} “\{chosen\.label\}” to \{scope\}/);
  assert.match(client, /const scope = sel\.allMatching \? `all \$\{name\(total\)\} matching` : `\$\{name\(count\)\} on this page`;/);
  // One click, one run: the button goes before the action is sent.
  assert.match(client, /setPreviewed\(false\);\n      const next = await bulk\.run\(request\(\), chosen\.value\);/);
});

test("contacts offer the bulk tag only to people who may edit contacts, with this workspace's tags", () => {
  const page = src("src/app/(app)/contacts/page.tsx");
  assert.match(page, /canEdit && tenantId && !cards\n      \? prisma\.tag\.findMany\(\{ where: \{ tenantId \}, orderBy: \{ name: "asc" \}, select: \{ id: true, name: true \} \}\)/);
  assert.match(page, /bulk=\{tags\.length \? \{ label: "Add tag", choiceLabel: "Tag", choices: tags\.map\(\(tag\) => \(\{ value: tag\.id, label: tag\.name \}\)\), run: bulkTagContacts \} : undefined\}/);
});

test("help says how the new lists sort and how bulk tagging works", () => {
  const crm = src("src/lib/help/data/crm.json");
  assert.match(crm, /Add tag “VIP” to 12 contacts on this page/);
  assert.match(src("src/lib/help/data/sales.json"), /You can't sort by total/);
  assert.match(src("src/lib/help/data/stock.json"), /The list shows 50 units a page/);
  for (const file of ["crm", "sales", "stock"]) assert.doesNotMatch(src(`src/lib/help/data/${file}.json`), /\bDAX\b/);
});
