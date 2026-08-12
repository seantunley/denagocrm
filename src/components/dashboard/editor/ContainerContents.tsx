"use client";

import { ArrowUpFromLine, ChevronDown, ChevronUp, Settings2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_CARD_DEPTH, type CardConfig } from "@/lib/dashboard/config";
import { isContainerCard } from "@/lib/dashboard/cardTree";

/**
 * The cards inside a container, listed so they can actually be worked with.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A grid or stack renders its children on the SERVER, inside its own node, so
 * the editor never has a sortable element for any of them. Drag therefore only
 * ever reordered the TOP level, and a card placed inside a group had no settings
 * button, no remove and no way back out — the only route to it was the raw JSON
 * editor. That is what "these are not individual widgets" and "I can add a
 * visibility rule but no other settings" were both describing: the selected card
 * was the container, and its children were unreachable.
 *
 * ── AND WHY IT RECURSES ─────────────────────────────────────────────────────
 *
 * The first version of this listed `card.cards` and stopped. That reached a
 * container's immediate children and nothing further, which is a fix for exactly
 * one level of a structure that is defined as arbitrarily nestable. Grid A
 * holding grid B holding stat C left C in precisely the state this component was
 * written to end: B became selectable and C did not.
 *
 * The tree helpers were never the problem — reorderCards and liftCards have
 * always descended, so the DATA operation could always reach C. What was missing
 * was the UI that lets anyone ASK for it. A helper that can move a card nobody
 * can select is not a feature, and a test proving the helper recurses proves
 * nothing about whether the card is reachable. So this lists descendants, not
 * children, and every row it draws is a row a person can act on.
 *
 * ── PURE, AND THAT IS DELIBERATE ────────────────────────────────────────────
 *
 * No `useEditor`, no hooks, no drag context: the four actions arrive as props.
 * The component that owns them is one line longer for it, and in exchange this
 * one can be rendered by a test process with no DOM and no server actions in its
 * import graph — which is the only way to demonstrate that a grandchild really is
 * offered controls, rather than to assert that the source looks as though it
 * would be.
 *
 * ── NUDGE BUTTONS, NOT NESTED DRAG ──────────────────────────────────────────
 *
 * Dragging inside a dragging thing is the part that behaves erratically, and a
 * card that moves exactly one place when asked beats one that sometimes lands
 * where you meant.
 */

export type ContainerActions = {
  /** Open the settings dialog for this card. */
  onConfigure: (cardId: string) => void;
  /** Move one place among its own siblings, at whatever depth it sits. */
  onMove: (cardId: string, direction: -1 | 1) => void;
  /** Take it out of its container, to just after that container. */
  onLift: (cardId: string) => void;
  onRemove: (cardId: string) => void;
};

/**
 * How many nested lists deep this may go.
 *
 * NOTHING LEGAL IS EVER CUT BY THIS. The schema caps container nesting at
 * MAX_CARD_DEPTH — `cardSchema` stops offering container types at the floor, so
 * a config nested deeper fails to parse and is dropped — and a config arrives as
 * JSON, so it cannot refer to itself either.
 *
 * The bound is here because both of those are promises made by the CALLER, and
 * without it the depth this recurses to is decided by its input rather than by
 * the schema. A future caller that renders before parsing, or a cap raised in
 * config.ts by somebody who never opened this file, would then be choosing how
 * far a component recurses without knowing it. What each renderer does with a
 * runaway tree differs and none of it is good, so one comparison per row settles
 * the question here instead of leaving it to whichever one is running.
 *
 * Reaching the bound means the config is already illegal, so there is no message:
 * the cards below the cut are still reachable through the raw editor.
 */
const MAX_LIST_DEPTH = MAX_CARD_DEPTH;

export default function ContainerContents({
  cards,
  actions,
  depth = 0,
}: {
  cards: CardConfig[];
  actions: ContainerActions;
  /** Nesting of this LIST, not of the card. 0 is a top-level container's own contents. */
  depth?: number;
}) {
  if (cards.length === 0) {
    return (
      <p
        className={cn(
          "rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground",
          depth === 0 && "mb-2",
        )}
      >
        This group is empty. Add a card to it from the raw editor, or drag one in.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "space-y-1",
        depth === 0 && "mb-2 rounded-lg border border-dashed border-border p-1.5",
      )}
    >
      {depth === 0 && (
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          In this group
        </p>
      )}
      {cards.map((child, index) => (
        <div key={child.id}>
          <div className="flex items-center gap-1 rounded-md bg-card/60 px-1.5 py-1">
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
              {cardLabel(child)}
            </span>
            <button
              type="button"
              onClick={() => actions.onMove(child.id, -1)}
              disabled={index === 0}
              aria-label={`Move ${cardLabel(child)} earlier`}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => actions.onMove(child.id, 1)}
              disabled={index === cards.length - 1}
              aria-label={`Move ${cardLabel(child)} later`}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ChevronDown className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => actions.onLift(child.id)}
              aria-label={`Move ${cardLabel(child)} out of this group`}
              title="Move out of this group"
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <ArrowUpFromLine className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => actions.onConfigure(child.id)}
              aria-label={`Settings for ${cardLabel(child)}`}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <Settings2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => actions.onRemove(child.id)}
              aria-label={`Remove ${cardLabel(child)}`}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {/* A child that is itself a container gets its own list, immediately
              under its row and indented, so the nesting on screen matches the
              nesting in the config. Without this the grandchild has no row at
              all, and no row means no settings, no move, no lift and no remove
              — the exact state a container's children were in before any of
              this existed. */}
          {isContainerCard(child) && depth + 1 < MAX_LIST_DEPTH && (
            <div className="ml-2 mt-1 border-l border-dashed border-border pl-2">
              <ContainerContents cards={child.cards} actions={actions} depth={depth + 1} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A human name for a card, for drag overlays, labels and screen readers. */
export function cardLabel(card: CardConfig): string {
  if (card.title) return card.title;
  if (card.type === "builtin") return card.card.replace(/-/g, " ");
  return card.type;
}
