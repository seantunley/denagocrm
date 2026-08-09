import type { CardConfig, DashboardConfig } from "./config";

/**
 * Moving cards around the tree, independently of how they are drawn.
 *
 * A card inside a grid or stack is rendered by that container on the SERVER, so
 * the editor never has a sortable element for it. Drag could therefore only ever
 * reorder the top level, and a card placed inside a group had no way to be
 * moved, reordered or taken back out — the only route to it was the raw JSON.
 *
 * These operate on the CONFIG rather than on rendered nodes, so one
 * implementation covers any depth and there is still exactly one grid renderer.
 *
 * They live here, with no React and no imports beyond the config types, because
 * the provider that used to hold them is a client component full of hooks and
 * cannot be imported into a test process. A tree walk that silently fails to
 * descend is precisely the bug worth executing a test against rather than
 * matching source text for.
 */

/**
 * Move a card one place among its siblings, wherever it sits.
 *
 * Sibling-relative rather than absolute: the card stays in the list it is in,
 * which is what "move it left a bit" means to somebody looking at a group. A
 * card already at either end simply does not move — deliberately a no-op rather
 * than hopping into a neighbouring container, which would be a surprising thing
 * for a nudge button to do.
 */
export function reorderCards(cards: CardConfig[], id: string, direction: -1 | 1): CardConfig[] | null {
  const index = cards.findIndex((card) => card.id === id);
  if (index !== -1) {
    const target = index + direction;
    if (target < 0 || target >= cards.length) return cards;
    const next = [...cards];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
  // Not at this level — descend, and only rebuild the branch that changed.
  let changed = false;
  const mapped = cards.map((card) => {
    if (card.type !== "grid" && card.type !== "stack") return card;
    const inner = reorderCards(card.cards, id, direction);
    if (!inner) return card;
    changed = true;
    return { ...card, cards: inner };
  });
  return changed ? mapped : null;
}

export function reorderInTree(config: DashboardConfig, id: string, direction: -1 | 1): DashboardConfig {
  return {
    ...config,
    views: config.views.map((view) => ({
      ...view,
      sections: view.sections.map((section) => {
        const next = reorderCards(section.cards, id, direction);
        return next ? { ...section, cards: next } : section;
      }),
    })),
  };
}

/**
 * Take a card out of its container and drop it immediately after that container.
 *
 * After, not before, and not at the end: the card was visually inside the group,
 * so the nearest position that is still "about here" is just past it. Landing it
 * at the end of the section would make un-nesting feel like losing the card.
 *
 * A card that is not inside a container is returned untouched — lifting a
 * top-level card has nowhere to go.
 */
export function liftCards(cards: CardConfig[], id: string): CardConfig[] | null {
  let changed = false;
  const out: CardConfig[] = [];

  for (const card of cards) {
    if (card.type === "grid" || card.type === "stack") {
      const child = card.cards.find((entry) => entry.id === id);
      if (child) {
        // Found it one level down: drop it in immediately after its container.
        out.push({ ...card, cards: card.cards.filter((entry) => entry.id !== id) });
        out.push(child);
        changed = true;
        continue;
      }
      // Not here — it may be deeper, in which case the lift already happened
      // inside that branch and this level only has to keep the rebuilt subtree.
      const deeper = liftCards(card.cards, id);
      if (deeper) {
        out.push({ ...card, cards: deeper });
        changed = true;
        continue;
      }
    }
    out.push(card);
  }

  // null means "nothing here changed", so callers can keep the original array
  // and avoid rebuilding branches that did not move.
  return changed ? out : null;
}

export function liftFromContainer(config: DashboardConfig, id: string): DashboardConfig {
  return {
    ...config,
    views: config.views.map((view) => ({
      ...view,
      sections: view.sections.map((section) => {
        const next = liftCards(section.cards, id);
        return next ? { ...section, cards: next } : section;
      }),
    })),
  };
}

