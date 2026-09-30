import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pageHref, pageWindow, parsePage, searchTerms } from "../src/lib/listPaging";
import { quoteCsv, quoteListWhere, type QuoteExportRow } from "../src/lib/quoteList";

/**
 * Gap #17: quote search only covered the newest 200 quotes, and lists had no
 * paging or export. The list now filters in the database and pages over the
 * full result; the CSV export writes every matching row.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/* A minimal evaluator for the Prisma `where` shapes quoteListWhere emits, so the
 * filter is proved against rows rather than by reading its source. It throws on
 * anything it does not understand, so it cannot silently pass a new shape. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "AND") return (cond as any[]).every((w) => matches(row, w));
    if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond === null || typeof cond !== "object") return value === cond;
    if ("is" in cond) return value !== null && matches(value, cond.is);
    if ("some" in cond) return (value ?? []).some((v: any) => matches(v, cond.some));
    if ("in" in cond) return (cond.in as unknown[]).includes(value);
    if ("contains" in cond) {
      assert.equal(cond.mode, "insensitive");
      return typeof value === "string" && value.toLowerCase().includes(String(cond.contains).toLowerCase());
    }
    throw new Error(`evaluator does not understand ${key}: ${JSON.stringify(cond)}`);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type FakeQuote = QuoteExportRow & { id: string; supersededAt: Date | null; items: Array<{ description: string; qty: number; unitPriceCents: number }> };

/** 250 quotes; number 1 is the OLDEST and would have been cut by the old 200 cap. */
function quotes(): FakeQuote[] {
  return Array.from({ length: 250 }, (_, i) => {
    const n = i + 1;
    const oldest = n === 1;
    return {
      id: `q${n}`,
      number: 1000 + n,
      status: oldest ? "sent" : "draft",
      validUntil: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000),
      supersededAt: null,
      fleetId: oldest ? "flt_kloof" : null,
      contact: oldest
        ? { firstName: "Thandi", lastName: "Mokoena", company: null, email: "thandi@example.co.za", phone: "082 555 0101" }
        : { firstName: `Customer${n}`, lastName: "Generic", company: null, email: `c${n}@example.com`, phone: `011 000 ${n}` },
      lead: oldest ? { title: "Denago Rover XL", name: "Thandi", email: null, phone: null } : null,
      createdBy: { name: "Staff" },
      taxInclusive: true,
      depositType: null,
      depositValue: null,
      fees: [],
      items: [{ description: oldest ? "Rover XL 4-seater" : "Nomad", qty: 1, unitPriceCents: 10_000_00 }],
    };
  });
}

const found = (where: object) => quotes().filter((row) => matches(row, where)).map((row) => row.number);

test("search reaches a quote older than the newest 200 — by number, name, email, phone, model and fleet", () => {
  const all = quotes();
  const newest200 = [...all].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 200);
  assert.ok(!newest200.some((row) => row.number === 1001), "fixture: the target is outside the old cap");

  for (const q of ["1001", "Q-1001", "q1001", "Thandi Mokoena", "thandi@example", "082 555", "Rover XL", "rover 4-seater"]) {
    assert.deepEqual(found(quoteListWhere({ accessibleIds: null, q })), [1001], `search "${q}"`);
  }
  // A fleet quote is found by the fleet's name (resolved to ids by the caller).
  assert.deepEqual(found(quoteListWhere({ accessibleIds: null, q: "Kloof Lodge", fleetIds: ["flt_kloof"] })), [1001]);
  // Status filter still applies, and search AND status combine.
  assert.deepEqual(found(quoteListWhere({ accessibleIds: null, status: "sent" })), [1001]);
  assert.deepEqual(found(quoteListWhere({ accessibleIds: null, status: "draft", q: "Thandi" })), []);
  // No search = every current quote.
  assert.equal(found(quoteListWhere({ accessibleIds: null })).length, 250);
});

test("search never widens RBAC: an owned-only user cannot find a quote outside their ids", () => {
  assert.deepEqual(found(quoteListWhere({ accessibleIds: ["q2"], q: "Thandi" })), []);
  assert.deepEqual(found(quoteListWhere({ accessibleIds: [], q: "" })), []);
  // Even a fleet match is bounded by the RBAC ids.
  assert.deepEqual(found(quoteListWhere({ accessibleIds: ["q2"], q: "Kloof", fleetIds: ["flt_kloof"] })), []);
});

test("superseded revisions stay out of the list", () => {
  const rows = quotes();
  rows[0].supersededAt = new Date();
  assert.equal(rows.filter((row) => matches(row, quoteListWhere({ accessibleIds: null, q: "1001" }))).length, 0);
});

test("the quotes page filters in the database and pages — no newest-200 cap, no in-memory filter", () => {
  const page = shipped("src/app/(app)/quotes/page.tsx");
  assert.doesNotMatch(page, /take:\s*200\b/, "the list query must not be capped at 200");
  assert.doesNotMatch(page, /quotes\.filter\(/, "search/status must not be an in-memory filter of a capped set");
  assert.match(page, /quoteListFilter\(user, \{ q, status \}\)/);
  assert.match(page, /prisma\.quote\.count\(\{ where \}\)/);
  assert.match(page, /where,\s*[\s\S]{0,200}?skip,\s*take,/, "the list query pages with skip/take");
  assert.match(page, /<ListPager path="\/quotes" params=\{params\}/, "the pager gets EVERY search param");
});

test("paging keeps every other param, including ?edit=", () => {
  const params = { edit: "cq_abc", q: "smith", status: "sent", page: "2" };
  const next = new URL(pageHref("/quotes", params, 3), "http://x");
  assert.equal(next.pathname, "/quotes");
  assert.equal(next.searchParams.get("edit"), "cq_abc");
  assert.equal(next.searchParams.get("q"), "smith");
  assert.equal(next.searchParams.get("status"), "sent");
  assert.equal(next.searchParams.get("page"), "3");
  // Page 1 is the canonical URL: no page param, everything else kept.
  assert.equal(pageHref("/quotes", params, 1), "/quotes?edit=cq_abc&q=smith&status=sent");
  assert.equal(pageHref("/contacts", {}, 1), "/contacts");
  assert.equal(pageHref("/contacts", { view: "list", q: undefined }, 2), "/contacts?view=list&page=2");
});

test("page parsing and clamping", () => {
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage("0"), 1);
  assert.equal(parsePage("-3"), 1);
  assert.equal(parsePage("abc"), 1);
  assert.equal(parsePage("2.5"), 1);
  assert.equal(parsePage("4"), 4);
  assert.equal(parsePage(["3", "9"]), 3);
  assert.deepEqual(pageWindow(1, 0), { page: 1, pages: 1, skip: 0, take: 50 });
  assert.deepEqual(pageWindow(2, 120), { page: 2, pages: 3, skip: 50, take: 50 });
  // Past the end (e.g. the last row on the last page was deleted) → the last page.
  assert.deepEqual(pageWindow(9, 120), { page: 3, pages: 3, skip: 100, take: 50 });
  assert.deepEqual(searchTerms("  Q-1022   smith "), ["Q-1022", "smith"]);
});

test("export writes every filtered row and neutralises spreadsheet formulas", () => {
  const rows = quotes();
  rows[1].contact = { firstName: "=HYPERLINK(\"http://evil\")", lastName: null, company: null, email: "+27@x", phone: "-1+1" };
  rows[2].lead = { title: "@SUM(A1)", name: "x", email: null, phone: null };
  const csv = quoteCsv(rows, new Map());
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 251, "header + all 250 rows, not one page");
  assert.match(lines[0], /^"Quote","Status","Customer"/);
  assert.ok(lines[2].includes(`"'=HYPERLINK(""http://evil"")"`), lines[2]);
  assert.ok(lines[2].includes(`"'+27@x"`), lines[2]);
  assert.ok(lines[2].includes(`"'-1+1"`), lines[2]);
  assert.ok(lines[3].includes(`"'@SUM(A1)"`), lines[3]);
  // Money stays a number, so SUM() works on it.
  assert.ok(lines[1].includes(`"10000.00"`), lines[1]);
  assert.ok(lines[1].startsWith(`"Q-1001","sent","Thandi Mokoena"`), lines[1]);
});

test("export route: same filter as the list, no paging, no cap", () => {
  const route = shipped("src/app/api/export/quotes/route.ts");
  assert.match(route, /quoteListFilter\(user, \{ q: params\.get\("q"\), status \}\)/);
  assert.doesNotMatch(route, /\btake:|\bskip:/, "the export must not be paged or capped");
  assert.match(route, /quoteCsv\(/);
  assert.match(route, /withActingStaffScope\(/, "route handlers must bind the acting workspace");
  assert.doesNotMatch(route, /basePrisma/, "never the RLS-bypass client");
  // The export link carries the list's filters but not its page.
  const page = shipped("src/app/(app)/quotes/page.tsx");
  assert.match(page, /href=\{`\/api\/export\/quotes\$\{exportQuery/);
  assert.match(page, /const exportQuery = new URLSearchParams\(\{ \.\.\.\(q\?\.trim\(\) \? \{ q: q\.trim\(\) \} : \{\}\), \.\.\.\(status \? \{ status \} : \{\}\) \}\)/);
});

test("export permission gate is exactly the quotes page's gate", () => {
  const permsIn = (src: string, fn: string) => {
    const m = new RegExp(`${fn}\\(([^)]*)\\)`).exec(src);
    assert.ok(m, `${fn} call`);
    return [...m[1].matchAll(/"([a-z_.]+)"/g)].map((x) => x[1]).sort();
  };
  const layout = permsIn(shipped("src/app/(app)/quotes/layout.tsx"), "requireAnyPermission");
  const page = permsIn(shipped("src/app/(app)/quotes/page.tsx"), "requireAnyPermission");
  const route = shipped("src/app/api/export/quotes/route.ts");
  const exportGate = permsIn(route, "hasAnyPermission");
  assert.deepEqual(exportGate, page);
  assert.deepEqual(exportGate, layout);
  assert.deepEqual(exportGate, ["quotes.view_all", "quotes.view_owned"]);
  // Unauthenticated → 401, lacking the permission → 403, before any query.
  assert.ok(route.indexOf("status: 401") < route.indexOf("quoteListFilter("));
  assert.ok(route.indexOf("status: 403") < route.indexOf("quoteListFilter("));
  // Audit-logged without the search text (it can be a customer's name).
  assert.match(route, /logAudit\(\{\s*action: "quotes\.exported"/);
  assert.doesNotMatch(route, /metadata: \{[^}]*\bq:/);
});

test("the other lists page in the database instead of capping at 200", () => {
  for (const [file, pathName] of [
    ["src/app/(app)/contacts/page.tsx", "/contacts"],
    ["src/app/(app)/leads/list/page.tsx", "/leads/list"],
    ["src/app/(app)/leads/closed/page.tsx", "/leads/closed"],
    ["src/app/(app)/jobcards/page.tsx", "/jobcards"],
  ] as const) {
    const src = shipped(file);
    assert.doesNotMatch(src, /take:\s*200\b/, `${file}: no 200 cap`);
    assert.match(src, /pageWindow\(parsePage\(params\.page\), total\)/, `${file}: paged`);
    assert.match(src, new RegExp(`<ListPager path="${pathName.replace(/\//g, "\\/")}" params=\\{params\\}`), `${file}: pager keeps params`);
  }
  // Job cards: search and status now run in the database too.
  const jobcards = shipped("src/app/(app)/jobcards/page.tsx");
  assert.doesNotMatch(jobcards, /jobCards\.filter\(/);
  assert.match(jobcards, /searchTerms\(q\)/);
  // Saved lead views must not capture the page number.
  assert.match(shipped("src/app/(app)/leads/list/page.tsx"), /key !== "page"/);
});
