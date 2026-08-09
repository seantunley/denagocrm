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

// ── how height is actually applied ──────────────────────────────────────────

test("height is a minimum on the CARD, not a grid row span", () => {
  /*
   * THE MECHANISM CHANGED, and the reason is the whole story of this feature.
   *
   * It started as `row-span-*` plus `auto-rows-[minmax(11rem,auto)]` on the
   * container, because spanning rows only means anything if rows have a known
   * height. But `auto-rows` sets that minimum for EVERY row in the section — so
   * the moment one card was made two rows tall, every other row became 176px and
   * short cards sat in tall empty boxes.
   *
   * That was the "huge spaces" report. Two rounds of narrowing WHEN the class
   * applied (unconditional → per-section → per-drawn-card) never fixed it,
   * because each was treating a symptom of the wrong mechanism. Evidence
   * finally settled it: the stored dashboard genuinely had a rows:2 card, so the
   * class was applying correctly and still ruining the section.
   *
   * A minimum height on the card affects that card alone. Its row grows to fit
   * it, exactly as a row already grows for a tall chart, and no other row moves.
   */
  const shell = code("src/components/dashboard/cards/shell.tsx");
  assert.match(shell, /CARD_MIN_HEIGHT/);
  assert.match(shell, /sm:min-h-\[22rem\]/);
  assert.match(shell, /sm:min-h-\[33rem\]/);
  assert.match(shell, /sm:min-h-\[44rem\]/);

  // The grid must no longer impose a row height on anything.
  for (const file of [
    "src/components/dashboard/cards/shell.tsx",
    "src/components/dashboard/cards/container.tsx",
    "src/components/dashboard/editor/DashboardCanvas.tsx",
  ]) {
    assert.doesNotMatch(
      code(file),
      /auto-rows-\[minmax/,
      `${file}: a grid row minimum affects every row in the section`,
    );
    assert.doesNotMatch(code(file), /row-span-\d/, `${file}: spanning rows is gone`);
  }
});

test("the height classes are static strings", () => {
  // Tailwind scans source TEXT, so a computed `min-h-[${n}rem]` never reaches
  // the stylesheet and the control silently does nothing.
  const shell = code("src/components/dashboard/cards/shell.tsx");
  assert.doesNotMatch(shell, /min-h-\[\$\{/);
});

test("a taller card is applied where the card is placed, at both levels", () => {
  const canvas = code("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /CARD_MIN_HEIGHT\[card\.rows \?\? 1\]/);

  const container = code("src/components/dashboard/cards/container.tsx");
  assert.match(container, /CARD_MIN_HEIGHT\[child\.rows \?\? 1\]/);
});

test("height only applies from sm upward", () => {
  // On a phone every card is full width and stacked, so a forced height is just
  // empty space.
  const shell = code("src/components/dashboard/cards/shell.tsx");
  const table = shell.slice(shell.indexOf("CARD_MIN_HEIGHT"));
  const block = table.slice(0, table.indexOf("};"));
  assert.equal(block.match(/"(?!sm:)min-h-/g), null, "an unprefixed height applies on phones too");
});

test("a normal card is untouched", () => {
  // Height 1 must contribute no class at all — otherwise every card on every
  // dashboard gets a minimum it never asked for.
  const shell = code("src/components/dashboard/cards/shell.tsx");
  const table = shell.slice(shell.indexOf("CARD_MIN_HEIGHT"));
  assert.match(table.slice(0, table.indexOf("};")), /1: "",/);
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
