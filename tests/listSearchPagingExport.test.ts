import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pageHref, pageWindow, parsePage, searchTerms } from "../src/lib/listPaging";
import { matchingFleetIds, quoteCsv, quoteListWhere, type QuoteExportRow } from "../src/lib/quoteList";
import type { BillToFleet } from "../src/lib/quoteBillTo";
import { loadQuoteVersions, quoteVersionIndex } from "../src/lib/quoteVersions";
import { withTenant } from "../src/lib/tenantScope";

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

type FakeQuote = QuoteExportRow & {
  id: string;
  supersededAt: Date | null;
  items: Array<{ description: string; qty: number; unitPriceCents: number }>;
};

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
  // A fleet quote is found by the fleet's name (fleet ids resolved by the caller).
  assert.deepEqual(found(quoteListWhere({ accessibleIds: null, q: "Kloof Lodge", fleetIds: ["flt_kloof"] })), [1001]);
  // Status filter still applies, and search AND status combine.
  assert.deepEqual(found(quoteListWhere({ accessibleIds: null, status: "sent" })), [1001]);
  assert.deepEqual(found(quoteListWhere({ accessibleIds: null, status: "draft", q: "Thandi" })), []);
  // No search = every current quote.
  assert.equal(found(quoteListWhere({ accessibleIds: null })).length, 250);
});

test("fleet search has no cap: with 600 matching fleets, the quote on the 600th is found and exported", async () => {
  // The old lookup was "fleets matching q, take 500", so this quote vanished
  // from both the list and the CSV.
  const fleetOf = (n: number): BillToFleet => ({
    id: `flt_${n}`, name: `Kloof Lodge ${String(n).padStart(3, "0")}`, registrationNumber: null, vatNumber: null,
    billingEmail: null, billingPhone: null, address: null, suburb: null, city: null, province: null, postalCode: null,
  });
  const fleets = Array.from({ length: 600 }, (_, i) => fleetOf(i + 1));
  const fleetRows = [
    ...fleets.map((fleet) => ({ ...fleet, deletedAt: null as Date | null, tenantId: "t_mine" })),
    { ...fleetOf(601), name: "Kloof Lodge 601 (closed)", deletedAt: new Date(), tenantId: "t_mine" },
    { ...fleetOf(602), name: "Kloof Lodge (another workspace)", deletedAt: null, tenantId: "t_other" },
  ];
  const lookups: Array<Record<string, unknown>> = [];
  const client = {
    fleet: {
      // A fake that honours `where` and `take` the way Postgres would.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args: any) {
        lookups.push(args);
        const out = fleetRows.filter((row) => matches(row, args.where)).map((row) => ({ id: row.id }));
        return typeof args.take === "number" ? out.slice(0, args.take) : out;
      },
    },
  };
  const rows: FakeQuote[] = [...fleets, fleetOf(601)].map((fleet, i) => ({
    ...quotes()[1],
    id: `fq${i + 1}`,
    number: 7000 + i + 1,
    fleetId: fleet.id,
  }));
  const target = rows[599];

  const fleetIds = await withTenant("t_mine", () => matchingFleetIds(client, "Kloof"));
  assert.equal(fleetIds.length, 600, "every live matching fleet, not the first 500 — not the deleted one, not another tenant's");
  assert.ok(lookups.every((args) => !("take" in args)), "no take on the fleet lookup");
  assert.equal((lookups[0].where as { tenantId?: string }).tenantId, "t_mine", "tenant named in the lookup");
  assert.deepEqual(lookups[0].select, { id: true }, "ids only");

  const hits = rows.filter((row) => matches(row, quoteListWhere({ accessibleIds: null, q: "Kloof", fleetIds })));
  assert.equal(hits.length, 600);
  assert.ok(hits.includes(target), "the quote on the 600th fleet is found");
  assert.ok(!hits.includes(rows[600]), "a soft-deleted fleet does not match by its name");

  // The export writes every hit, the 600th fleet's quote included, under the fleet's name.
  const csv = quoteCsv(hits, new Map(fleets.map((fleet) => [fleet.id, fleet])));
  assert.equal(csv.split("\r\n").length, 601);
  assert.ok(csv.includes(`"Q-${target.number}","draft","Kloof Lodge 600"`), "the 600th fleet's quote is in the export");

  // The page/export path uses this uncapped lookup through the scoped client,
  // and the schema keeps Quote.fleetId a bare scalar (no schema-only relation).
  assert.match(shipped("src/lib/quoteListQuery.ts"), /matchingFleetIds\(prisma, q\)/);
  assert.doesNotMatch(shipped("src/lib/quoteListQuery.ts"), /\btake:|basePrisma/);
  assert.match(readFileSync(path.join(root, "src/lib/quoteList.ts"), "utf8"), /ponytail: every id becomes one bind param/);
  assert.doesNotMatch(readFileSync(path.join(root, "prisma/schema.prisma"), "utf8"), /QuoteFleetSearch/);
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
  assert.match(page, /<ListPager path="\/quotes" page=\{page\}/);
});

test("the pager builds its links from the LIVE url, so it carries the current ?edit=, never a stale one", () => {
  // #696 rewrites ?edit= with history.replaceState as quotes open and close.
  // Next syncs that into useSearchParams but does not re-render the server page,
  // so links built from the server's params would reopen a closed quote.
  const pager = shipped("src/components/ListPager.tsx");
  assert.match(pager, /^"use client";/);
  assert.match(pager, /const params = useSearchParams\(\);/);
  assert.match(pager, /pageHref\(path, params, page - 1\)/);
  assert.match(pager, /pageHref\(path, params, page \+ 1\)/);
  // …and pageHref keeps whatever that live URL holds, including edit.
  const live = new URLSearchParams("edit=cq_now&q=smith&page=2");
  assert.equal(pageHref("/quotes", live, 3), "/quotes?edit=cq_now&q=smith&page=3");
  assert.equal(pageHref("/quotes", new URLSearchParams("q=smith&page=2"), 1), "/quotes?q=smith");
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
  // Default workspace: rand, Johannesburg calendar.
  assert.match(lines[0], /"Total \(ZAR\)"/);
  // #702's workspace settings: the header names the currency, and dates are the
  // workspace's calendar day — 23:30 UTC is already the next day in Auckland.
  const late = { ...rows[0], createdAt: new Date("2026-03-01T23:30:00Z") };
  const nz = quoteCsv([late], new Map(), { currency: "NZD", timeZone: "Pacific/Auckland" }).split("\r\n");
  assert.match(nz[0], /"Total \(NZD\)"/);
  assert.ok(nz[1].includes(`"2026-03-02"`), nz[1]);
  assert.ok(quoteCsv([late], new Map()).split("\r\n")[1].includes(`"2026-03-02"`), "Johannesburg is UTC+2 too");
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

test("a newest quote keeps its full version history with >2,000 quote rows in the workspace", async () => {
  // 2,100 older standalone quotes, then the newest family: v1 → v2 → v3 (head).
  const day = 86_400_000;
  const row = (id: string, n: number, revisionOfId: string | null, superseded: boolean, tenantId = "t_mine") => ({
    id, number: n, status: superseded ? "sent" : "draft", createdAt: new Date(Date.UTC(2020, 0, 1) + n * day),
    supersededAt: superseded ? new Date() : null, revisionOfId, deletedAt: null, tenantId,
  });
  const rows = [
    ...Array.from({ length: 2_100 }, (_, i) => row(`old${i}`, i, null, false)),
    row("v1", 5_000, null, true),
    row("v2", 5_001, "v1", true),
    row("v3", 5_002, "v2", false),
    // Another workspace's row pointing at ours must never join the family.
    row("foreign", 5_003, "v3", false, "t_other"),
  ];
  const calls: unknown[] = [];
  const client = {
    quote: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args: any) {
        calls.push(args);
        let out = rows.filter((r) => !args.where || matches(r, args.where));
        if (args.orderBy?.createdAt === "asc") out = out.toSorted((a, b) => +a.createdAt - +b.createdAt);
        return args.take ? out.slice(0, args.take) : out;
      },
    },
  };

  // What main did: the oldest 2,000 rows, workspace-wide. The newest family isn't in them.
  const oldIndex = quoteVersionIndex(await client.quote.findMany({ orderBy: { createdAt: "asc" }, take: 2_000 }));
  assert.deepEqual(oldIndex.familyOf("v3"), [], "fixture: the old cap loses the newest quote's history");

  // Now: only the families of the quotes on the page.
  calls.length = 0;
  const versions = await withTenant("t_mine", () => loadQuoteVersions(client, ["v3"]));
  const index = quoteVersionIndex(versions);
  assert.deepEqual(index.familyOf("v3").map((v) => v.id), ["v1", "v2", "v3"]);
  assert.equal(index.successorOf("v1")?.id, "v2");
  assert.equal(index.successorOf("v2")?.id, "v3");
  assert.equal(versions.length, 3, "loads that family and nothing else — not the other tenant's row");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok(calls.every((c: any) => c.take === undefined && c.where.tenantId === "t_mine"), "tenant-named, uncapped");
  // Starting mid-chain (a deep link to an old revision) finds the whole family too.
  const fromMiddle = await withTenant("t_mine", () => loadQuoteVersions(client, ["v2"]));
  assert.deepEqual(quoteVersionIndex(fromMiddle).familyOf("v2").map((v) => v.id), ["v1", "v2", "v3"]);

  // And the page + editor action use it, through the scoped client, with no global cap.
  const page = shipped("src/app/(app)/quotes/page.tsx");
  const action = shipped("src/app/actions/quotes.ts");
  assert.match(page, /loadQuoteVersions\(prisma, quotes\.map\(\(quote\) => quote\.id\)\)/);
  assert.match(action, /loadQuoteVersions\(prisma, \[quote\.id\]\)/);
  for (const src of [page, action]) assert.doesNotMatch(src, /take:\s*2_?000\b/);
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
    assert.match(src, new RegExp(`<ListPager path="${pathName.replace(/\//g, "\\/")}" page=\\{page\\}`), `${file}: pager`);
  }
  // Job cards: search and status now run in the database too.
  const jobcards = shipped("src/app/(app)/jobcards/page.tsx");
  assert.doesNotMatch(jobcards, /jobCards\.filter\(/);
  assert.match(jobcards, /searchTerms\(q\)/);
  // Saved lead views must not capture the page number.
  assert.match(shipped("src/app/(app)/leads/list/page.tsx"), /key !== "page"/);
});
