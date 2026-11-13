import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig, parseConfigStrict } from "../src/lib/dashboard/config";
import { bandsInOrder, deltaTone, scaleBands, toneFor } from "../src/lib/dashboard/tone";
import {
  RESIZE_DEAD_ZONE_PX,
  ROW_UNIT_REM,
  sizeLabel,
  snapRows,
  snapSpan,
  stepSize,
  type GridMeasure,
} from "../src/lib/dashboard/resize";
import { CARD_MIN_HEIGHT } from "../src/components/dashboard/cards/placement";
import { renderSignature } from "../src/lib/dashboard/renderSignature";

/**
 * Thresholds on stat and gauge cards, and resizing a card by its corner.
 *
 * The rule both share: an existing saved dashboard must look and behave exactly
 * as it did. Every new field is optional, every default is today's behaviour,
 * and a resize writes nothing but the span and rows the size buttons already
 * wrote.
 */

const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const rawConfig = (card: Record<string, unknown>) => ({
  views: [{ id: "v1", title: "Sales", path: "sales", sections: [{ id: "s1", cards: [card] }] }],
});
// Typed as plain records: spreading `over` into a literal keeps only the literal's own keys in the
// inferred type, so `card.bands` / `card.better` did not type-check (CI: TS2339).
const stat = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c1",
  type: "stat",
  query: { source: "leads" },
  ...over,
});
const gauge = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c1",
  type: "gauge",
  query: { source: "leads" },
  target: 100,
  ...over,
});

/* ── the saved config ─────────────────────────────────────────────── */

test("a stat or gauge saved before thresholds existed reads back with neither field", () => {
  for (const card of [stat(), gauge()]) {
    const { config, dropped } = parseConfig(rawConfig(card));
    assert.deepEqual(dropped, []);
    const parsed = config.views[0].sections[0].cards[0] as Record<string, unknown>;
    // Absent, not defaulted: a default would be written into every card on the
    // next save, a choice nobody made.
    assert.equal("better" in parsed, false, `${card.type} must not gain a direction`);
    assert.equal("bands" in parsed, false, `${card.type} must not gain thresholds`);
  }
});

test("direction and thresholds survive a save on both card types", () => {
  for (const card of [stat({ better: "lower", bands: { good: 2, bad: 10 } }), gauge({ better: "higher", bands: { good: 80, bad: 40 } })]) {
    const result = parseConfigStrict(rawConfig(card));
    assert.equal(result.ok, true, `${card.type} with thresholds must save`);
    const saved = result.ok ? (result.config.views[0].sections[0].cards[0] as Record<string, unknown>) : {};
    assert.deepEqual(saved.bands, card.bands);
    assert.equal(saved.better, card.better);
  }
});

test("a direction or threshold that is not a number the card could ever reach is refused", () => {
  for (const card of [
    stat({ better: "sideways" }),
    stat({ bands: { good: "high", bad: 0 } }),
    stat({ bands: { good: 1 } }),
    gauge({ bands: { good: 1e13, bad: 0 } }),
  ]) {
    assert.equal(parseConfigStrict(rawConfig(card)).ok, false, JSON.stringify(card));
  }
});

test("thresholds are part of what the server draws, so changing them redraws the card", () => {
  const before = parseConfig(rawConfig(stat())).config;
  const after = parseConfig(rawConfig(stat({ bands: { good: 10, bad: 0 } }))).config;
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("a resize changes only placement, so it never makes the server redraw the card", () => {
  const before = parseConfig(rawConfig(stat())).config;
  const after = parseConfig(rawConfig(stat({ span: 3, rows: 2 }))).config;
  assert.equal(renderSignature(before), renderSignature(after));
});

/* ── tone ─────────────────────────────────────────────────────────── */

test("higher is better: green at or above good, red at or below bad, amber between", () => {
  const bands = { good: 100, bad: 50 };
  assert.equal(toneFor(120, bands), "good");
  assert.equal(toneFor(100, bands), "good");
  assert.equal(toneFor(75, bands), "warn");
  assert.equal(toneFor(50, bands), "bad");
  assert.equal(toneFor(0, bands), "bad");
});

test("lower is better mirrors it", () => {
  const bands = { good: 2, bad: 10 };
  assert.equal(toneFor(0, bands, "lower"), "good");
  assert.equal(toneFor(2, bands, "lower"), "good");
  assert.equal(toneFor(5, bands, "lower"), "warn");
  assert.equal(toneFor(10, bands, "lower"), "bad");
  assert.equal(toneFor(40, bands, "lower"), "bad");
});

test("no thresholds, no tone — the card draws exactly as it always did", () => {
  assert.equal(toneFor(10, undefined), null);
  assert.equal(toneFor(Number.NaN, { good: 1, bad: 0 }), null);
});

test("the change arrow is good news by the card's direction, and no change is neutral", () => {
  assert.equal(deltaTone(12), "good");
  assert.equal(deltaTone(-12), "bad");
  assert.equal(deltaTone(12, "lower"), "bad", "more overdue work is bad news");
  assert.equal(deltaTone(-12, "lower"), "good");
  assert.equal(deltaTone(0), null);
  assert.equal(deltaTone(0, "lower"), null);
});

test("money thresholds are typed in rands and compared in cents, scaled in one place", () => {
  assert.deepEqual(scaleBands({ good: 50_000, bad: 10_000 }, true), { good: 5_000_000, bad: 1_000_000 });
  assert.deepEqual(scaleBands({ good: 5, bad: 1 }, false), { good: 5, bad: 1 });
  assert.equal(scaleBands(undefined, true), undefined);
  // R50 000 in cents is good; R49 999.99 is not.
  const bands = scaleBands({ good: 50_000, bad: 10_000 }, true);
  assert.equal(toneFor(5_000_000, bands), "good");
  assert.equal(toneFor(4_999_999, bands), "warn");
});

test("the builder can tell a pair entered the wrong way round", () => {
  assert.equal(bandsInOrder({ good: 10, bad: 5 }), true);
  assert.equal(bandsInOrder({ good: 5, bad: 10 }), false);
  assert.equal(bandsInOrder({ good: 5, bad: 10 }, "lower"), true);
  assert.equal(bandsInOrder({ good: 5, bad: 5 }), false);
});

test("both cards read the card's direction and scale money thresholds before comparing", () => {
  for (const file of ["src/components/dashboard/cards/stat.tsx", "src/components/dashboard/cards/gauge.tsx"]) {
    const source = code(file);
    assert.match(source, /toneFor\(value, scaleBands\(card\.bands, asMoney\), card\.better\)/, file);
  }
  // And the stat's arrow colour no longer assumes up is good.
  assert.match(code("src/components/dashboard/cards/stat.tsx"), /deltaTone\(delta, card\.better\)/);
  assert.doesNotMatch(code("src/components/dashboard/cards/stat.tsx"), /delta >= 0 \? "text-emerald-400"/);
});

test("a tone is always said in words as well as colour", () => {
  assert.match(code("src/components/dashboard/cards/stat.tsx"), /<TonePill tone=\{tone\}/);
  assert.match(code("src/components/dashboard/cards/gauge.tsx"), /<TonePill tone=\{tone\}/);
});

/* ── resize ───────────────────────────────────────────────────────── */

// A three-column section 960px wide with 16px gaps: columns of 309.33px.
const grid: GridMeasure = { startLeft: 100, gridWidth: 960, gap: 16, columns: 3 };
const columnWidth = (960 - 16 * 2) / 3;
const rightEdgeAt = (columns: number) => grid.startLeft + columns * columnWidth + (columns - 1) * grid.gap;

test("pulling the right edge snaps to whole columns", () => {
  assert.equal(snapSpan(rightEdgeAt(1), grid, 1), 1);
  assert.equal(snapSpan(rightEdgeAt(2), grid, 1), 2);
  assert.equal(snapSpan(rightEdgeAt(3), grid, 1), 3);
  // Just past the middle of the second column rounds up; just short rounds down.
  assert.equal(snapSpan(rightEdgeAt(1.6), grid, 1), 2);
  assert.equal(snapSpan(rightEdgeAt(1.4), grid, 2), 1);
});

test("a card never snaps narrower than one column or wider than the grid", () => {
  assert.equal(snapSpan(grid.startLeft - 500, grid, 2), 1);
  assert.equal(snapSpan(grid.startLeft + 5000, grid, 1), 3);
});

test("full width on a narrow screen keeps a wider span, so it is not lost on a desktop", () => {
  const tablet: GridMeasure = { ...grid, columns: 2 };
  assert.equal(snapSpan(grid.startLeft + 5000, tablet, 4), 4, "a 4-wide card stays 4-wide");
  assert.equal(snapSpan(grid.startLeft + 5000, tablet, 1), 2, "a narrow card grows to the grid");
});

test("the size depends on the pointer alone, so a reflow cannot feed back into it", () => {
  // Same pointer, same measurements taken at the start: same answer every time,
  // whatever the card has done since.
  const once = snapSpan(rightEdgeAt(2), grid, 1);
  for (let i = 0; i < 5; i++) assert.equal(snapSpan(rightEdgeAt(2), grid, once), once);
});

test("pulling the bottom edge snaps to rows, and one row is stored as no rows at all", () => {
  const unit = ROW_UNIT_REM * 16;
  assert.equal(snapRows(undefined, -unit * 0.2, unit), undefined);
  assert.equal(snapRows(undefined, unit * 0.4, unit), undefined, "less than half a row down: still one");
  assert.equal(snapRows(undefined, unit * 0.6, unit), 2);
  assert.equal(snapRows(undefined, unit * 2, unit), 3);
  assert.equal(snapRows(undefined, unit * 8, unit), 4, "held to 4");
  assert.equal(snapRows(3, -unit * 9, unit), undefined, "held to 1 — stored as none");
  assert.equal(snapRows(2, 500, 0), 2, "no unit to measure by: unchanged");
  assert.equal(snapRows(stepSize(2, -1), 0, 1), undefined, "the keyboard's one row is stored as none too");
});

/**
 * Review of #1087: rows came from the card's DRAWN height. A one-row list card that its content draws 26rem tall
 * started the pull "at" two-and-a-bit rows, so a 25px pull UP saved two rows — the opposite of the gesture.
 */
test("a card its content draws tall resizes from its configured rows, never from its drawn height", () => {
  const unit = ROW_UNIT_REM * 16;
  // One configured row, drawn 26rem tall: the drawn height plays no part.
  assert.equal(snapRows(undefined, -25, unit), undefined, "a small pull up on a tall one-row card stays one row");
  assert.equal(snapRows(undefined, -unit * 3, unit), undefined, "a big pull up cannot go below one");
  assert.equal(snapRows(undefined, unit * 0.6, unit), 2, "down grows it by one");
  // Content taller than its configured minimum (2 rows set, drawn as 3+): up shrinks, down grows — never the other way.
  for (const dy of [-25, -unit * 0.6, -unit * 1.6]) assert.ok((snapRows(2, dy, unit) ?? 1) <= 2, `up ${dy}px never grows a 2-row card`);
  for (const dy of [25, unit * 0.6, unit * 1.6]) assert.ok((snapRows(2, dy, unit) ?? 1) >= 2, `down ${dy}px never shrinks a 2-row card`);
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /snapRows\(rows, dy, ROW_UNIT_REM \* rem\)/, "the pull passes the configured rows and the pointer's travel");
  assert.doesNotMatch(canvas, /snapRows\(rect\.height/, "never the drawn height");
});

test("a row is the same height the card heights are drawn with", () => {
  // CARD_MIN_HEIGHT gives rows 2, 3 and 4 their minimums; the resize unit must
  // agree or a pull to "2 rows" would draw at a different height than it showed.
  for (const rows of [2, 3, 4] as const) {
    assert.match(CARD_MIN_HEIGHT[rows], new RegExp(`min-h-\\[${rows * ROW_UNIT_REM}rem\\]`));
  }
});

test("keyboard steps stay within 1 to 4", () => {
  assert.equal(stepSize(1, -1), 1);
  assert.equal(stepSize(1, 1), 2);
  assert.equal(stepSize(4, 1), 4);
  assert.equal(stepSize(3, -1), 2);
});

test("the badge reads columns by rows", () => {
  assert.equal(sizeLabel(2, undefined), "2 × 1");
  assert.equal(sizeLabel(3, 2), "3 × 2");
});

test("small movements do not change a size the person did not reach for", () => {
  assert.ok(RESIZE_DEAD_ZONE_PX >= 16, "a dead zone small enough to trip on a click is no dead zone");
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /Math\.abs\(dx\) >= RESIZE_DEAD_ZONE_PX/);
  assert.match(canvas, /Math\.abs\(dy\) >= RESIZE_DEAD_ZONE_PX/);
});

test("a resize is one saved change, written on release, and Escape puts it back", () => {
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  // During the pull only local state changes; the config is written once.
  assert.match(canvas, /onPull=\{setDraft\}/);
  assert.match(canvas, /const up = \(\) => finish\(true\)/);
  assert.match(canvas, /if \(key\.key === "Escape"\) finish\(false\)/);
  assert.match(canvas, /onRelease\(commit \? current : null\)/);
  // And it writes nothing but placement.
  assert.match(canvas, /updateCard\(card\.id, \(current\) => \(\{ \.\.\.current, span: next\.span, rows: next\.rows \}\)\)/);
});

test("the settle animation is switched off for anyone who asks for less motion, and leaves no transform behind", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  assert.match(css, /\.dashboard-card-settle \{\s*animation: dashboard-card-settle 220ms[^;]*;\s*\}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.dashboard-card-settle \{ animation: none; \}/);
  // No fill-mode: a lingering transform would trap position:fixed children.
  const rule = css.match(/\.dashboard-card-settle \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(rule, /\bboth\b|\bforwards\b/);
});
