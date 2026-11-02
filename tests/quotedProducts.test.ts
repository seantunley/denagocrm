import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { countQuoted, lineMatches } from "../src/lib/quotedProducts";
import { quoteArgs } from "../src/lib/crmAssistantPlan";

const line = (description: string, colorPreference: string | null, qty = 1, extra: Partial<{ kind: string; optional: boolean; selected: boolean }> = {}) =>
  ({ description, colorPreference, qty, kind: "product", optional: false, selected: true, ...extra });

test("a line matches by product words and colour — the colour on its own field or in its name — any case", () => {
  assert.ok(lineMatches(line("Denago Rover XL", "White"), "rover xl", "white"));
  assert.ok(lineMatches(line("Rover XL - White", null), "Rover XL", "white"));
  assert.ok(!lineMatches(line("Rover XL", "Black"), "Rover XL", "white"));
  assert.ok(!lineMatches(line("Rover S", "White"), "Rover XL", "white"));
  assert.ok(!lineMatches(line("Rover XL", "White", 1, { kind: "trade_in" }), "Rover XL", "white"), "a trade-in is not on offer");
  assert.ok(!lineMatches(line("Rover XL", "White", 1, { optional: true, selected: false }), "Rover XL"), "an unchosen extra is not on offer");
});

test("Sean, 2026-11-02 — 'how many white Rover XLs are on quotes': quotes and units, by status, over every quote", () => {
  const quotes = [
    ...Array.from({ length: 12 }, () => ({ status: "sent", items: [line("Rover XL", "White"), line("Charger", null)] })),
    { status: "draft", items: [line("Rover XL", "White", 2)] },
    { status: "accepted", items: [line("Rover XL", "Black")] },
  ];
  assert.deepEqual(countQuoted(quotes, "Rover XL", "white"), {
    quotes: 13, units: 14, byStatus: { sent: { quotes: 12, units: 12 }, draft: { quotes: 1, units: 2 } },
  });
});

test("find_quotes takes product and colour, and answers a count from every match, not the page", () => {
  assert.ok(quoteArgs.safeParse({ product: "Rover XL", colour: "white" }).success);
  const code = readFileSync("src/lib/crmAssistant.ts", "utf8");
  const fn = code.slice(code.indexOf("export async function findQuotes"), code.indexOf("function quoteContents"));
  assert.match(fn, /items: \{ some: quoteLineWhere\(args\.product, args\.colour\) \}/);
  assert.match(fn, /countQuoted\(priced\.map/);
  assert.match(fn, /exact: quotes\.length < CANDIDATES/);
});
