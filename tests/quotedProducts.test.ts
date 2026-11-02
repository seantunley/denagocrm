import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { countQuoted, lineMatches, modelsNamed } from "../src/lib/quotedProducts";
import { quoteArgs } from "../src/lib/crmAssistantPlan";

// The real catalogue's names (2026-11-02).
const CATALOGUE = ["Denago EV Rover XL", "Denago EV Rover XL 6", "Denago EV Rover XXL", "Denago EV Nomad", "Denago EV Nomad XL", "Denago EV Scout 2", "Denago EV Scout 4"]
  .map((name, i) => ({ id: `p${i}`, name }));
const id = (name: string) => CATALOGUE.find((p) => p.name === name)!.id;
const line = (description: string, productId: string | null, colorPreference: string | null, qty = 1, extra: Partial<{ kind: string; optional: boolean; selected: boolean }> = {}) =>
  ({ description, productId, colorPreference, qty, kind: "product", optional: false, selected: true, ...extra });

test("review of #954: the model is the catalogue's own — 'Rover XL' is not the Rover XL 6 or the XXL", () => {
  assert.deepEqual(modelsNamed(CATALOGUE, "Rover XL").map((p) => p.name), ["Denago EV Rover XL"]);
  assert.deepEqual(modelsNamed(CATALOGUE, "rover xl 6").map((p) => p.name), ["Denago EV Rover XL 6"]);
  assert.deepEqual(modelsNamed(CATALOGUE, "Nomad").map((p) => p.name), ["Denago EV Nomad"]);
  // A word that names several models and ends none of them: each, counted separately.
  assert.deepEqual(modelsNamed(CATALOGUE, "Scout").map((p) => p.name), ["Denago EV Scout 2", "Denago EV Scout 4"]);
  assert.deepEqual(modelsNamed(CATALOGUE, "Ranger"), []);
});

test("review of #954: a vehicle is a catalogue-linked product line — never an accessory, a free-text line or a trade-in", () => {
  const xl = [id("Denago EV Rover XL")];
  assert.ok(lineMatches(line("Denago EV Rover XL", id("Denago EV Rover XL"), "White"), xl, "white"));
  // The reviewer's rain cover, marked as an accessory — and the same words as free text, as real quotes have them.
  assert.ok(!lineMatches(line("Rover XL rain cover", id("Denago EV Rover XL"), "White", 1, { kind: "accessory" }), xl, "white"));
  assert.ok(!lineMatches(line("Rain Cover Rover XL", null, "White"), xl, "white"));
  assert.ok(!lineMatches(line("Denago EV Rover XL 6", id("Denago EV Rover XL 6"), "White"), xl, "white"));
  assert.ok(!lineMatches(line("Denago EV Rover XL", id("Denago EV Rover XL"), "Black"), xl, "white"));
  assert.ok(!lineMatches(line("Denago EV Rover XL", id("Denago EV Rover XL"), "White", 1, { kind: "trade_in" }), xl));
  assert.ok(!lineMatches(line("Denago EV Rover XL", id("Denago EV Rover XL"), "White", 1, { optional: true, selected: false }), xl));
  // A colour on its own: any vehicle of that colour.
  assert.ok(lineMatches(line("Denago EV Nomad", id("Denago EV Nomad"), "White"), null, "white"));
});

test("Sean, 2026-11-02 — 'how many white Rover XLs are on quotes': quotes and units by status and model, over every quote", () => {
  const xl = id("Denago EV Rover XL");
  const quotes = [
    ...Array.from({ length: 12 }, () => ({ status: "sent", items: [line("Denago EV Rover XL", xl, "White"), line("Rain Cover Rover XL", null, null)] })),
    { status: "draft", items: [line("Denago EV Rover XL", xl, "White", 2)] },
    { status: "accepted", items: [line("Denago EV Rover XL 6", id("Denago EV Rover XL 6"), "White")] },
    { status: "sent", items: [line("Rover XL rain cover", xl, "White", 1, { kind: "accessory" })] },
  ];
  assert.deepEqual(countQuoted(quotes, modelsNamed(CATALOGUE, "Rover XL"), "white"), {
    quotes: 13, units: 14,
    byStatus: { sent: { quotes: 12, units: 12 }, draft: { quotes: 1, units: 2 } },
    byModel: { "Denago EV Rover XL": 14 },
  });
});

test("find_quotes takes product and colour, resolves the model from the catalogue, and counts every match", () => {
  assert.ok(quoteArgs.safeParse({ product: "Rover XL", colour: "white" }).success);
  const code = readFileSync("src/lib/crmAssistant.ts", "utf8");
  const fn = code.slice(code.indexOf("export async function findQuotes"), code.indexOf("function quoteContents"));
  assert.match(fn, /modelsNamed\(await prisma\.product\.findMany\(\{ where: \{ deletedAt: null \}/);
  assert.match(fn, /items: \{ some: quoteLineWhere\(models\?\.map\(\(m\) => m\.id\) \?\? null, args\.colour\) \}/);
  assert.match(fn, /countQuoted\(priced\.map\(\(\{ quote \}\) => quote\), models, args\.colour\)/);
  assert.match(fn, /exact: quotes\.length < CANDIDATES/);
});
