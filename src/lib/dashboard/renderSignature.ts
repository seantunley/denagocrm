import type { CardConfig, DashboardConfig } from "./config";
import type { Condition } from "./conditions";

/**
 * What the SERVER has to draw, ignoring where the client puts it.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * Saving a dashboard called `revalidatePath("/")`, so every autosave re-rendered
 * the whole home screen on the server — every card's queries, for a change that
 * was usually "this card is now second instead of third". In development that
 * was a 17-to-23 second round trip per save, and a drag fires one every time the
 * user pauses.
 *
 * The cost is not only time. The re-render ships a new RSC payload, so the card
 * tree REMOUNTS: every dnd-kit droppable unregisters and registers again, mid
 * gesture. Under StrictMode's double-invoked effects that is enough dispatches
 * in one commit to pass React's nested-update limit, which it reports as
 * "Maximum update depth exceeded" — a render-phase throw, so the route's error
 * boundary catches it and the user gets an error page. Which is exactly what was
 * reported after "too much movement of cards".
 *
 * The client does not need any of it for a move. It is already holding every
 * card's rendered node and the whole config; a reorder is a rearrangement of
 * things it has. It needs the server only when a node it does not have has to
 * exist — a card added, reconfigured, switched off, or made visible.
 *
 * So this is the question "would the server draw something different?", and the
 * editor refreshes only when the answer changes.
 *
 * ── WHAT IS DELIBERATELY NOT IN IT ──────────────────────────────────────────
 *
 * POSITION. Cards are keyed by id and sorted by id, so moving one within a
 * section, or between two sections, produces the same signature. That is the
 * whole point: `fill()` in lib/dashboard/cards.tsx takes the section a card is
 * in as `_section` and does not read it, so the node genuinely does not depend
 * on it.
 *
 * SPAN AND ROWS. Applied by the client, in DashboardCanvas — the wrapper around
 * the node, not the node.
 *
 * ── WHAT IS, AND IS EASY TO MISS ────────────────────────────────────────────
 *
 * THE SECTION'S VISIBILITY. `renderViewSlots` refuses a whole section up front
 * when its rule does not admit the viewer, and then none of its cards is drawn
 * at all. So a card moved INTO or OUT OF a conditioned section changes what the
 * server would produce even though the card itself did not change. Carrying the
 * section's rule per card covers it, and costs nothing in the common case, where
 * sections have no rule and every card records the same `null`.
 *
 * A CONTAINER'S CHILD ORDER. A grid or stack is drawn on the server with its
 * children inside it, so reordering them changes that node. Children are
 * therefore reduced to their ids IN ORDER, and each child also appears in its
 * own right so its own configuration is covered.
 */

/** Fields the client applies itself, so a change to them needs no server. */
type Placement = "span" | "rows";
const PLACEMENT: Placement[] = ["span", "rows"];

/** One card, reduced to the part the server draws from. */
function definition(card: CardConfig): unknown {
  const entries = Object.entries(card).filter(([key]) => !PLACEMENT.includes(key as Placement));
  const reduced: Record<string, unknown> = Object.fromEntries(entries);
  if (card.type === "grid" || card.type === "stack") {
    // Order matters, the children's own configuration does not — they are each
    // recorded separately below.
    reduced.cards = card.cards.map((child) => child.id);
  }
  return reduced;
}

function collect(
  cards: CardConfig[],
  sectionVisibility: Condition[] | undefined,
  into: Map<string, string>,
): void {
  for (const card of cards) {
    into.set(card.id, JSON.stringify([definition(card), sectionVisibility ?? null]));
    if (card.type === "grid" || card.type === "stack") {
      collect(card.cards, sectionVisibility, into);
    }
  }
}

/**
 * A stable string that changes exactly when the server would draw something
 * different, and not when a card merely moves.
 */
export function renderSignature(config: DashboardConfig): string {
  const cards = new Map<string, string>();
  for (const view of config.views) {
    for (const section of view.sections) {
      collect(section.cards, section.visibility, cards);
    }
  }
  // Sorted by id, so the signature does not depend on the order cards were met.
  return JSON.stringify([...cards.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
