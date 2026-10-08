import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("deal jacket is quote-scoped and fails closed: the proxy's route rule, then the quote's own gate", () => {
  const page = read("src/app/(app)/deals/[id]/page.tsx");
  const routes = read("src/lib/routeAccess.ts");

  assert.match(routes, /prefix: "\/deals", anyOf: \["quotes\.view_all", "quotes\.view_owned"\]/);
  // The page applies the SAME rule the edge does, by name, before anything is read.
  assert.match(page, /await requireRoute\("\/deals"\);\s*const user = await requireQuoteReadAccess\(id\);/);
  assert.ok(page.indexOf("requireQuoteReadAccess(id)") < page.indexOf("prisma.quote.findUnique"), "no deal data before the quote gate");
});

test("deal jacket composes existing records instead of adding a second deal model", () => {
  const page = read("src/app/(app)/deals/[id]/page.tsx");

  assert.match(page, /prisma\.quote\.findUnique/);
  assert.match(page, /stockReservations/);
  assert.match(page, /soldStock/);
  assert.match(page, /prisma\.document\.findMany/);
  assert.match(page, /prisma\.signatureRequest\.findMany/);
  assert.match(page, /Deal timeline/);
  assert.match(page, /Ready to deliver\?/);
  // No invented payment data: the ledger is named as not existing yet.
  assert.match(page, /Financial ledger not yet available\./);
  assert.doesNotMatch(page, /prisma\.(payment|receipt|ledger)/i);
});

test("the customer is the quote's addressee — the fleet account when it is billed to one", () => {
  const page = read("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /const billTo = quoteBillTo\(quote, await loadBillToFleet\(prisma, quote\.fleetId\)\);/);
  assert.doesNotMatch(page, /contactName\(/, "never worked out from the contact here");
});

test("a lead's conversations, activities and source are shown only to someone who may open that lead", () => {
  const page = read("src/app/(app)/deals/[id]/page.tsx");
  assert.match(page, /quote\.lead && \(await hasAnyPermission\(user, "leads\.view_all", "leads\.view_owned"\)\) && \(await canAccessLead\(user, quote\.lead\.id\)\)/);
  // Everything lead-owned reads the gated `lead`, never `quote.lead` directly.
  assert.match(page, /\.\.\.lead\?\.communications\.map/);
  assert.match(page, /lead\?\.activities\.find/);
  assert.doesNotMatch(page, /quote\.lead\?\.(communications|activities|source|email|phone)/);
  assert.doesNotMatch(page, /quote\.leadId &&/, "no link into a lead the viewer cannot open");
});

test("a record list's right-click menu does not depend on its rows staying small", () => {
  // The Open deal button made the quote register's rows large enough that React
  // sent each as its own chunk: the menu trigger was handed a lazy reference, could
  // not clone it, and the whole list failed to render on the server. Seen in a
  // browser, not by any source test — so the fix is pinned here.
  const menu = read("src/components/RecordContextMenu.tsx");
  assert.match(menu, /<ContextMenuTrigger asChild>\{resolvedRow\(children\)\}<\/ContextMenuTrigger>/);
  assert.match(menu, /lazy\.\$\$typeof === Symbol\.for\("react\.lazy"\) && typeof lazy\._init === "function" \? lazy\._init\(lazy\._payload\) : row/);
  assert.doesNotMatch(menu, /asChild>\{children\}/);
});

test("deal jacket is reachable from both quote and lead workflows", () => {
  const quotes = read("src/app/(app)/quotes/page.tsx");
  const lead = read("src/app/(app)/leads/[id]/page.tsx");

  assert.match(quotes, /label: "Deal workspace", href: `\/deals\/\$\{quote\.id\}`/);
  assert.equal((quotes.match(/href=\{`\/deals\/\$\{quote\.id\}`\}/g) ?? []).length, 2, "Open deal on the phone card and the desktop row");
  assert.match(lead, /href=\{`\/deals\/\$\{q\.id\}`\}/);
});
