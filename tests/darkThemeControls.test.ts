import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * Two visual defects that no type checker or behavioural test can see, and that
 * a screenshot found instead. Both are pinned here because both are one careless
 * edit away from returning.
 */

// ── The flow builder's zoom controls ────────────────────────────────────────

test("REACT FLOW'S CONTROL BUTTONS ARE THEMED, NOT JUST THEIR CONTAINER", () => {
  /*
   * `@xyflow/react/dist/style.css` styles `.react-flow__controls-button`
   * itself — `background: #fefefe`, a light border, a dark icon. Colouring only
   * the wrapper therefore leaves FOUR WHITE SQUARES sitting on the dark canvas,
   * which is exactly how this was reported.
   *
   * The container class alone looks correct in review, which is why this asserts
   * the inner selector rather than trusting the presence of a className.
   */
  for (const rel of ["src/components/FlowBuilder.tsx", "src/components/signflow/SignFlowBuilder.tsx"]) {
    const source = read(rel);
    const controls = source.slice(source.indexOf("<Controls"), source.indexOf("<Controls") + 900);
    assert.match(
      controls,
      /\[&_\.react-flow__controls-button\]:!bg-/,
      `${rel}: the BUTTONS need a background, not only the container`,
    );
    assert.match(
      controls,
      /\[&_\.react-flow__controls-button\]:!text-/,
      `${rel}: …and a foreground colour, or the icons stay dark on dark`,
    );
    assert.match(
      controls,
      /\[&_\.react-flow__controls-button_svg\]:!fill-current/,
      `${rel}: the icon fill is set by the library and must be overridden too`,
    );
  }
});

// ── The status pill ─────────────────────────────────────────────────────────

test("A STATUS PILL NEVER WRAPS — it is the small item in a flex row", () => {
  /*
   * A pill is nearly always the right-hand item of a flex row whose left side is
   * a heading and a paragraph. Without `shrink-0`, flexbox may shrink it below
   * the width of its own text, and the text wraps — so "0 live" rendered as a
   * tall green CIRCLE with the number above the word, on the Chatbot page.
   *
   * Fixed on the component rather than that one call site: every StatusPill in a
   * flex row has the same exposure, and a label that wraps has stopped being a
   * pill.
   */
  const source = read("src/components/visual-system.tsx");
  const pill = source.slice(source.indexOf("export function StatusPill"));
  const classes = pill.slice(0, pill.indexOf("{children}"));
  assert.match(classes, /shrink-0/, "flexbox must not be allowed to squeeze a pill below its text");
  assert.match(classes, /whitespace-nowrap/, "and the label must never break across lines");
});
