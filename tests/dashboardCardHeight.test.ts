import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/lib/dashboard/config";
import { CARD_MIN_HEIGHT } from "../src/components/dashboard/cards/placement";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Source with comments stripped, so a rule cannot be satisfied — or broken — by
 *  prose about it. These files describe the wrong mechanisms at length. */
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
 * this card is".
 *
 * ── WHY THE SECOND HALF OF THIS FILE IS A BOX MODEL ─────────────────────────
 *
 * Two mechanisms shipped before this one and both were caught by a person
 * looking at the screen rather than by a test, because the tests here asserted
 * that a class name appeared in a file. A class name appearing in a file is not
 * the claim anyone cares about. The claim is "a card set to two rows is at least
 * 22rem of visible card", and both broken versions satisfied every class-name
 * assertion while failing that.
 *
 * THIS IS NOT A BROWSER TEST, and it does not pretend to be one. There is no
 * viewport harness in this repo — the only headless browser here is
 * puppeteer-core, which exists to render guide PDFs and does not run in CI.
 * Standing up jsdom would not help either: jsdom has no layout engine and
 * reports every height as zero, which is how a geometry test can look thorough
 * and assert nothing.
 *
 * What it does instead is take the REAL class strings the components apply,
 * imported rather than grepped, and resolve them through the two CSS height
 * rules the bug turned on:
 *
 *   1. A box's used height is `max(its content height, its own min-height)`.
 *   2. A percentage height resolves ONLY against a containing block with a
 *      definite height. A parent carrying `min-height` and nothing else has
 *      `height: auto`, which is not definite, so the percentage computes to
 *      `auto` — CSS 2.1 §10.5. This is the rule the second broken version
 *      violated, and it is why `min-h-` on the wrapper plus `h-full` on the card
 *      produced a tall wrapper around a short card.
 *
 * The model is proved honest below by running BOTH previous mechanisms through
 * it and asserting it reports the defect each of them actually had. A model that
 * cannot fail the old code cannot vouch for the new code.
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

/* ── the box model ─────────────────────────────────────────────────────────
 *
 * Small on purpose. It understands the four height utilities this layout uses
 * and the two variants it uses them with, and it THROWS on anything else rather
 * than ignoring it — a class the model cannot read is a class it must not
 * silently vouch for. That is what turns "someone changed CARD_MIN_HEIGHT to a
 * mechanism this file does not model" into a failure instead of a pass.
 */

const REM = 16;
const SM = 640; // Tailwind's `sm` breakpoint, 40rem.

/** The properties this model resolves. Everything else in a class list is noise. */
type Decl = { height?: number | "100%"; minHeight?: number };

/** An element: the classes really on it, plus what its own contents need. */
type Element = {
  className: string;
  /** Height this element's contents want, in px. Leaves only. */
  contentHeight?: number;
  children?: Element[];
};

type Resolved = {
  /** The element's used height in px — what a ruler on the screen would read. */
  height: number;
  /** Height inside this element that nothing occupies. The bug, quantified. */
  blank: number;
  children: Resolved[];
};

function lengthPx(value: string): number {
  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (rem) return Number(rem[1]) * REM;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`the model cannot read the length "${value}"`);
}

/** One utility → the height declaration it makes, or null if it makes none. */
function declOf(utility: string): Decl | null {
  if (utility === "h-full") return { height: "100%" };
  const min = /^min-h-\[([^\]]+)\]$/.exec(utility);
  if (min) return { minHeight: lengthPx(min[1]) };
  const fixed = /^h-\[([^\]]+)\]$/.exec(utility);
  if (fixed) return { height: lengthPx(fixed[1]) };
  if (/^(min-)?h-/.test(utility)) {
    throw new Error(`the model cannot read the height utility "${utility}"`);
  }
  return null;
}

type Rule = { target: "self" | "children"; decl: Decl };

/**
 * The rules a class list produces at a given viewport width.
 *
 * `sm:` is honoured, and `[&>*]:` is what makes a rule land on the element's
 * direct CHILDREN rather than on the element itself — the distinction the whole
 * fix turns on. Any other variant throws.
 */
function rulesOf(className: string, viewport: number): Rule[] {
  const rules: Rule[] = [];
  for (const candidate of className.split(/\s+/).filter(Boolean)) {
    const parts = candidate.split(":");
    const utility = parts[parts.length - 1];
    const decl = declOf(utility);
    if (!decl) continue;

    let target: Rule["target"] = "self";
    let applies = true;
    for (const variant of parts.slice(0, -1)) {
      if (variant === "sm") applies &&= viewport >= SM;
      else if (variant === "[&>*]") target = "children";
      else throw new Error(`the model cannot read the variant "${variant}:" on "${candidate}"`);
    }
    if (applies) rules.push({ target, decl });
  }
  return rules;
}

function declFor(element: Element, parentClassName: string, viewport: number): Decl {
  const own = rulesOf(element.className, viewport).filter((r) => r.target === "self");
  // A `[&>*]:` rule on the parent is a direct-child selector, so it reaches this
  // element and stops. It never reaches this element's own children — which is
  // what keeps a container card's minimum off the cards nested inside it.
  const fromParent = rulesOf(parentClassName, viewport).filter((r) => r.target === "children");
  return [...own, ...fromParent].reduce<Decl>((acc, r) => ({ ...acc, ...r.decl }), {});
}

/**
 * Used height, per CSS 2.1 §10.5 and §10.7.
 *
 * `containingBlock` is the parent's DEFINITE height, or null when the parent is
 * `height: auto`. Passing null is the entire point of the model: a parent whose
 * only height declaration is `min-height` is auto-height, so a `height: 100%`
 * child gets null here and falls back to its content — which is exactly how a
 * 22rem wrapper came to hold a 9rem card.
 */
function resolve(
  element: Element,
  parentClassName: string,
  containingBlock: number | null,
  viewport: number,
): Resolved {
  const decl = declFor(element, parentClassName, viewport);

  const declared =
    typeof decl.height === "number"
      ? decl.height
      : decl.height === "100%"
        ? containingBlock // null when the containing block is auto → computes to auto
        : null;

  const children = (element.children ?? []).map((child) =>
    resolve(child, element.className, declared, viewport),
  );

  const content = element.children?.length
    ? children.reduce((sum, child) => sum + child.height, 0)
    : (element.contentHeight ?? 0);

  const height = Math.max(declared ?? content, decl.minHeight ?? 0);
  return { height, blank: height - content, children };
}

/**
 * A section grid, which is where the FIRST broken mechanism lived.
 *
 * One card per row, which is what a one-column section is and what every section
 * collapses to on a phone. `items-start` means a card is its own height and the
 * row is at least as tall; `auto-rows-[minmax(…,auto)]` would put a floor under
 * every row in the section, tall card or not.
 */
function resolveSection(sectionClassName: string, cards: Element[], viewport: number) {
  const autoRows = /auto-rows-\[minmax\(([^,]+),\s*auto\)\]/.exec(sectionClassName);
  const rowFloor = autoRows ? lengthPx(autoRows[1]) : 0;

  return cards.map((card) => {
    // A grid item in an `items-start` grid with no track sizing is not stretched,
    // so its containing block height is indefinite.
    const box = resolve(card, sectionClassName, null, viewport);
    const row = Math.max(rowFloor, box.height);
    return { row, box, blankInRow: row - box.height };
  });
}

test("the box model reports the defect each earlier mechanism actually had", () => {
  /*
   * The model's own test. Without this it is just arithmetic that agrees with
   * me; with it, the model is known to be able to fail.
   */
  const panel = { className: "flex h-full flex-col rounded-xl border p-4", contentHeight: 144 };

  // MECHANISM 1 — `row-span-2` on the card, `auto-rows-[minmax(11rem,auto)]` on
  // the section. The floor lands on every row in the section, so the two short
  // cards either side of the tall one get 176px rows they cannot fill.
  const one = resolveSection(
    "grid items-start gap-4 auto-rows-[minmax(11rem,auto)]",
    [
      { className: "min-w-0", children: [{ ...panel, contentHeight: 96 }] },
      { className: "min-w-0 row-span-2", children: [panel] },
      { className: "min-w-0", children: [{ ...panel, contentHeight: 120 }] },
    ],
    1280,
  );
  assert.equal(one[0].row, 176, "a short card's row picked up the section-wide floor");
  assert.equal(one[0].blankInRow, 80, "and 80px of it is empty");
  assert.equal(one[2].blankInRow, 56);

  // MECHANISM 2 — the minimum moved onto the placement box, with the panel's
  // `h-full` expected to fill it. It does not: `height: 100%` against an
  // auto-height parent computes to auto, so the card stays 144px inside a 352px
  // box. This is the finding, reproduced as a number.
  const two = resolveSection(
    "grid items-start gap-4",
    [{ className: "min-w-0 sm:min-h-[22rem]", children: [panel] }],
    1280,
  );
  assert.equal(two[0].box.height, 352, "the box took the minimum");
  assert.equal(two[0].box.children[0].height, 144, "the visible card did not");
  assert.equal(two[0].box.blank, 208, "208px of blank page under a short card");
});

// ── how height is actually applied ──────────────────────────────────────────

/** The placement box as the components build it, using the shipped classes. */
const placementBox = (rows: 1 | 2 | 3 | 4, panel: Element): Element => ({
  className: `min-w-0 sm:col-span-2 ${CARD_MIN_HEIGHT[rows]}`,
  children: [panel],
});

/** SectionCard's own root classes, read from the component so this cannot drift. */
function panelClassName(): string {
  const source = read("src/components/dashboard/sections.tsx");
  const body = source.slice(source.indexOf("export function SectionCard"));
  const match = /className="([^"]+)"/.exec(body);
  assert.ok(match, "SectionCard's panel classes could not be found — the model has no input");
  assert.match(match[1], /h-full/, "the panel still carries h-full, so the trap is still live");
  return match[1];
}

const shortPanel = (): Element => ({ className: panelClassName(), contentHeight: 144 });

test("a two-row card is at least 22rem of VISIBLE card, not 22rem of box", () => {
  /*
   * The assertion the previous two mechanisms both failed. `.height` here is the
   * bordered panel a person sees, not the wrapper around it, and `.blank` is the
   * empty strip between the two — the thing that was reported as "huge spaces".
   */
  const [{ box }] = resolveSection("grid items-start gap-4", [placementBox(2, shortPanel())], 1280);
  const panel = box.children[0];

  assert.ok(panel.height >= 22 * REM, `the panel is ${panel.height}px, wanted >= 352px`);
  assert.equal(panel.height, 352);
  assert.equal(box.height, panel.height, "the box is exactly as tall as the card inside it");
  assert.equal(box.blank, 0, "no blank strip between the box and the card");
});

test("three and four rows scale the same way", () => {
  for (const [rows, expected] of [
    [3, 33 * REM],
    [4, 44 * REM],
  ] as const) {
    const [{ box }] = resolveSection(
      "grid items-start gap-4",
      [placementBox(rows, shortPanel())],
      1280,
    );
    assert.equal(box.children[0].height, expected, `rows=${rows}`);
    assert.equal(box.blank, 0, `rows=${rows} left a gap`);
  }
});

test("the minimum does not reach the rows around it", () => {
  /*
   * The failure of mechanism 1, stated as the thing that must not happen again.
   * Nothing is applied to the grid, so the cards above and below a tall one keep
   * their own heights and their rows fit them exactly.
   */
  const [above, tall, below] = resolveSection(
    "grid items-start gap-4",
    [
      placementBox(1, { className: panelClassName(), contentHeight: 96 }),
      placementBox(2, shortPanel()),
      placementBox(1, { className: panelClassName(), contentHeight: 120 }),
    ],
    1280,
  );

  assert.equal(above.row, 96, "the row above grew");
  assert.equal(below.row, 120, "the row below grew");
  assert.equal(above.blankInRow, 0);
  assert.equal(below.blankInRow, 0);
  assert.equal(tall.box.children[0].height, 352, "and the tall card is still tall");
});

test("a card that never asked for a height gets none", () => {
  // rows undefined → CARD_MIN_HEIGHT[1], which must contribute no rule at all.
  assert.equal(CARD_MIN_HEIGHT[1], "");
  assert.deepEqual(rulesOf(CARD_MIN_HEIGHT[1], 1280), []);

  const [{ box }] = resolveSection("grid items-start gap-4", [placementBox(1, shortPanel())], 1280);
  assert.equal(box.children[0].height, 144, "the panel kept its natural height");
  assert.equal(box.height, 144);
});

test("a card taller than its minimum is not squashed back down to it", () => {
  const tall: Element = { className: panelClassName(), contentHeight: 700 };
  const [{ box }] = resolveSection("grid items-start gap-4", [placementBox(2, tall)], 1280);
  assert.equal(box.children[0].height, 700, "a minimum is a floor, not a height");
  assert.equal(box.blank, 0);
});

test("a nested card does not inherit its container's minimum", () => {
  /*
   * `[&>*]` is a direct-child selector, and it has to stay one. A grid card
   * holds other cards; a descendant match would make every card inside a two-row
   * container two rows tall as well.
   */
  const inner: Element = { className: panelClassName(), contentHeight: 90 };
  const containerCard: Element = { className: "min-w-0 space-y-2", children: [inner] };
  const [{ box }] = resolveSection(
    "grid items-start gap-4",
    [placementBox(2, containerCard)],
    1280,
  );

  assert.equal(box.children[0].height, 352, "the container card itself took the minimum");
  assert.equal(box.children[0].children[0].height, 90, "the card nested inside it did not");
});

test("on a phone the height is not applied at all", () => {
  // Every card is full width and stacked below `sm`, so a forced height would be
  // nothing but scrolling.
  const [{ box }] = resolveSection("grid items-start gap-4", [placementBox(4, shortPanel())], 390);
  assert.equal(box.children[0].height, 144);
  assert.equal(box.height, 144);
});

// ── the classes themselves ──────────────────────────────────────────────────

test("nothing in the height path imposes a height on a grid row", () => {
  /*
   * A source check, and it is the right shape for this one claim: `auto-rows`
   * and `row-span` are not things the box model above can be handed, they are
   * things that must not be written anywhere near this feature again.
   */
  for (const file of [
    "src/components/dashboard/cards/placement.ts",
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
  // the stylesheet and the control silently does nothing. This is genuinely a
  // property of the file's characters, which is why it is checked as one.
  const placement = code("src/components/dashboard/cards/placement.ts");
  assert.doesNotMatch(placement, /min-h-\[\$\{/);
  for (const value of Object.values(CARD_MIN_HEIGHT)) {
    if (!value) continue;
    assert.ok(
      placement.includes(`"${value}"`),
      `"${value}" is assembled rather than written out, so Tailwind will not emit it`,
    );
  }
});

test("the minimum is handed to the panel, never worn by the box", () => {
  // Stated against the values themselves: every rule the table produces targets
  // children. A rule that targeted `self` would be the wrapper-with-a-gap again.
  for (const [rows, value] of Object.entries(CARD_MIN_HEIGHT)) {
    for (const rule of rulesOf(value, 1280)) {
      assert.equal(rule.target, "children", `rows=${rows} put "${value}" on the box itself`);
    }
    assert.equal(rulesOf(value, 390).length, 0, `rows=${rows} applies below sm`);
  }
});

// ── the control ─────────────────────────────────────────────────────────────

test("the editor offers height, and lights the right chip for an unset card", () => {
  const builder = read("src/components/dashboard/editor/CardBuilder.tsx");
  assert.match(builder, /<Label>Height<\/Label>/);
  // The trap: comparing card.rows directly leaves no chip lit on every card that
  // has never been resized, which is most of them.
  assert.match(builder, /\(card\.rows \?\? 1\) === n/, "an unset card must show as 1");
});

test("choosing height 1 clears the field rather than storing it", () => {
  const builder = read("src/components/dashboard/editor/CardBuilder.tsx");
  assert.match(
    builder,
    /rows: n === 1 \? undefined : n/,
    "storing rows:1 would freeze the card at today's natural height",
  );
});

test("the editor's own wrapper carries the height, so nothing shifts on Done", () => {
  /*
   * In edit mode a pointer-events wrapper sits between the placement box and the
   * card, which makes IT the panel's direct parent — so the `[&>*]` rule has to
   * be on the wrapper, and must NOT also be on the box, where it would stretch
   * the absolutely-positioned drag chrome into a 22rem click-eating overlay.
   */
  const canvas = read("src/components/dashboard/editor/DashboardCanvas.tsx");
  assert.match(canvas, /!editing && CARD_MIN_HEIGHT\[card\.rows \?\? 1\]/);
  assert.match(canvas, /"pointer-events-none select-none", CARD_MIN_HEIGHT\[card\.rows \?\? 1\]/);

  // And the same geometry, resolved: box → wrapper → panel, all three the same
  // height, because only the innermost one has a minimum to meet.
  const box: Element = {
    className: "relative min-w-0 sm:col-span-2",
    children: [
      {
        className: `pointer-events-none select-none ${CARD_MIN_HEIGHT[2]}`,
        children: [shortPanel()],
      },
    ],
  };
  const [{ box: laid }] = resolveSection("grid items-start gap-4", [box], 1280);
  assert.equal(laid.children[0].children[0].height, 352, "the card is tall while editing too");
  assert.equal(laid.height, 352);
  assert.equal(laid.blank, 0);
});
