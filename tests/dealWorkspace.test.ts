import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

// Redeploy marker: preview env updated for authenticated verification.\n\ntest("deal jacket is quote-scoped and fails closed through the existing quote gate", () => {
  const page = read("src/app/(app)/deals/[id]/page.tsx");
  const routes = read("src/lib/routeAccess.ts");

  assert.match(page, /await requireQuoteReadAccess\(id\)/);
  assert.match(routes, /prefix: "\/deals", anyOf: \["quotes\.view_all", "quotes\.view_owned"\]/);
});

test("deal jacket composes existing records instead of adding a second deal model", () => {
  const page = read("src/app/(app)/deals/[id]/page.tsx");

  assert.match(page, /prisma\.quote\.findUnique/);
  assert.match(page, /stockReservations/);
  assert.match(page, /soldStock/);
  assert.match(page, /prisma\.document\.findMany/);
  assert.match(page, /prisma\.signatureRequest\.findMany/);
  assert.match(page, /Recent communication/);
  assert.match(page, /Deal progress/);
  assert.match(page, /Payment ledger/);
  assert.match(page, /does not invent payment data/);
});

test("deal jacket is reachable from both quote and lead workflows", () => {
  const quotes = read("src/app/(app)/quotes/page.tsx");
  const lead = read("src/app/(app)/leads/[id]/page.tsx");

  assert.match(quotes, /label: "Deal workspace", href: `\/deals\/\$\{quote\.id\}`/);
  assert.match(lead, /href=\{`\/deals\/\$\{q\.id\}`\}/);
});
