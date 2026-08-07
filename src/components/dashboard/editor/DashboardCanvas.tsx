"use client";

import { useState } from "react";
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
import { GripVertical, Plus, Settings2, Trash2, X, Check, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
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

  function findSectionOf(cardId: string): SectionConfig | undefined {
    return view.sections.find((section) => section.cards.some((card) => card.id === cardId));
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  /*
   * Live reorder, ACROSS sections as well as within one.
   *
   * The cross-section case is the whole reason this is not a single flat list:
   * `over` may be a card in another section, or the section itself when it is
   * empty. Both have to move the dragged card into that section, or a section
   * that has been emptied becomes impossible to fill again.
   */
  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeCardId = String(active.id);
    const overId = String(over.id);
    if (activeCardId === overId) return;

    const from = findSectionOf(activeCardId);
    if (!from) return;
    const toSection =
      view.sections.find((section) => section.id === overId) ?? findSectionOf(overId);
    if (!toSection) return;

    updateView(view.id, (current) => {
      const moving = from.cards.find((card) => card.id === activeCardId);
      if (!moving) return current;

      if (from.id === toSection.id) {
        const fromIndex = from.cards.findIndex((card) => card.id === activeCardId);
        const toIndex = from.cards.findIndex((card) => card.id === overId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
        return {
          ...current,
          sections: current.sections.map((section) =>
            section.id === from.id
              ? { ...section, cards: arrayMove(section.cards, fromIndex, toIndex) }
              : section,
          ),
        };
      }

      // Dropped over the section itself (it is empty) → append. Over a card →
      // take that card's place, so the drop lands where the gap opened.
      const insertAt =
        overId === toSection.id
          ? toSection.cards.length
          : Math.max(0, toSection.cards.findIndex((card) => card.id === overId));

      return {
        ...current,
        sections: current.sections.map((section) => {
          if (section.id === from.id) {
            return { ...section, cards: section.cards.filter((card) => card.id !== activeCardId) };
          }
          if (section.id === toSection.id) {
            const next = [...section.cards];
            next.splice(insertAt, 0, moving);
            return { ...section, cards: next };
          }
          return section;
        }),
      };
    });
  }

  const activeCard = activeId
    ? view.sections.flatMap((s) => s.cards).find((c) => c.id === activeId)
    : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={MEASURE_ALWAYS}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={(_event: DragEndEvent) => setActiveId(null)}
      onDragCancel={() => setActiveId(null)}
    >
      <div className={cn("grid items-start gap-4", VIEW_COLUMNS[view.columns])}>
        {sections.map((section) => (
          <SectionBlock
            key={section.id}
            view={view}
            section={section}
            slots={slots}
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
  onConfigure,
  onAddCard,
}: {
  view: ViewConfig;
  section: SectionConfig;
  slots: CardSlots;
  onConfigure: (cardId: string) => void;
  onAddCard: (sectionId: string) => void;
}) {
  const { editing, updateSection, updateView } = useEditor();
  // Same rule as the read-only path: in normal use a section with nothing drawn
  // leaves no empty box, because a heading over nothing reads as a failure.
  const drawn = section.cards.filter((card) => slots[card.id] !== undefined);
  if (!editing && drawn.length === 0) return null;

  const cards = editing ? section.cards : drawn;

  return (
    <section
      className={cn(
        "min-w-0 space-y-3",
        SECTION_SPAN[section.columnSpan],
        editing && "rounded-xl border border-dashed border-border/70 p-3",
      )}
    >
      {(section.title || editing) && (
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              value={section.title ?? ""}
              onChange={(event) =>
                updateSection(section.id, (current) => ({
                  ...current,
                  title: event.target.value || undefined,
                }))
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
        // The section id is in the list so an EMPTY section is still a drop
        // target. Without it a section you emptied can never be filled again.
        items={[...cards.map((card) => card.id), section.id]}
        strategy={NO_TRANSFORM}
      >
        <div className={cn("grid items-start gap-4", VIEW_COLUMNS[section.columnSpan])}>
          {cards.map((card) => (
            <SortableCard
              key={card.id}
              card={card}
              node={slots[card.id]}
              onConfigure={onConfigure}
            />
          ))}
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

/* ── a card ───────────────────────────────────────────────────────── */

const CARD_SPAN: Record<1 | 2 | 3 | 4, string> = {
  1: "sm:col-span-1",
  2: "sm:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
  4: "sm:col-span-2 lg:col-span-4",
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
        editing && "rounded-xl ring-1 ring-dashed ring-border",
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

      <div className={cn(editing && "pointer-events-none select-none")}>
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
