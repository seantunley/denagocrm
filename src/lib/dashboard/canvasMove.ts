import type { SectionConfig, ViewConfig } from "./config";

/**
 * Where a dragged card lands.
 *
 * ── WHY THIS IS NOT IN THE CANVAS ───────────────────────────────────────────
 *
 * It used to be, computed half in the drag handler and half inside the state
 * updater — and the two halves read DIFFERENT copies of the view. The handler
 * looked up the source section, the target section and the insertion index from
 * the `view` prop, then applied those indices to `current` inside the updater.
 * Those are the same document only when React has already re-rendered with the
 * previous move committed, which during a fast drag it frequently has not:
 * dragover fires far faster than a render, so the second event of a drag
 * computed its indices against the arrangement from before the first one.
 *
 * The result was a card inserted one position out, or into the position it had
 * already left — the "erratic" part of dragging. Everything here is derived from
 * the view it is given, so there is only ever one copy to be wrong about.
 *
 * ── RETURNING THE SAME OBJECT MEANS "NOTHING MOVED" ─────────────────────────
 *
 * Every no-op path returns the `view` argument itself, by reference. The editor
 * checks for exactly that and skips validation, the undo entry and the save.
 * That matters more than it sounds: dragover fires on every pointer move, and
 * most of those events do not change the order at all. Without the check, a
 * single drag across a section ran the strict parser over the whole config
 * dozens of times and queued dozens of writes of an identical document.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 *
 * Top-level cards within sections. Cards nested inside a `grid` or `stack`
 * container are not draggable on this canvas — they are reordered from the
 * container's own controls — so descending into `card.cards` here would move a
 * card the drag layer never offered as a target.
 */

/** The section holding this card, or undefined if it is not a top-level card. */
function sectionOf(view: ViewConfig, cardId: string): SectionConfig | undefined {
  return view.sections.find((section) => section.cards.some((card) => card.id === cardId));
}

/**
 * Move `activeCardId` to wherever `overId` points.
 *
 * `overId` is either a card — take that card's place — or a section, which
 * happens when the pointer is over a section's empty space and means "put it at
 * the end here". Both are needed: without the section case a section you emptied
 * could never be filled again.
 *
 * Returns the same `view` object when the move is a no-op.
 */
export function moveCardInView(view: ViewConfig, activeCardId: string, overId: string): ViewConfig {
  if (activeCardId === overId) return view;

  const from = sectionOf(view, activeCardId);
  if (!from) return view;

  const target = view.sections.find((section) => section.id === overId) ?? sectionOf(view, overId);
  if (!target) return view;

  const moving = from.cards.find((card) => card.id === activeCardId);
  if (!moving) return view;

  if (from.id === target.id) {
    const fromIndex = from.cards.findIndex((card) => card.id === activeCardId);
    /*
     * Over the section rather than a card means the pointer is in the empty
     * space below the cards, so the card goes last. Previously this resolved to
     * an index of -1 and the move was silently dropped, which is why dragging a
     * card to the bottom of its own section did nothing at all.
     */
    const toIndex =
      overId === target.id
        ? from.cards.length - 1
        : from.cards.findIndex((card) => card.id === overId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return view;

    const cards = [...from.cards];
    const [lifted] = cards.splice(fromIndex, 1);
    cards.splice(toIndex, 0, lifted);
    return {
      ...view,
      sections: view.sections.map((section) =>
        section.id === from.id ? { ...section, cards } : section,
      ),
    };
  }

  // Into a different section. Over the section itself appends; over a card takes
  // that card's index, so the card lands in the gap that opened on screen.
  const overIndex = target.cards.findIndex((card) => card.id === overId);
  const insertAt = overId === target.id || overIndex < 0 ? target.cards.length : overIndex;

  return {
    ...view,
    sections: view.sections.map((section) => {
      if (section.id === from.id) {
        return { ...section, cards: section.cards.filter((card) => card.id !== activeCardId) };
      }
      if (section.id === target.id) {
        const cards = [...section.cards];
        cards.splice(insertAt, 0, moving);
        return { ...section, cards };
      }
      return section;
    }),
  };
}
