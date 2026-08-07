"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "sonner";
import { GripVertical, Plus, RotateCcw, Settings2, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveDashboardLayout, resetDashboardLayout } from "@/app/actions/dashboard";

/**
 * The arrangeable dashboard.
 *
 * The server renders every card the viewer is entitled to and hands the finished
 * nodes down as props — this component never fetches anything and never learns
 * what a card it was not given would have contained. Permission filtering has
 * already happened by the time anything reaches the browser, which is the point:
 * hiding a card in client code would ship its data to the client first.
 *
 * SAVING IS IMMEDIATE — there is no Save button, and that is a deliberate choice.
 * A drop is already an unambiguous commit gesture; there is no partial or
 * invalid intermediate arrangement that a user might want to abandon, the way
 * there is in a half-filled form. An explicit Save would instead create the one
 * genuinely bad state: a home screen showing an arrangement the database does
 * not have, on the page users are most likely to navigate away from without
 * looking back. The cost of being wrong is a drag back, not lost work.
 *
 * ── HOW THE DRAG ACTUALLY MOVES THINGS ──────────────────────────────────────
 *
 * `order` is the source of truth for what is drawn, and the `cards` prop is only
 * a lookup table of rendered nodes. That direction matters: rendering straight
 * from `cards` would mean a drop changed nothing on screen until the server
 * action returned and revalidated `/`, so the card would visibly snap back and
 * then jump a beat later. Everything the user sees comes from local state; the
 * save is a background consequence of it.
 *
 * The reorder happens on DRAG OVER, not on drop — the grid reflows live under
 * the pointer, so the gap you are about to drop into is the gap you can see.
 * That also removes the need for the sortable strategies, which shift the other
 * items by transform and assume every item is the same size. These cards are
 * not: they span one, two or three columns and their heights differ by a factor
 * of five, so a transform-based preview sends them to visibly wrong places.
 * `NO_TRANSFORM` turns that off, the DOM order is the preview, and a
 * `DragOverlay` chip follows the cursor so there is still something in hand.
 */

export type GridCard = {
  id: string;
  title: string;
  span: 1 | 2 | 3;
  node: React.ReactNode;
};

export type AddableCard = {
  id: string;
  title: string;
  description: string;
  conditional: boolean;
};

/**
 * Column spans as STATIC class names. Tailwind scans source text, so a computed
 * `lg:col-span-${n}` would never be generated into the stylesheet.
 */
const SPAN_CLASS: Record<1 | 2 | 3, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
};

/**
 * No item is displaced by transform — see the header note. The live DOM order is
 * the drop preview, which is the only thing that reads correctly when items are
 * different sizes.
 */
const NO_TRANSFORM: SortingStrategy = () => null;

/**
 * Re-measure the drop targets continuously, not once at drag-start.
 *
 * This pairs with the live reorder and is not optional. dnd-kit's default is to
 * measure droppables when a drag BEGINS, which is correct for the usual sortable
 * — items there never move in the DOM, they are only displaced by transform, so
 * their real rects never change. Here the DOM genuinely reorders under the
 * pointer, so drag-start rects go stale the moment the first swap happens and
 * every collision after it is computed against where the cards used to be.
 */
const MEASURE_ALWAYS = { droppable: { strategy: MeasuringStrategy.Always } };

/**
 * The user's order, extended with any rendered card it does not mention.
 *
 * The two lists agree by construction today (the server derives the cards from
 * the same saved layout), but a card that arrived without a slot would otherwise
 * be silently dropped from the home screen — the one failure this component must
 * not have. Appending is total, so it cannot happen.
 */
function mergeOrder(saved: readonly string[], present: readonly string[]): string[] {
  const seen = new Set(saved);
  return [...saved, ...present.filter((id) => !seen.has(id))];
}

function SortableCard({
  card,
  editing,
  onRemove,
}: {
  card: GridCard;
  editing: boolean;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: card.id,
    disabled: !editing,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative min-w-0",
        SPAN_CLASS[card.span],
        editing && "rounded-xl ring-1 ring-dashed ring-border",
        // The card stays in its live-reordered slot, faded — that IS the drop
        // preview. The overlay chip is what follows the pointer.
        isDragging && "opacity-30",
      )}
    >
      {editing && (
        <div className="absolute -top-2 right-2 z-20 flex items-center gap-1">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Move ${card.title}`}
            className="flex size-7 cursor-grab items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onRemove(card.id)}
            aria-label={`Remove ${card.title}`}
            className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:border-destructive/50 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {/* Pointer events off while arranging, so a drag never fires a card's links. */}
      <div className={cn(editing && "pointer-events-none select-none")}>{card.node}</div>
    </div>
  );
}

export default function DashboardGrid({
  cards,
  addable,
  savedOrder,
}: {
  /** The rendered, permission-filtered, condition-passing cards. */
  cards: GridCard[];
  /** Cards this user may add but has not — already filtered by permission. */
  addable: AddableCard[];
  /**
   * The user's FULL saved layout, including cards that loaded but whose
   * condition hid them this render. Saving must not silently drop a card just
   * because it happened to be quiet at the moment someone reordered another one.
   */
  savedOrder: string[];
}) {
  const [editing, setEditing] = useState(false);
  const presentIds = cards.map((c) => c.id);
  const [order, setOrder] = useState<string[]>(() => mergeOrder(savedOrder, presentIds));
  const [activeId, setActiveId] = useState<string | null>(null);
  // The arrangement as it stood when the drag began, so a cancel or a refused
  // save puts every card back where the user found it.
  const beforeDrag = useRef<string[]>([]);
  const [, startTransition] = useTransition();

  /*
   * Re-seed when the SERVER's layout changes.
   *
   * Keyed on the joined contents, not on the array, and this is load-bearing:
   * `savedOrder` is a fresh array on every render of the page, so a
   * reference-compared effect would fire during the save transition — while the
   * server still holds the OLD order — and yank the card the user just dropped
   * back to where it started.
   */
  const seedKey = `${savedOrder.join(",")}|${presentIds.join(",")}`;
  const seedRef = useRef(seedKey);
  useEffect(() => {
    if (seedRef.current === seedKey) return;
    seedRef.current = seedKey;
    setOrder(mergeOrder(savedOrder, presentIds));
    // presentIds/savedOrder are folded into seedKey by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // A press-delay on touch so a vertical swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function persist(next: string[], previous: string[]) {
    setOrder(next);
    startTransition(async () => {
      const result = await saveDashboardLayout(next).catch(() => ({
        error: "Could not save your dashboard.",
      }));
      if (result?.error) {
        setOrder(previous);
        toast.error(result.error);
      }
    });
  }

  // What is actually drawn, in the user's order. Cards whose condition hid them
  // this render simply have no entry in the lookup and fall out here, while
  // keeping their slot in `order` for the next save.
  const byId = new Map(cards.map((c) => [c.id, c]));
  const visibleIds = order.filter((id) => byId.has(id));
  const activeCard = activeId ? byId.get(activeId) : undefined;

  function onDragStart(event: DragStartEvent) {
    beforeDrag.current = order;
    setActiveId(String(event.active.id));
  }

  /*
   * Live reorder. Both indices are taken from the FULL order, not from the
   * visible subset, so a card hidden by its condition keeps its place among its
   * neighbours instead of being shuffled to the end by the next drag.
   */
  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrder((prev) => {
      const from = prev.indexOf(String(active.id));
      const to = prev.indexOf(String(over.id));
      if (from < 0 || to < 0 || from === to) return prev;
      return arrayMove(prev, from, to);
    });
  }

  function onDragEnd(_event: DragEndEvent) {
    setActiveId(null);
    const previous = beforeDrag.current;
    // `order` already holds the arrangement the user can see, put there by the
    // drag-over handler. Nothing to move here — only to save, and only if the
    // drag actually changed something.
    if (order.length === previous.length && order.every((id, i) => id === previous[i])) return;
    persist(order, previous);
  }

  function onDragCancel() {
    setActiveId(null);
    setOrder(beforeDrag.current);
  }

  const removeCard = (id: string) => persist(order.filter((x) => x !== id), order);
  const addCard = (id: string) => persist([...order, id], order);

  function reset() {
    const previous = order;
    startTransition(async () => {
      const result = await resetDashboardLayout().catch(() => ({
        error: "Could not reset your dashboard.",
      }));
      if (result?.error) {
        setOrder(previous);
        toast.error(result.error);
      } else {
        toast.success("Dashboard reset to the default arrangement.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
            Reset to default
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
            editing
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {editing ? <Check className="size-3.5" /> : <Settings2 className="size-3.5" />}
          {editing ? "Done" : "Customise"}
        </button>
      </div>

      {editing && (
        <div className="rounded-xl border border-dashed border-border p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {addable.length > 0 ? "Add a card" : "Arranging"}
          </p>
          <div className="flex flex-wrap gap-2">
            {addable.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => addCard(c.id)}
                title={c.description}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <Plus className="size-3.5" />
                {c.title}
                {/* Conditional cards are badged, or a user adds one, sees
                    nothing because there is nothing to show, and concludes the
                    button is broken. */}
                {c.conditional && (
                  <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-muted-foreground">
                    when relevant
                  </span>
                )}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Drag a card by its grip handle to move it, or focus a handle and use the arrow keys.
            Changes save as you make them.
          </p>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        measuring={MEASURE_ALWAYS}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={visibleIds} strategy={NO_TRANSFORM}>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {visibleIds.map((id) => {
              const card = byId.get(id)!;
              return <SortableCard key={id} card={card} editing={editing} onRemove={removeCard} />;
            })}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <div className="flex cursor-grabbing items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg">
              <GripVertical className="size-3.5 text-muted-foreground" />
              {activeCard.title}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {visibleIds.length === 0 && (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium text-foreground">Nothing needs you right now.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {addable.length > 0
              ? "Cards appear here when there is something to show. Use Customise to add more."
              : "Cards will appear here as work comes in."}
          </p>
        </div>
      )}
    </div>
  );
}
