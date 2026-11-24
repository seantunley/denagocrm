import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { HELP_ARTICLES } from "../src/lib/help/content";
import { HELP_CATEGORIES } from "../src/lib/help/categories";
import { HELP_AREA_STYLE } from "../src/lib/help/areas";
import { HELP_DESTINATIONS, destinationFor } from "../src/lib/help/destinations";
import { FEATURED_SLUGS, HELP_PATHS, featuredFor, featuredPathKey, parseRead, pathProgress, pathsFor, withRead } from "../src/lib/help/paths";
import { rankHelp } from "../src/lib/help/quickSearch";
import { MIN_OUTLINE, headingAnchor, outlineOf, readingMinutes } from "../src/lib/help/outline";

const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ALL = new Set(HELP_ARTICLES.map((article) => article.slug));

test("the owner path is for the WORKSPACE owner, decided by isTenantOwner — not the platform role", () => {
  // A workspace's owner is Tenant.ownerUserId and is often role "member"; `user.role === "owner"` is the platform owner.
  const page = code("src/app/(app)/help/page.tsx");
  assert.match(page, /const admin = await isTenantOwner\(\);/);
  assert.doesNotMatch(page, /role === "owner"/);
  const keys = (reader: { manager: boolean; admin: boolean }) => pathsFor(ALL, reader).map((path) => path.key);
  assert.ok(keys({ manager: false, admin: true }).includes("admin"), "a workspace owner gets the set-up path");
  assert.ok(!keys({ manager: false, admin: false }).includes("admin"), "an ordinary member doesn't");
  assert.ok(!keys({ manager: true, admin: false }).includes("admin"), "nor does a manager who isn't the owner");
});

test("every help area has its own colour, and no two share one", () => {
  for (const category of HELP_CATEGORIES) assert.ok(HELP_AREA_STYLE[category.key], category.key);
  const tiles = HELP_CATEGORIES.map((category) => HELP_AREA_STYLE[category.key].tile);
  assert.equal(new Set(tiles).size, tiles.length);
});

test("every 'take me there' button opens a page that exists", () => {
  for (const { href, label } of HELP_DESTINATIONS) {
    assert.ok(label.trim(), href);
    const page = href === "/" ? "src/app/(app)/page.tsx" : `src/app/(app)${href}/page.tsx`;
    assert.ok(existsSync(page), `${href} has no page`);
  }
});

test("an exact guide wins over its family, and a guide about no one screen has no button", () => {
  assert.deepEqual(destinationFor("quotes-build-and-price"), { href: "/quotes", label: "Quotes" });
  assert.deepEqual(destinationFor("leads-test-drives"), { href: "/test-drives", label: "Test Drives" });
  assert.deepEqual(destinationFor("stock-vehicles-registration"), { href: "/vehicles", label: "Vehicles" });
  assert.deepEqual(destinationFor("stock-parts-inventory"), { href: "/parts", label: "Parts" });
  assert.equal(destinationFor("everyday-conventions"), null);
  assert.equal(destinationFor("welcome"), null);
});

test("most guides can take the reader to their screen", () => {
  const withButton = HELP_ARTICLES.filter((article) => destinationFor(article.slug)).length;
  assert.ok(withButton / HELP_ARTICLES.length > 0.8, `${withButton} of ${HELP_ARTICLES.length}`);
});

test("every path and every featured guide names real guides, in an order with no repeats", () => {
  for (const path of HELP_PATHS) {
    assert.equal(new Set(path.slugs).size, path.slugs.length, path.key);
    for (const slug of path.slugs) assert.ok(ALL.has(slug), `${path.key}: ${slug}`);
  }
  for (const slug of FEATURED_SLUGS) assert.ok(ALL.has(slug), slug);
  assert.equal(new Set(HELP_PATHS.map((path) => path.key)).size, HELP_PATHS.length);
});

test("who is reading decides which paths are offered", () => {
  const keys = (reader: { manager: boolean; admin: boolean }) => pathsFor(ALL, reader).map((path) => path.key);
  assert.deepEqual(keys({ manager: false, admin: false }), ["new", "selling", "workshop", "customers"]);
  assert.deepEqual(keys({ manager: true, admin: false }), ["new", "selling", "workshop", "customers", "managing"]);
  assert.deepEqual(keys({ manager: false, admin: true }), ["new", "selling", "workshop", "customers", "managing", "admin"]);
});

test("a path loses the guides a workspace does not have, and goes altogether below three", () => {
  const withoutWorkshop = new Set([...ALL].filter((slug) => !slug.startsWith("jobcards-")));
  const workshop = pathsFor(withoutWorkshop, { manager: false, admin: false }).find((path) => path.key === "workshop");
  assert.equal(workshop, undefined, "two guides left is not a path");
  const some = new Set([...ALL].filter((slug) => slug !== "signing-in"));
  assert.equal(pathsFor(some, { manager: false, admin: false })[0].slugs.includes("signing-in"), false);
});

test("progress counts what was read and points at the first guide that was not", () => {
  const slugs = ["a", "b", "c"];
  assert.deepEqual(pathProgress(slugs, new Set()), { done: 0, total: 3, next: "a", complete: false });
  assert.deepEqual(pathProgress(slugs, new Set(["a", "c", "zzz"])), { done: 2, total: 3, next: "b", complete: false });
  assert.deepEqual(pathProgress(slugs, new Set(slugs)), { done: 3, total: 3, next: null, complete: true });
  assert.equal(pathProgress([], new Set()).complete, false);
});

test("the read list survives rubbish in storage and never grows a duplicate", () => {
  for (const bad of [null, "", "{}", "not json", '"x"', "[1,2]", '["<script>"]']) assert.equal(parseRead(bad).size, 0, String(bad));
  const once = withRead(null, "welcome");
  assert.equal(once, '["welcome"]');
  assert.equal(withRead(once, "welcome"), null, "already read: nothing to write");
  assert.deepEqual([...parseRead(withRead(once, "signing-in"))], ["welcome", "signing-in"]);
  assert.equal(withRead(null, "Not A Slug"), null);
});

test("featured guides are the first few that exist for the workspace", () => {
  assert.equal(featuredFor(ALL).length, 4);
  assert.deepEqual(featuredFor(new Set(["inbox-replying"])), ["inbox-replying"]);
});

const ENTRIES = [
  { slug: "a", title: "Building and pricing a quote", summary: "Add lines and discounts.", keywords: ["cpq"] },
  { slug: "b", title: "Quotes: the basics", summary: "The list and statuses.", keywords: [] },
  { slug: "c", title: "Job cards", summary: "Workshop jobs. Quote a repair.", keywords: [] },
];

test("search ranks a title match first and needs every word typed", () => {
  assert.deepEqual(rankHelp(ENTRIES, "quote").map((entry) => entry.slug), ["a", "b", "c"]);
  assert.deepEqual(rankHelp(ENTRIES, "quote discounts").map((entry) => entry.slug), ["a"]);
  assert.deepEqual(rankHelp(ENTRIES, "CPQ").map((entry) => entry.slug), ["a"]);
  assert.deepEqual(rankHelp(ENTRIES, "   "), []);
  assert.deepEqual(rankHelp(ENTRIES, "zebra"), []);
  assert.equal(rankHelp(ENTRIES, "quote", 2).length, 2);
});

test("the front page leads with search, and the side menu's search steps aside there", () => {
  const home = code("src/app/(app)/help/page.tsx");
  assert.ok(home.indexOf("<HelpSearch") < home.indexOf("<HelpPaths"), "search comes before everything else");
  assert.ok(home.indexOf("<HelpPaths") < home.indexOf("Browse by area"));
  assert.match(home, /readKey\(user\.id\)/, "ticks are kept per person");
});

test("an article offers its screen and ticks itself on the reader's paths", () => {
  const article = code("src/app/(app)/help/[slug]/page.tsx");
  assert.match(article, /const destination = destinationFor\(article\.slug\);/);
  assert.match(article, /\{destination && \(/);
  assert.match(article, /<Link href=\{destination\.href\} target="_blank"/);
  assert.match(article, /<MarkHelpRead storageKey=\{readKey\(user\.id\)\} slug=\{article\.slug\} \/>/);
});

test("ticks are kept in the browser, and a browser that refuses storage breaks nothing", () => {
  const store = code("src/lib/help/readStore.ts");
  assert.equal(store.match(/try \{/g)?.length, 2);
  assert.doesNotMatch(store, /prisma|fetch\(/);
});

test("the help home has the page to itself; a guide keeps the side menu", () => {
  const frame = code("src/components/help/HelpFrame.tsx");
  assert.match(frame, /if \(pathname === "\/help"\) return <div className="w-full">\{children\}<\/div>;/);
  assert.match(frame, /<aside[^>]*>\{nav\}<\/aside>/);
  assert.match(code("src/app/(app)/help/layout.tsx"), /<HelpFrame nav=\{<HelpNav groups=\{groups\} \/>\}>\{children\}<\/HelpFrame>/);
});

test("one path is shown in full: the one in progress, else the first unfinished", () => {
  const paths = [{ key: "a", slugs: ["a1", "a2"] }, { key: "b", slugs: ["b1", "b2"] }, { key: "c", slugs: ["c1"] }];
  assert.equal(featuredPathKey(paths, new Set()), "a");
  assert.equal(featuredPathKey(paths, new Set(["b1"])), "b", "part-way through wins");
  assert.equal(featuredPathKey(paths, new Set(["a1", "a2"])), "b", "a finished path steps aside");
  assert.equal(featuredPathKey(paths, new Set(["a1", "a2", "b1", "b2", "c1"])), "a", "all done: the first again");
  assert.equal(featuredPathKey([], new Set()), null);
  const view = code("src/components/help/HelpPaths.tsx");
  assert.equal(view.match(/<ol /g)?.length, 1, "only one list of guides is ever open");
});

test("the menu beside a guide lists the area being read, not every guide", () => {
  const nav = code("src/components/help/HelpNav.tsx");
  assert.match(nav, /const current = groups\.find\(\(g\) => g\.articles\.some\(\(a\) => pathname === `\/help\/\$\{a\.slug\}`\)\) \?\? null;/);
  assert.match(nav, /\{current\.articles\.map\(/);
  assert.doesNotMatch(nav, /groups\.map\(\(g\) => \(\s*<div key=\{g\.key\}>[\s\S]*g\.articles\.map/, "no longer every area's every guide");
  assert.match(nav, /others\.map\(\(g\) => \(\s*<Link key=\{g\.key\} href=\{`\/help\/\$\{g\.articles\[0\]\.slug\}`\}/);
  assert.match(nav, /<Link href="\/help"/);
});

test("a guide's outline and reading time come from its own blocks", () => {
  const body = [
    { type: "p" as const, text: "word ".repeat(390) },
    { type: "h" as const, text: "The **sidebar**" },
    { type: "steps" as const, items: ["one two", "three"] },
    { type: "h" as const, text: "Search" },
  ];
  assert.deepEqual(outlineOf(body), [{ id: "h-1", text: "The sidebar" }, { id: "h-3", text: "Search" }]);
  assert.equal(headingAnchor(3), "h-3");
  assert.equal(readingMinutes(body), 2);
  assert.equal(readingMinutes([]), 1);
  assert.equal(MIN_OUTLINE, 2);
});

test("only a page showing one guide anchors its headings", () => {
  assert.match(code("src/components/help/ArticleBody.tsx"), /id=\{anchors \? headingAnchor\(i\) : undefined\}/);
  assert.match(code("src/app/(app)/help/[slug]/page.tsx"), /<ArticleBody body=\{article\.body\} anchors \/>/);
  assert.doesNotMatch(code("src/app/(print)/manual/page.tsx"), /anchors/);
});

test("a guide with no outline keeps no empty column for one", () => {
  const page = code("src/app/(app)/help/[slug]/page.tsx");
  assert.match(page, /const outline = headings\.length >= MIN_OUTLINE \? headings : null;/);
  assert.match(page, /<div className=\{outline \? "grid gap-10 xl:grid-cols-\[minmax\(0,1fr\)_14rem\]" : undefined\}>/);
  assert.doesNotMatch(page, /max-w-3xl/, "the guide fills the width it has");
  assert.match(page, /\{outline && \(\s*<aside/);
});

test("the help centre is full width: no centred column on any of its pages", () => {
  assert.doesNotMatch(code("src/components/help/HelpFrame.tsx"), /max-w-|mx-auto/);
  for (const page of ["page.tsx", "[slug]/page.tsx", "whats-new/page.tsx", "ours/page.tsx", "ours/new/page.tsx", "ours/[id]/page.tsx", "ours/[id]/edit/page.tsx"]) {
    assert.doesNotMatch(code(`src/app/(app)/help/${page}`), /mx-auto max-w-(3xl|6xl|7xl)/, page);
  }
});
