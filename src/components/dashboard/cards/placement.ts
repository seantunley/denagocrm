/**
 * WHERE a card sits and HOW BIG it is, as class names.
 *
 * ── WHY THIS IS A LEAF .ts AND NOT PART OF ./shell.tsx ──────────────────────
 *
 * These tables were module members of ./shell.tsx, which renders `CardShell` and
 * therefore imports `SectionCard`, which imports the activity button, which
 * imports the server action, which imports `server-only`. Importing shell.tsx
 * outside Next — from a unit test, say — throws before a single class name can be
 * read.
 *
 * That is not a tidiness point, it is the reason the height bug shipped twice.
 * A test that cannot IMPORT these values can only read the file as text and
 * assert that a class appears somewhere in it, which proves the string exists and
 * proves nothing about the box it produces. Both broken versions of the height
 * mechanism passed tests of exactly that kind. Pure data in a leaf module can be
 * imported and fed to something that computes a geometry from it — see
 * tests/dashboardCardHeight.test.ts.
 *
 * Every value here is a STATIC string. Tailwind scans source TEXT, so a computed
 * `lg:col-span-${n}` or `min-h-[${n}rem]` is never generated into the stylesheet
 * and the control silently does nothing at all.
 */

/**
 * Column spans inside a card grid.
 *
 * Indexed by the container's column count FIRST, so the clamp is baked into the
 * table rather than applied at the call site — a card asking for four columns
 * inside a two-column grid gets the full row instead of overflowing it. The
 * breakpoint each span takes effect at matches the breakpoint its grid actually
 * gains that column at (see GRID_COLUMNS_CLASS), so nothing spans more columns
 * than exist at any width.
 */
export const SPAN_IN_GRID: Record<2 | 3 | 4, Record<1 | 2 | 3 | 4, string>> = {
  2: {
    1: "sm:col-span-1",
    2: "sm:col-span-2",
    3: "sm:col-span-2",
    4: "sm:col-span-2",
  },
  3: {
    1: "sm:col-span-1",
    2: "sm:col-span-2",
    3: "sm:col-span-2 lg:col-span-3",
    4: "sm:col-span-2 lg:col-span-3",
  },
  4: {
    1: "sm:col-span-1",
    2: "sm:col-span-2",
    3: "sm:col-span-2 lg:col-span-3",
    4: "sm:col-span-2 lg:col-span-4",
  },
};

/**
 * How TALL a card is: a minimum height on the PANEL, reached through the box
 * that holds it.
 *
 * Read the variant, because the variant is the entire fix. This is
 * `[&>*]:min-h-…`, not `min-h-…`. It is worn by the placement box and it lands
 * on that box's DIRECT CHILD — the bordered panel you can actually see.
 *
 * ── TWO WRONG MECHANISMS PRECEDED IT, AND THE SECOND IS THE SUBTLE ONE ──────
 *
 * The first was `row-span-*` plus `auto-rows-[minmax(11rem,auto)]` on the grid.
 * Spanning rows only means something if rows have a known height, but `auto-rows`
 * sets that minimum for EVERY row in the section, so one two-row card made every
 * other row 176px tall and short cards sat in tall empty boxes. That was the
 * "huge spaces" report.
 *
 * The second looked like the fix and was not. It moved the minimum onto the
 * placement BOX — `min-h-[22rem]` on the wrapper div — and relied on the panel's
 * `h-full` to fill it. `h-full` is `height: 100%`, and a percentage height only
 * resolves against a containing block with a DEFINITE height. A box with nothing
 * but `min-height` has `height: auto`, so the percentage computes to `auto` and
 * the panel stays exactly as tall as its contents. The result is the identical
 * SYMPTOM by a different route: a 22rem box holding a 9rem card and 13rem of
 * blank page under it. The gap moved from the neighbouring rows to inside the
 * card's own cell, which is why "the huge spaces are still there" kept coming
 * back after each round.
 *
 * ── WHY THE CHILD SELECTOR, RATHER THAN FLEX ON THE BOX ─────────────────────
 *
 * `flex flex-col` on the box with `grow` on the child also resolves it, and is
 * the usual answer. It is not used here for two reasons specific to this layout.
 * The box in DashboardCanvas carries `empty:hidden` so a card that resolved to
 * nothing cannot hold a grid cell open — and `display: flex` and `display: none`
 * are the same property, so a `sm:flex` on that box would beat `empty:hidden`
 * above 640px and bring the empty cells back. The same box also holds the edit
 * chrome, so "make every child grow" needs qualifying about which child.
 *
 * Handing the minimum to the child touches no property the box already uses. The
 * box keeps `height: auto` and therefore ends up exactly as tall as the panel it
 * contains: there is no second box that can be taller than the card inside it, so
 * the blank strip is not something this layout is able to express.
 *
 * `>` and not a descendant selector, deliberately. A grid or stack card contains
 * other cards; a descendant match would push the outer card's minimum onto every
 * card nested inside it.
 *
 * From `sm:` upward only — on a phone every card is full width and stacked, so a
 * forced height is just empty space.
 *
 * The element wearing this must be the panel's DIRECT parent. Where something
 * sits in between (the editor's pointer-events wrapper), it goes on that instead,
 * not on both.
 */
export const CARD_MIN_HEIGHT: Record<1 | 2 | 3 | 4, string> = {
  1: "",
  2: "sm:[&>*]:min-h-[22rem]",
  3: "sm:[&>*]:min-h-[33rem]",
  4: "sm:[&>*]:min-h-[44rem]",
};

/** One column on a phone, always — a two-column card grid at 380px is unreadable. */
export const GRID_COLUMNS_CLASS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
};

/**
 * A span inside a HORIZONTAL stack, where there is no column grid to span — the
 * children share the row in proportion instead.
 */
export const STACK_GROW: Record<1 | 2 | 3 | 4, string> = {
  1: "grow",
  2: "grow-[2]",
  3: "grow-[3]",
  4: "grow-[4]",
};
