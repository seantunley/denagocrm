"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical, Plus, Settings2, Trash2, X, Check, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  dropPreview,
  layoutWithMarker,
  moveCardInView,
  type DropPreview,
} from "@/lib/dashboard/canvasMove";
import type { CardConfig, SectionConfig, ViewConfig } from "@/lib/dashboard/config";
import { useEditor, newId } from "./EditorProvider";

/**
 * The dashboard as the user sees it, in both modes.
 *
 * ── ONE LAYOUT, TWO MODES ───────────────────────────────────────────────────
 *
 * Read-only and editing are the same component on purpose. Two components would
 * be two grid implementations, and the moment they diverge a card sits in one
 * place while you arrange it and another when you press Done — which reads as
 * the editor being broken rather than as a CSS difference. Edit mode adds chrome
 * and drag; it does not re-lay anything out.
 *
 * ── WHY THE CARDS ARRIVE AS PROPS ───────────────────────────────────────────
 *
 * Cards are SERVER-rendered — they run database queries and their permission
 * filtering happens before anything reaches the browser. So this component never
 * renders a card; it places a node the server already produced, looked up by id.
 * That is also the honest constraint on editing: moving a card is instant
 * because it only moves a node, while ADDING or reconfiguring one needs a server
 * round trip before there is anything to draw. A card with no node yet gets a
 * placeholder rather than an empty hole.
 *
 * ── THE DRAG RULES ARE INHERITED, NOT REDISCOVERED ──────────────────────────
 *
 * Four things, all of which were bugs in the first grid and are fixed here by
 * construction: the layout is driven by LOCAL state so a drop moves something
 * immediately; the reorder happens on drag-OVER so the gap you are dropping into
 * is the gap you can see; no sorting strategy is used because the cards are
 * different sizes and transform-based previews send them to visibly wrong
 * places; and droppables are re-measured continuously because the DOM genuinely
 * reorders under the pointer.
 */

const NO_TRANSFORM: SortingStrategy = () => null;
const MEASURE_ALWAYS = { droppable: { strategy: MeasuringStrategy.Always } };

const VIEW_COLUMNS: Record<1 | 2 | 3 | 4, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
};

const SECTION_SPAN: Record<1 | 2 | 3 | 4, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
};

export type CardSlots = Record<string, React.ReactNode>;

export default function DashboardCanvas({
  view,
  slots,
  onConfigure,
  onAddCard,
}: {
  view: ViewConfig;
  /** Server-rendered card nodes, by card id. Missing means "not drawn yet". */
  slots: CardSlots;
  /** Opens the card builder. Passed in so this file owns no dialog. */
  onConfigure: (cardId: string) => void;
  /** Opens the card picker for a section. */
  onAddCard: (sectionId: string) => void;
}) {
  const { editing, updateView } = useEditor();
  const [activeId, setActiveId] = useState<string | null>(null);
  /*
   * Where the card would land, so the destination is visible BEFORE the drop.
   *
   * This is the whole of what changes during a drag. The document does not: see
   * `dropPreview` for why reordering it under the pointer was what produced the
   * error page.
   */
  const [preview, setPreview] = useState<DropPreview | null>(null);
  /*
   * The last thing the pointer was over, so a drop that lands outside every
   * droppable still goes where the marker promised. dnd-kit reports `over` as
   * null in that case, and dropping a card into nothing should not silently
   * undo the whole gesture.
   */
  const lastOverId = useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /*
   * In edit mode every section is drawn, including ones that are empty or hidden
   * by their own rules. You cannot drop a card into a section that is not on the
   * screen, and a section you hid behind a condition is exactly the one you most
   * need to be able to open up and change.
   */
  const sections = editing ? view.sections : view.sections.filter((s) => hasDrawn(s, slots));

  const cardIds = useMemo(
    () => new Set(view.sections.flatMap((section) => section.cards).map((card) => card.id)),
    [view.sections],
  );

  /*
   * WHAT IS UNDER THE POINTER, not what is nearest the dragged thing.
   *
   * `closestCenter` measures from the centre of the dragged item to the centre
   * of each droppable. That works for a list of same-sized rows and badly for
   * this: cards here span one to four columns and vary in height, so the nearest
   * centre is regularly not the card the pointer is over — a wide card's centre
   * can be closer than the narrow card being pointed at. Combined with a drag
   * overlay that is a small label rather than the card itself, the measurement
   * was being taken from something the user could not see, and the card landed
   * somewhere they had not aimed. That is the "erratic" report.
   *
   * `pointerWithin` asks the only question the user is actually asking: what am I
   * holding this over?
   *
   * CARDS BEAT SECTIONS. A section's droppable covers its cards, so the pointer
   * is inside both and the section frequently wins on centre distance — which
   * would send the card to the end of the section every time it passed over one.
   * Cards are therefore preferred, and a section is only the answer when the
   * pointer is in its empty space. That is also what makes an emptied section
   * fillable again.
   *
   * `closestCenter` remains the fallback, for the keyboard sensor, which has no
   * pointer for `pointerWithin` to test.
   */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const within = pointerWithin(args);
      const overCard = within.filter((collision) => cardIds.has(String(collision.id)));
      if (overCard.length > 0) return overCard;
      if (within.length > 0) return within;

      const closest = closestCenter(args);
      const closestCard = closest.filter((collision) => cardIds.has(String(collision.id)));
      return closestCard.length > 0 ? closestCard : closest;
    },
    [cardIds],
  );

  /*
   * One drag is one undo step.
   *
   * Dragover fires on every pointer movement, so a drag across a section made
   * fifteen changes and left fifteen entries on a twenty-five entry undo stack.
   * The id is minted per drag and handed to every change it causes; the provider
   * folds them into the single step that reverses the whole motion.
   */
  const dragGesture = useRef<string | null>(null);

  function onDragStart(event: DragStartEvent) {
    dragGesture.current = `drag-${String(event.active.id)}-${Date.now()}`;
    setActiveId(String(event.active.id));
  }

  function endDrag() {
    dragGesture.current = null;
    lastOverId.current = null;
    setActiveId(null);
    setPreview(null);
  }

  /**
   * Commit the move, once, on the drop.
   *
   * The whole gesture is one change to the document, one save and one undo step.
   * It used to be one of each per pointer movement.
   */
  function onDragEnd(event: DragEndEvent) {
    const activeCardId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : lastOverId.current;
    const gesture = dragGesture.current ?? undefined;
    endDrag();
    if (!overId || overId === activeCardId) return;
    updateView(view.id, (current) => moveCardInView(current, activeCardId, overId), gesture);
  }

  /*
   * Live reorder, ACROSS sections as well as within one.
   *
   * The cross-section case is the whole reason this is not a single flat list:
   * `over` may be a card in another section, or the section itself when it is
   * empty. Both have to move the dragged card into that section, or a section
   * that has been emptied becomes impossible to fill again.
   *
   * The move itself is `moveCardInView`, which derives every index from the view
   * it is handed. It used to be computed half here and half inside the state
   * updater, from two different copies of the document — see that file's note.
   */
  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeCardId = String(active.id);
    const overId = String(over.id);
    if (activeCardId === overId) return;

    lastOverId.current = overId;
    const next = dropPreview(view, activeCardId, overId);
    // Only when it actually moved. Dragover fires on every pointer movement and
    // most of those events point at the same place as the last one.
    setPreview((current) =>
      current && next && current.sectionId === next.sectionId && current.index === next.index
        ? current
        : next,
    );
  }

  const activeCard = activeId
    ? view.sections.flatMap((s) => s.cards).find((c) => c.id === activeId)
    : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={MEASURE_ALWAYS}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={endDrag}
    >
      <div className={cn("grid items-start gap-4", VIEW_COLUMNS[view.columns])}>
        {sections.map((section) => (
          <SectionBlock
            key={section.id}
            view={view}
            section={section}
            slots={slots}
            activeId={activeId}
            dropAt={preview && preview.sectionId === section.id ? preview.index : null}
            onConfigure={onConfigure}
            onAddCard={onAddCard}
          />
        ))}
        {editing && (
          <button
            type="button"
            onClick={() =>
              updateView(view.id, (current) => ({
                ...current,
                sections: [
                  ...current.sections,
                  { id: newId("section"), columnSpan: 1, cards: [] },
                ],
              }))
            }
            className="flex min-h-24 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Plus className="size-3.5" />
            Add a group
          </button>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="flex cursor-grabbing items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg">
            <GripVertical className="size-3.5 text-muted-foreground" />
            {cardLabel(activeCard)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* ── a section ────────────────────────────────────────────────────── */

function SectionBlock({
  view,
  section,
  slots,
  activeId,
  dropAt,
  onConfigure,
  onAddCard,
}: {
  view: ViewConfig;
  section: SectionConfig;
  slots: CardSlots;
  /** The card being dragged anywhere on the canvas, or null. */
  activeId: string | null;
  /**
   * Where the marker goes in this group, counted over its cards WITHOUT the
   * dragged one — or null when the card would not land here.
   */
  dropAt: number | null;
  onConfigure: (cardId: string) => void;
  onAddCard: (sectionId: string) => void;
}) {
  const { editing, updateSection, updateView } = useEditor();
  // Same rule as the read-only path: in normal use a section with nothing drawn
  // leaves no empty box, because a heading over nothing reads as a failure.
  const drawn = section.cards.filter((card) => slots[card.id] !== undefined);
  const cards = editing ? section.cards : drawn;
  /*
   * Identity is load-bearing here - dnd-kit compares this array BY IDENTITY to
   * decide whether the list has changed. See the note on the SortableContext
   * below.
   *
   * Keyed on the ids as JSON rather than on the card objects: every edit
   * rebuilds the config, so an array of cards would be a new dependency on
   * every render and the memo would never hold. JSON rather than a joined
   * string because a card id can come from the raw editor and may contain any
   * character, including whatever separator was picked.
   */
  const cardIdKey = JSON.stringify(cards.map((card) => card.id));
  const sortableItems = useMemo(
    () => [...(JSON.parse(cardIdKey) as string[]), section.id],
    [cardIdKey, section.id],
  );

  /*
   * The cards, with a marker inserted where the dragged one would land.
   *
   * `dropAt` counts the cards WITHOUT the dragged one, so the dragged card is
   * skipped when counting while still being drawn in place — it has not moved,
   * and making it vanish mid-gesture would reflow the grid, which is the thing
   * this design exists to stop.
   *
   * A marker past the last slot lands at the end, which is what "dropped in the
   * empty space below the cards" means.
   */
  const byId = new Map(cards.map((card) => [card.id, card]));
  const withDropMarker = layoutWithMarker(
    cards.map((card) => card.id),
    activeId,
    dropAt,
  ).map((entry) =>
    entry.kind === "marker" ? (
      <DropMarker key="drop-marker" />
    ) : (
      <SortableCard
        key={entry.id}
        card={byId.get(entry.id)!}
        node={slots[entry.id]}
        onConfigure={onConfigure}
      />
    ),
  );

  // AFTER the hooks, deliberately. A hook below a conditional return is a
  // different number of hooks on the render where the condition flips, and React
  // ends that with "Rendered more hooks than during the previous render".
  if (!editing && drawn.length === 0) return null;

  return (
    <section
      className={cn(
        "min-w-0 space-y-3",
        SECTION_SPAN[section.columnSpan],
        editing && "rounded-xl border border-dashed border-border/70 p-3",
        // Which group is being dropped into, while it is being dropped into.
        dropAt !== null && "border-solid border-primary/60 bg-primary/[0.03]",
      )}
    >
      {(section.title || editing) && (
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              value={section.title ?? ""}
              onChange={(event) =>
                updateSection(
                  section.id,
                  (current) => ({ ...current, title: event.target.value || undefined }),
                  // Typing a name is one edit, not one per keystroke. Without
                  // this a ten-character name filled half the undo stack and
                  // pushed everything before it off the end.
                  `title-${section.id}`,
                )
              }
              placeholder="Group name (optional)"
              aria-label="Group name"
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground outline-none hover:border-border focus:border-primary/40"
            />
          ) : (
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h2>
          )}
          {editing && (
            <>
              <label className="sr-only" htmlFor={`span-${section.id}`}>
                Group width
              </label>
              <select
                id={`span-${section.id}`}
                value={section.columnSpan}
                onChange={(event) =>
                  updateSection(section.id, (current) => ({
                    ...current,
                    columnSpan: Number(event.target.value) as 1 | 2 | 3 | 4,
                  }))
                }
                className="rounded border border-border bg-card px-1 py-0.5 text-[11px] text-muted-foreground"
              >
                {([1, 2, 3, 4] as const).map((n) => (
                  <option key={n} value={n}>
                    {n} col
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="Delete this group"
                onClick={() =>
                  updateView(view.id, (current) => ({
                    ...current,
                    sections: current.sections.filter((s) => s.id !== section.id),
                  }))
                }
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      <SortableContext
        /*
         * The section id is in the list so an EMPTY section is still a drop
         * target. Without it a section you emptied can never be filled again.
         *
         * Memoised because dnd-kit compares this array BY IDENTITY, in several
         * places, to decide whether the list has changed — `previousItems !==
         * items` gates its layout-animation decision, and a ref is reconciled
         * against it on every commit. A fresh array each render made that
         * comparison permanently true, so it was answering "the list just
         * changed" continuously, for a list that had not changed at all.
         */
        items={sortableItems}
        strategy={NO_TRANSFORM}
      >
        {/* auto-rows gives the grid a base row height, without which a row is
            simply as tall as its tallest card and "span two rows" means
            nothing. A minimum rather than a fixed height, so an ordinary card
            still grows past it when its content needs to. */}
        <div
          className={cn(
            "grid items-start gap-4",
            // ONLY when something in this section actually spans rows.
            //
            // Applied unconditionally it forced EVERY row to 11rem, so a row of
            // short stat tiles reserved 176px and left a large blank gap under
            // it. The base row height exists solely to give a row span something
            // to span; where nothing spans, the grid should size to its content
            // exactly as it did before.
            section.cards.some((entry) => (entry.rows ?? 1) > 1) &&
              "sm:auto-rows-[minmax(11rem,auto)]",
            VIEW_COLUMNS[section.columnSpan],
          )}
        >
          {withDropMarker}
          {editing && (
            <button
              type="button"
              onClick={() => onAddCard(section.id)}
              className="flex min-h-20 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Plus className="size-3.5" />
              Add a card
            </button>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

/**
 * Where the card will land.
 *
 * The one thing that moves during a drag, and the answer to "you cannot see
 * where it is going to slot in, so it is a guess". It used to be answered by
 * reflowing the whole arrangement under the pointer, which said the same thing
 * far less clearly and is what produced the error page - see `dropPreview`.
 */
function DropMarker() {
  return (
    <div
      aria-hidden
      className="flex min-h-20 items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10"
    >
      <span className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground shadow-sm">
        Drops here
      </span>
    </div>
  );
}

/* ── a card ───────────────────────────────────────────────────────── */

const CARD_SPAN: Record<1 | 2 | 3 | 4, string> = {
  1: "sm:col-span-1",
  2: "sm:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
  4: "sm:col-span-2 lg:col-span-4",
};

/**
 * Height, in grid rows. Static strings for the same reason as the widths above.
 *
 * From `sm:` upward only: on a phone the grid is a single column and every card
 * is full width, so spanning rows would just leave a tall empty box.
 */
const CARD_ROWS: Record<1 | 2 | 3 | 4, string> = {
  1: "",
  2: "sm:row-span-2",
  3: "sm:row-span-3",
  4: "sm:row-span-4",
};

function SortableCard({
  card,
  node,
  onConfigure,
}: {
  card: CardConfig;
  node: React.ReactNode;
  onConfigure: (cardId: string) => void;
}) {
  const { editing, removeCard } = useEditor();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: card.id,
    disabled: !editing,
    /*
     * NO LAYOUT ANIMATION. This is the other half of "no transforms", and its
     * absence is what put an error page in front of the user.
     *
     * The strategy above is already NO_TRANSFORM, because these cards are
     * different sizes and transform-based previews send them to visibly wrong
     * places. But `animateLayoutChanges` is a SEPARATE mechanism, defaulted on,
     * and it survived that: on every index change useSortable's
     * `useDerivedTransform` measures the card, computes a FLIP delta and calls
     * setState from a LAYOUT effect, with a second effect that immediately sets
     * it back to null. That is two renders per index change, from the commit
     * phase.
     *
     * Reordering happens on dragover, so during a drag the index changes as fast
     * as the pointer moves, and droppables are re-measured continuously. Enough
     * of those pairs nest in one commit to pass React's limit, and React reports
     * it as "Maximum update depth exceeded" — thrown during commit, so the
     * route's error boundary catches it and shows an error page. The captured
     * stack named this hook directly:
     *
     *     at useDerivedTransform.useIsomorphicLayoutEffect (@dnd-kit/sortable)
     *     at commitHookLayoutEffects
     *
     * Nothing is lost by refusing it. The transform it produces is never read —
     * this component does not apply `transform` or `transition` to anything, by
     * the same decision that set NO_TRANSFORM.
     */
    animateLayoutChanges: () => false,
  });

  // Not in edit mode and nothing to draw — the card's own rules hid it, or it
  // had no rows. Either way it takes up no space.
  if (!editing && node === undefined) return null;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative min-w-0",
        CARD_SPAN[card.span],
        CARD_ROWS[card.rows ?? 1],
        /*
         * A card that claimed extra rows must FILL them, or it claims the space
         * and leaves it blank - which looks like a layout bug.
         *
         * SELF-STRETCH IS THE PART THAT DOES THE WORK, and h-full alone was
         * silently useless without it. The grid is `items-start`, so an item does
         * not stretch to its row: its height IS its content height, and h-full on
         * it resolves to 100% of that, which is nothing. The item has to opt out
         * of the start alignment before any height can be inherited at all.
         *
         * flex-col so the panel below can fill this box in turn. The chain has to
         * be unbroken from grid cell to visible card: wrapper -> content div ->
         * CardShell/SectionCard. A gap anywhere in it and the card stays short
         * inside a tall cell, which is the exact bug this feature claims to fix.
         */
        card.rows && card.rows > 1 ? "sm:h-full sm:self-stretch sm:flex sm:flex-col" : undefined,
        editing && "rounded-xl ring-1 ring-dashed ring-border",
      )}
    >
      {/*
          WHERE IT LANDS, drawn where it lands.

          The order already updates live as the pointer moves, so this cell IS the
          destination — but the only thing marking it was 30% opacity on a card
          that otherwise looked exactly like every other card on a dense screen.
          The report was that dropping is a guess, and it was: the answer was on
          the page and unreadable.

          An overlay rather than a replacement, so the cell keeps the size the
          card gave it and nothing reflows while the pointer is moving — a target
          that resizes as you approach it is worse than no target. The card
          underneath is dimmed rather than hidden, because which card is being
          moved is the other half of the question.
      */}
      {isDragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 border-dashed border-primary/50"
        />
      )}

      {editing && (
        <div className="absolute -top-2 right-2 z-20 flex items-center gap-1">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Move ${cardLabel(card)}`}
            className="flex size-7 cursor-grab items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onConfigure(card.id)}
            aria-label={`Settings for ${cardLabel(card)}`}
            className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"
          >
            <Settings2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => removeCard(card.id)}
            aria-label={`Remove ${cardLabel(card)}`}
            className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:border-destructive/50 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* The middle link in the height chain. min-h-0 because a flex child
          otherwise refuses to shrink below its content, which would break
          scrolling inside a card shorter than what it holds. */}
      <div
        className={cn(
          editing && "pointer-events-none select-none",
          card.rows && card.rows > 1 && "sm:min-h-0 sm:flex-1",
          // Faded under the drop marker above, not hidden: the card being moved
          // is still the thing being pointed at.
          isDragging && "opacity-40",
        )}
      >
        {node ?? <CardPlaceholder card={card} />}
      </div>
    </div>
  );
}

/**
 * Stands in for a card the server has not drawn yet.
 *
 * Two quite different situations land here and the copy has to tell them apart,
 * because confusing them is how the editor looks broken. A card just added has
 * no node until the save round-trips. A card that IS saved but is hidden by its
 * own visibility rule will never have one while that rule holds — and in edit
 * mode you still need to see it, or the rule you want to change is attached to
 * something invisible.
 */
function CardPlaceholder({ card }: { card: CardConfig }) {
  const hidden = Boolean(card.visibility && card.visibility.length > 0);
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-muted/20 p-4 text-center">
      <p className="text-xs font-medium text-foreground">{cardLabel(card)}</p>
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {hidden && <Eye className="size-3" />}
        {card.disabled
          ? "Switched off"
          : hidden
            ? "Hidden right now by its own rule"
            : "Will appear once saved"}
      </p>
    </div>
  );
}

/** A human name for a card, for drag overlays, labels and screen readers. */
export function cardLabel(card: CardConfig): string {
  if (card.title) return card.title;
  if (card.type === "builtin") return card.card.replace(/-/g, " ");
  return card.type;
}

function hasDrawn(section: SectionConfig, slots: CardSlots): boolean {
  return section.cards.some((card) => slots[card.id] !== undefined);
}
