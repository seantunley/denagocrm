"use client";

import { useEffect, useState, useTransition } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
 * Local state is optimistic and the server action runs in a transition, matching
 * how KanbanBoard already handles a drag: apply locally, persist in the
 * background, tell the user and roll back if it fails.
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

function SortableCard({
  card,
  editing,
  onRemove,
}: {
  card: GridCard;
  editing: boolean;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: !editing,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative min-w-0",
        SPAN_CLASS[card.span],
        isDragging && "z-10 opacity-80",
        editing && "rounded-xl ring-1 ring-dashed ring-border",
      )}
    >
      {editing && (
        <div className="absolute -top-2 right-2 z-20 flex items-center gap-1">
          <button
            type="button"
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
  /** The rendered, permission-filtered, condition-passing cards, in saved order. */
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
  const [order, setOrder] = useState<string[]>(savedOrder);
  const [, startTransition] = useTransition();

  // Re-seed when the server sends a new layout (after a save revalidates `/`).
  useEffect(() => setOrder(savedOrder), [savedOrder]);

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

  // Only the visible cards take part in the drag, but the order that gets SAVED
  // is the full saved list with the visible ones resequenced. A hidden-by-
  // condition card keeps its place relative to its neighbours instead of being
  // dropped by the next reorder.
  const visibleIds = cards.map((c) => c.id);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = visibleIds.indexOf(String(active.id));
    const to = visibleIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const resequenced = arrayMove(visibleIds, from, to);
    // Walk the saved order, replacing each visible slot with the next id from
    // the resequenced list; hidden ids pass through untouched.
    let cursor = 0;
    const next = order.map((id) => (visibleIds.includes(id) ? resequenced[cursor++] : id));
    persist(next, order);
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

      {editing && addable.length > 0 && (
        <div className="rounded-xl border border-dashed border-border p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Add a card
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
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {cards.map((card) => (
              <SortableCard key={card.id} card={card} editing={editing} onRemove={removeCard} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {cards.length === 0 && (
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
