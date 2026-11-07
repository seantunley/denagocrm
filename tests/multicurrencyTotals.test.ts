import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { baseAndOthers, baseValueCents, editorCostCents, formatTotals, nonBaseTotals, othersText, stageSegments, unrepricedAmount } from "../src/lib/currencyRules";

test("server: a draft changing currency is refused while any amount keeps its old number", () => {
  const before = {
    items: [{ id: "i1", unitPriceCents: 10_000_000 }, { id: "i2", unitPriceCents: 0 }],
    fees: [{ id: "f1", amountCents: 150_000 }],
    depositType: "amount",
    depositValue: 50_000,
  };
  const repriced = {
    items: [{ id: "i1", description: "Rover XL", unitPriceCents: 550_000 }, { id: "i2", description: "Mats", unitPriceCents: 0 }],
    fees: [{ id: "f1", label: "Delivery", amountCents: 8_000 }],
    depositType: "amount",
    depositValue: 2_000,
  };
  assert.equal(unrepricedAmount(before, repriced), null, "everything re-entered (a free line stays 0)");
  assert.equal(unrepricedAmount(before, { ...repriced, items: [{ id: "i1", description: "Rover XL", unitPriceCents: 10_000_000 }] }), "price for “Rover XL”");
  assert.equal(unrepricedAmount(before, { ...repriced, fees: [{ id: "f1", label: "Delivery", amountCents: 150_000 }] }), "amount for “Delivery”");
  assert.equal(unrepricedAmount(before, { ...repriced, depositValue: 50_000 }), "deposit amount");
  // Ids are the caller's to send or drop: an old number under no id (or another row's) is still refused.
  assert.equal(unrepricedAmount(before, { ...repriced, items: [{ description: "Rover XL", unitPriceCents: 10_000_000 }] }), "price for “Rover XL”");
  assert.equal(unrepricedAmount(before, { ...repriced, items: [{ id: "i2", description: "Mats", unitPriceCents: 10_000_000 }] }), "price for “Mats”");
  assert.equal(unrepricedAmount(before, { ...repriced, fees: [{ label: "Delivery", amountCents: 150_000 }] }), "amount for “Delivery”");
  const actions = readFileSync("src/app/actions/quotes.ts", "utf8");
  assert.match(actions, /const currencyMoved = \(existing\.currency \?\? null\) !== cpqQuoteData\.currency;\s+if \(currencyMoved\) \{\s+const stale = unrepricedAmount\(existing, \{ items: normalizedItems, fees: normalizedFees, \.\.\.cpqQuoteData \}\);\s+if \(stale\) return new Unrepriced\(/);
  // …and the old cost basis does not ride along into the new currency.
  assert.match(actions, /itemRowsFor\(normalizedItems, priorById\(existing\.items\), createDefaults\.regional\.vatRatePct, \{ keepCost: !currencyMoved \}\)/);
  assert.match(actions, /if \(result instanceof Unrepriced\) \{\s+return \{ ok: false, error: result\.message \};/);
});

test("the editor's cost follows what was SAVED: ZAR → USD, save, back to ZAR shows no cost, as the server stores", () => {
  // The editor's two moves, as it makes them: a currency switch, and a successful save.
  type Line = { costCents: number; savedCostCents: number };
  let saved = { currency: "", lines: [{ costCents: 18_000_000, savedCostCents: 18_000_000 }] as Line[] };
  let draft = { currency: "", lines: saved.lines };
  const switchTo = (currency: string) => {
    draft = { currency, lines: draft.lines.map((line) => ({ ...line, costCents: editorCostCents(line, currency, saved.currency) })) };
  };
  const save = () => {
    draft = { ...draft, lines: draft.lines.map((line) => ({ ...line, savedCostCents: line.costCents })) };
    saved = { currency: draft.currency, lines: draft.lines };
  };
  switchTo("USD");
  assert.equal(draft.lines[0].costCents, 0, "a rand cost is not a dollar cost");
  switchTo("");
  assert.equal(draft.lines[0].costCents, 18_000_000, "back before saving: the saved cost returns");
  switchTo("USD");
  save(); // the server stored no cost (keepCost: false)
  switchTo("");
  assert.equal(draft.lines[0].costCents, 0, "back AFTER saving: the cleared cost stays cleared — the server will save 0 again");
  // …and the editor really moves both on a successful save.
  const editor = readFileSync("src/components/quotes/QuoteEditorDialog.tsx", "utf8");
  assert.match(editor, /const \[savedCurrency, setSavedCurrency\] = useState\(record\?\.currency \?\? ""\);/);
  assert.match(editor, /setSavedQuote\(result\.quote\);[\s\S]{0,400}setSavedCurrency\(draft\.currency\);\s+setDraft\(\(current\) => \(\{ \.\.\.current, lines: current\.lines\.map\(\(line\) => \(\{ \.\.\.line, savedCostCents: line\.costCents \}\)\) \}\)\);/);
});

test("a quote changing currency clears its prices and won't save until each is re-entered", () => {
  const editor = readFileSync("src/components/quotes/QuoteEditorDialog.tsx", "utf8");
  const reprice = editor.slice(editor.indexOf("function repricedForCurrency"), editor.indexOf("/**", editor.indexOf("function repricedForCurrency")));
  assert.match(reprice, /const clear = \(amount: string\) => \(\/\[1-9\]\/\.test\(amount\) \? "" : amount\);/, "non-zero amounts cleared, zero kept");
  // …and the cost as the save will store it: none away from the saved currency (margin hidden), back on return.
  assert.match(reprice, /lines: draft\.lines\.map\(\(line\) => \(\{ \.\.\.line, unitPrice: clear\(line\.unitPrice\), costCents: editorCostCents\(line, currency, savedCurrency\) \}\)\)/);
  assert.match(editor, /const costsDropped = draft\.currency !== savedCurrency && draft\.lines\.some\(\(line\) => line\.savedCostCents > 0\);/);
  assert.match(editor, /\{costsDropped && " Saving also clears the recorded costs/);
  assert.match(editor, /\{calculated\.hasCost && <div/, "the margin only shows with a cost basis");
  assert.match(reprice, /fees: draft\.fees\.map\(\(fee\) => \(\{ \.\.\.fee, amount: clear\(fee\.amount\) \}\)\)/);
  assert.match(reprice, /depositValue: draft\.depositType === "amount" \? clear\(draft\.depositValue\) : draft\.depositValue/);
  // Both ways a draft's currency moves: the picker, and linking a lead (saved in the lead's currency).
  assert.match(editor, /setDraft\(\(current\) => repricedForCurrency\(current, code === currencies\[0\] \? "" : code, savedCurrency\)\);\s+setRepricing\(true\);/);
  assert.match(editor, /\.\.\.repricedForCurrency\(current, currency, savedCurrency\),\s+leadId,/);
  assert.match(readFileSync("src/app/(app)/quotes/page.tsx", "utf8"), /currency: lead\.currency,/);
  // Save refuses a cleared line, fee or fixed deposit instead of taking blank as 0.
  assert.match(editor, /if \(\(\(draft\.currency && line\.kind === "catalogue"\) \|\| repricing\) && !line\.unitPrice\.trim\(\)\) \{/);
  assert.match(editor, /const unpricedFee = repricing \? draft\.fees\.find\(\(fee\) => !fee\.amount\.trim\(\)\) : undefined;/);
  assert.match(editor, /if \(repricing && draft\.depositType === "amount" && !draft\.depositValue\.trim\(\)\) \{/);
});

test("pipeline snapshot: every deal counts toward its stage; only base values are summed", () => {
  const stage = (id: string, order: number) => ({ id, name: id, color: "#000", order });
  // A pipeline holding ONLY foreign-currency deals still has deals — not "No open leads yet".
  assert.deepEqual(
    stageSegments(
      [
        { valueCents: 500_000, currency: "RUB", stage: stage("Quoted", 2) },
        { valueCents: 100_000, currency: "USD", stage: stage("New", 1) },
        { valueCents: 200_000, currency: "USD", stage: stage("Quoted", 2) },
      ],
      "ZAR",
    ),
    [
      { name: "New", color: "#000", count: 1, value: 0 },
      { name: "Quoted", color: "#000", count: 2, value: 0 },
    ],
  );
  // Mixed: the base deal (NULL, or the base code itself) adds its value; the RUB one only its count.
  assert.deepEqual(
    stageSegments(
      [
        { valueCents: 300_000, currency: null, stage: stage("New", 1) },
        { valueCents: 50_000, currency: "ZAR", stage: stage("New", 1) },
        { valueCents: 900_000, currency: "RUB", stage: stage("New", 1) },
      ],
      "ZAR",
    ),
    [{ name: "New", color: "#000", count: 3, value: 350_000 }],
  );
  assert.match(src("src/lib/dashboard/cards.tsx"), /segments: stageSegments\(all, moneyFmt\.currency\)/);
});
import { homeNumbers } from "../src/lib/home/focusRules";

const src = (rel: string) => readFileSync(rel, "utf8");
const ZAR = { currency: "ZAR", locale: "en-ZA" };
const strip = (text: string) => text.replace(/\s/g, " ");

/* ── the rule: one figure is the base currency; the rest are named beside it ── */

test("a base figure never includes another currency; the rest are kept apart", () => {
  const rows = [
    { valueCents: 100_00, currency: null },
    { valueCents: 4_861_00, currency: "RUB" },
    { valueCents: 50_00, currency: null },
  ];
  const split = baseAndOthers(rows, (row) => ({ cents: row.valueCents, currency: row.currency }), "ZAR");
  assert.equal(split.baseCents, 150_00);
  assert.deepEqual(split.others, [{ currency: "RUB", cents: 4_861_00 }]);
  assert.deepEqual(nonBaseTotals(rows), [{ currency: "RUB", cents: 4_861_00 }]);
  assert.equal(rows.reduce((sum, row) => sum + baseValueCents(row), 0), 150_00, "the same rule as the report buckets");
});

test("totals read per currency, base first, joined — never one number", () => {
  const text = strip(formatTotals([{ currency: "ZAR", cents: 150_00 }, { currency: "RUB", cents: 4_861_00 }], ZAR));
  assert.match(text, /^R ?150,00 \+ .*4 ?861,00/);
  assert.equal(othersText([], ZAR), "", "nothing left out = nothing said");
  assert.match(strip(othersText([{ currency: "RUB", cents: 4_861_00 }], ZAR)), /^ \+ /);
});

test("the home screen names what its figures leave out", () => {
  const numbers = homeNumbers({
    seesLeads: true, seesActivities: false, seesSigning: false,
    wonCents: 100_00, prevWonCents: 0, salesTargetCents: 0,
    openPipelineCents: 200_00, openDeals: 3, newLeads: 0, prevNewLeads: 0, overdueMine: 0, waitingSignature: 0,
    wonElsewhere: "₽4.9k", pipelineElsewhere: "₽9k", money: ZAR,
  });
  assert.match(numbers.find((n) => n.key === "sales")!.context, /plus ₽4\.9k$/);
  assert.match(numbers.find((n) => n.key === "pipeline")!.context, /across 3 open deals · plus ₽9k$/);
});

/* ── where the figures are made ─────────────────────────────────────────────── */

test("report buckets add base-currency values only (existing rows are all NULL, so unchanged)", () => {
  const stats = src("src/lib/statistics.ts");
  assert.match(stats, /const LEAD_BASE_VALUE = Prisma\.sql`CASE WHEN "currency" IS NULL THEN "valueCents" ELSE 0 END`;/);
  assert.doesNotMatch(stats, /sum: Prisma\.sql`"valueCents"`/, "no lead metric sums raw values across currencies");
  assert.match(src("src/app/(app)/reports/page.tsx"), /baseValueCents\(won\)/, "the live path uses the same rule");
});

test("the forecast is base-currency figures plus the other currencies, said apart", () => {
  const pipelines = src("src/lib/pipelines.ts");
  assert.match(pipelines, /const leads = allLeads\.filter\(\(lead\) => !lead\.currency\);/);
  assert.match(pipelines, /otherCurrencies,/);
  assert.match(pipelines, /l\."valueCents", l\."currency"/);
});

test("lists and boards total per currency", () => {
  assert.match(src("src/components/PipelineSummary.tsx"), /formatTotals\(pipeline\.openValues, moneyFmt\)/);
  assert.match(src("src/app/(app)/quotes/page.tsx"), /totalsByCurrency\(openQuotes,/);
  assert.match(src("src/lib/crmAssistantStats.ts"), /by: \["assignedToId", "currency"\]/);
  assert.match(src("src/lib/crmAssistant.ts"), /by: \["stageId", "currency"\]/);
});

/* ── catalogue prices are base-currency prices ─────────────────────────────── */

test("a catalogue price is never put on a quote in another currency", () => {
  const editor = src("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(editor, /unitPrice: current\.currency \? "" : priceInput\(product\.basePriceCents\)/);
  assert.match(editor, /if \(\(\(draft\.currency && line\.kind === "catalogue"\) \|\| repricing\) && !line\.unitPrice\.trim\(\)\)/, "and a blank one isn't saved as 0");
  const dax = src("src/lib/crmAssistant.ts");
  assert.match(dax, /if \(quote\.currency\) \{ problems\.push\(foreignCurrencyQuote\(/);
  assert.match(dax, /if \(deal\.currency\) \{ problems\.push\(foreignCurrencyQuote\(/);
});
