import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/lib/dashboard/config";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Source with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * CARD HEIGHT.
 *
 * Width has always been configurable and height never was, so a chart sat at the
 * same height as a two-number stat tile and a long list scrolled inside a box
 * that could have been twice the size. This is the other half of "pick how big
 * this card is", and the gap that showed up most clearly when comparing this
 * dashboard against Home Assistant's, where a card's rows and columns are both
 * picked directly on the card.
 */

const view = (cards: unknown[]) => ({
  views: [
    {
      id: "v1",
      path: "main",
      title: "Main",
      columns: 3,
      sections: [{ id: "s1", columnSpan: 3, cards }],
    },
  ],
});

function firstCard(config: unknown) {
  const parsed = parseConfig(config);
  return parsed.config.views[0].sections[0].cards[0];
}

// ── the stored shape ────────────────────────────────────────────────────────

test("a card saved before height existed still parses, and is unchanged", () => {
  // Every card in every stored config predates this field.
  const card = firstCard(view([{ id: "c1", type: "markdown", span: 2, content: "hi" }]));
  assert.equal(card.span, 2);
  assert.equal(card.rows, undefined, "absent means natural height");
});

test("a chosen height survives a round trip", () => {
  const card = firstCard(view([{ id: "c1", type: "markdown", span: 2, rows: 3, content: "hi" }]));
  assert.equal(card.rows, 3);
});

test("height is not defaulted to 1 on the way in", () => {
  // A zod .default(1) would write rows:1 into every card the next time anyone
  // saved — bloating configs with a value nobody chose, and freezing each card
  // at today's natural height so a later release could never improve it.
  const card = firstCard(view([{ id: "c1", type: "markdown", span: 1, content: "hi" }]));
  assert.ok(!("rows" in card) || card.rows === undefined);
});

test("an out-of-range height is refused, exactly as an out-of-range width is", () => {
  // The parser drops the whole card rather than clamping the value. That is not
  // a choice this field invented — `span: 99` behaves identically, and matching
  // it matters more than my first instinct that a bad height should degrade to a
  // good one. A card is refused as a unit or accepted as a unit.
  const cardsFor = (card: unknown) =>
    parseConfig(view([card])).config.views[0]?.sections[0]?.cards ?? [];

  for (const rows of [0, 5, 99, -1, 2.5, "2", null]) {
    const cards = cardsFor({ id: "c1", type: "markdown", span: 1, rows, content: "hi" });
    if (cards.length) {
      const value = (cards[0] as { rows?: number }).rows;
      assert.ok(
        value === undefined || (Number.isInteger(value) && value >= 1 && value <= 4),
        `rows=${JSON.stringify(rows)} survived as ${JSON.stringify(value)}`,
      );
    }
  }

  // And the same input shape is refused for width, which is what makes the
  // behaviour above consistent rather than accidental.
  assert.equal(cardsFor({ id: "c1", type: "markdown", span: 99, content: "hi" }).length, 0);
  assert.equal(cardsFor({ id: "c1", type: "markdown", span: 1, rows: 99, content: "hi" }).length, 0);
});

// ── the classes actually exist ──────────────────────────────────────────────

test("row spans are static class names, not built from a variable", () => {
  // Tailwind scans source TEXT. A computed `row-span-${n}` never reaches the
  // stylesheet, and the card silently stays one row tall — the exact failure the
  // column tables in this codebase are commented at length to avoid.
  const shell = code("src/components/dashboard/cards/shell.tsx");
  assert.match(shell, /sm:row-span-2/);
  assert.match(shell, /sm:row-span-3/);
  assert.match(shell, /sm:row-span-4/);
  assert.doesNotMatch(shell, /row-span-\$\{/, "a computed row-span class does not exist at runtime");

  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /sm:row-span-2/);
  assert.doesNotMatch(canvas, /row-span-\$\{/);
});

test("the grid has a base row height, or spanning rows means nothing", () => {
  // Without auto-rows a row is as tall as its tallest card, so a two-row card is
  // simply itself and the control appears broken.
  for (const file of [
    "src/components/dashboard/cards/shell.tsx",
    "src/components/dashboard/editor/DashboardCanvas.tsx",
  ]) {
    assert.match(code(file), /auto-rows-\[minmax\(/, `${file} must give its grid a base row height`);
  }
});

test("a taller card fills the space it claimed", () => {
  // Claiming two rows and rendering at natural height leaves a visible gap that
  // reads as a layout bug.
  for (const file of [
    "src/components/dashboard/cards/container.tsx",
    "src/components/dashboard/editor/DashboardCanvas.tsx",
  ]) {
    assert.match(code(file), /sm:h-full/, `${file} must stretch a multi-row card`);
  }
});

test("row spans start at sm, never on a phone", () => {
  // On a phone the grid is one column and every card is full width, so spanning
  // rows would leave a tall empty box.
  const shell = code("src/components/dashboard/cards/shell.tsx");
  const table = shell.slice(shell.indexOf("ROW_SPAN_CLASS"));
  const block = table.slice(0, table.indexOf("};"));
  const bare = block.match(/"(?!sm:)row-span-\d"/g);
  assert.equal(bare, null, `unprefixed row spans apply on phones too: ${bare}`);
});

// ── the control ─────────────────────────────────────────────────────────────

test("the editor offers height, and lights the right chip for an unset card", () => {
  const builder = code("src/components/dashboard/editor/CardBuilder.tsx");
  assert.match(builder, /<Label>Height<\/Label>/);
  // The trap: comparing card.rows directly leaves no chip lit on every card that
  // has never been resized, which is most of them.
  assert.match(builder, /\(card\.rows \?\? 1\) === n/, "an unset card must show as 1");
});

test("choosing height 1 clears the field rather than storing it", () => {
  const builder = code("src/components/dashboard/editor/CardBuilder.tsx");
  assert.match(
    builder,
    /rows: n === 1 \? undefined : n/,
    "storing rows:1 would freeze the card at today's natural height",
  );
});
