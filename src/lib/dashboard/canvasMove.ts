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

/** Where a marker should be drawn to promise where the card will land. */
export type DropPreview = {
  sectionId: string;
  /** Insertion index into that section's cards WITH the dragged card removed. */
  index: number;
};

/**
 * Where the card would land if it were dropped now.
 *
 * ── WHY A PREVIEW AND NOT A MOVE ────────────────────────────────────────────
 *
 * The canvas used to apply the real move on every dragover, so the arrangement
 * reflowed live under the pointer. The intention was good — the gap you drop
 * into is the gap you can see — and the mechanism is what put an error page in
 * front of the user.
 *
 * Two cards can swap forever. Drag A over B and A takes B's index, so the order
 * becomes B, A. The pointer has not moved, but the card beneath it is now B
 * again, so the next dragover moves A back, and the next moves it forward. With
 * droppables re-measured on every render, dragover keeps firing and the pair
 * oscillates as fast as React can render.
 *
 * That is not a theory about the crash; it is what the captured stack shows.
 * dnd-kit's SortableContext only calls `measureDroppableContainers` when its
 * item list has CHANGED IN VALUE, and it was calling it from a layout effect
 * often enough, in a single commit, to pass React's nested-update limit —
 * reported as "Maximum update depth exceeded", thrown during commit, caught by
 * the route's error boundary. Every one of those calls means the order changed
 * again.
 *
 * So the order no longer changes during a drag. Nothing moves, nothing is
 * re-measured, nothing is saved, and there is no pair to oscillate: the canvas
 * draws a marker where the card will go, and `moveCardInView` runs once, on
 * drop. The promise the live reflow was making is kept by the marker, which is
 * also the thing that was actually missing — the report was that dropping is a
 * guess, and a grid quietly reflowing under the pointer is not an answer to it.
 *
 * ── THE INDEX ───────────────────────────────────────────────────────────────
 *
 * Counted over the section's cards WITHOUT the dragged one, because that is the
 * list the card is being inserted into and the only count that matches where it
 * ends up. Dragging the first card onto the second returns 1, not 0: with the
 * first removed the second is at 0, and the card goes after it.
 *
 * The invariant, which the tests assert directly, is that this index is where
 * `moveCardInView` actually puts the card. A marker that promises one position
 * and a drop that delivers another is worse than no marker.
 */
export function dropPreview(
  view: ViewConfig,
  activeCardId: string,
  overId: string,
): DropPreview | null {
  const from = sectionOf(view, activeCardId);
  if (!from) return null;

  const target = view.sections.find((section) => section.id === overId) ?? sectionOf(view, overId);
  if (!target) return null;

  // Over the section rather than a card: the empty space below everything, so
  // the card goes last. Counted without the dragged card, which for a move
  // within one section is one shorter than the section's own list.
  const without = target.cards.filter((card) => card.id !== activeCardId);
  if (overId === target.id) return { sectionId: target.id, index: without.length };

  /*
   * Over a card: its index in the section's OWN list, dragged card included.
   *
   * Not its index in `without`, which is the tempting mistake and is wrong by
   * one for every forward move within a section. `moveCardInView` lifts the
   * card out and re-inserts it at the index the target had BEFORE the lift —
   * the arrayMove semantics — so dragging the first card onto the third lands
   * it at 2, while its index among the remaining two is 1.
   *
   * Cross-section, the two counts are identical, because the dragged card was
   * never in the target to begin with.
   */
  const index = target.cards.findIndex((card) => card.id === overId);
  if (index < 0) return { sectionId: target.id, index: without.length };
  return { sectionId: target.id, index };
}

/** Enough of a rectangle to place a pointer against it. */
export type Box = { top: number; left: number; width: number; height: number };

/** Distance from a point to a rectangle. Zero inside it. */
function distanceTo(box: Box, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - (box.left + box.width));
  const dy = Math.max(box.top - y, 0, y - (box.top + box.height));
  return Math.hypot(dx, dy);
}

/** Whether the pointer is past this card in reading order. */
function isPast(box: Box, x: number, y: number): boolean {
  if (y < box.top) return false;
  if (y > box.top + box.height) return true;
  // Level with the card: the horizontal midpoint decides, so crossing halfway
  // across a card is what moves the marker to its other side.
  return x > box.left + box.width / 2;
}

/**
 * Which droppable the pointer means when it is over a SECTION but not a card.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Over a section used to mean one thing: append. That is right for a section
 * with nothing in it and wrong almost everywhere else, because the pointer is
 * over the section rather than a card far more often than it sounds — the
 * section has padding, it holds an "Add a card" button, the grid is
 * `items-start` so short cards leave empty space beneath them in their own row,
 * and the section stretches to its tallest column.
 *
 * So the marker kept jumping to the bottom of the group while the card being
 * dragged was near the top: the two were nowhere near each other, and the
 * marker stopped meaning anything.
 *
 * Now the empty space between and around cards resolves to the card the pointer
 * is nearest, on the side it is nearest to. "Before card X" is X itself.
 * "After X" is the card that follows it — and after the LAST card is the
 * section, which is the one case where append was right all along.
 *
 * The dragged card is excluded by the caller: it is where the pointer already
 * is, and offering it as the target means dropping a card onto itself.
 */
export function insertionTargetInSection(
  cardIds: string[],
  rectOf: (id: string) => Box | undefined,
  pointer: { x: number; y: number },
  sectionId: string,
): string {
  const measured = cardIds
    .map((id) => ({ id, box: rectOf(id) }))
    .filter((entry): entry is { id: string; box: Box } => entry.box !== undefined);
  if (measured.length === 0) return sectionId;

  let nearest = measured[0];
  let best = distanceTo(nearest.box, pointer.x, pointer.y);
  for (const entry of measured.slice(1)) {
    const distance = distanceTo(entry.box, pointer.x, pointer.y);
    if (distance < best) {
      best = distance;
      nearest = entry;
    }
  }

  if (!isPast(nearest.box, pointer.x, pointer.y)) return nearest.id;
  const next = measured[measured.indexOf(nearest) + 1];
  return next ? next.id : sectionId;
}

/** One thing the canvas draws in a section: a card, or the drop marker. */
export type CanvasSlot = { kind: "card"; id: string } | { kind: "marker" };

/**
 * A section's cards with the drop marker inserted where the card will land.
 *
 * Pure, and separate from the component, because the placement is an off-by-one
 * waiting to happen and the only way to be sure of it is to run it. The marker
 * has to go BEFORE the card currently occupying its slot, and the dragged card
 * has to be skipped while counting — it has not moved, so it is still drawn, but
 * `dropAt` counts the list it is being inserted into, which does not include it.
 *
 * A `dropAt` past the last slot means the end, which is what "dropped in the
 * empty space below the cards" resolves to.
 */
export function layoutWithMarker(
  cardIds: string[],
  activeId: string | null,
  dropAt: number | null,
): CanvasSlot[] {
  const slots: CanvasSlot[] = [];
  let slot = 0;
  for (const id of cardIds) {
    if (id === activeId) {
      slots.push({ kind: "card", id });
      continue;
    }
    if (dropAt === slot) slots.push({ kind: "marker" });
    slot += 1;
    slots.push({ kind: "card", id });
  }
  if (dropAt !== null && dropAt >= slot) slots.push({ kind: "marker" });
  return slots;
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
