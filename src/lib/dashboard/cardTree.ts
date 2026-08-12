import type { CardConfig, DashboardConfig, GridCardConfig, StackCardConfig } from "./config";

/**
 * Every walk over the card tree, independently of how the cards are drawn.
 *
 * A card inside a grid or stack is rendered by that container on the SERVER, so
 * the editor never has a sortable element for it. Drag could therefore only ever
 * reorder the top level, and a card placed inside a group had no way to be
 * moved, reordered or taken back out — the only route to it was the raw JSON.
 *
 * These operate on the CONFIG rather than on rendered nodes, so one
 * implementation covers any depth and there is still exactly one grid renderer.
 *
 * EVERY WALK THE EDITOR PERFORMS lives here, and that is the point of the module
 * rather than a filing preference. Find, map, filter, reorder and lift were
 * spread across the provider and the editor root — both client components that
 * import server actions, and therefore both unimportable by the test process. So
 * the walks the editor actually runs when you configure or delete a card were
 * the ones no test could execute, and a walk that silently fails to descend is
 * precisely the bug worth executing rather than matching source text for.
 * Gathered here, with no React and no imports beyond the config types, every one
 * of them is reachable from a test.
 *
 * The parser keeps its own `walkCards` in config.ts, deliberately: that one is
 * about reading untrusted JSON and belongs beside the schema that bounds it.
 */

/**
 * The two card types that hold other cards, as a type guard.
 *
 * `isContainer` in config.ts answers the same question about a card TYPE, which
 * is the right shape for the schema and the wrong one here: it returns a plain
 * boolean, so it cannot narrow `card` and every caller would still have to
 * re-test `card.type` to reach `card.cards`. Narrowing in one place is what stops
 * the next walk from being written against a hand-repeated pair of string
 * comparisons that quietly omits `stack`.
 */
export function isContainerCard(card: CardConfig): card is GridCardConfig | StackCardConfig {
  return card.type === "grid" || card.type === "stack";
}

/**
 * The card with this id, from anywhere in the document.
 *
 * The settings dialog is handed a card ID, not a card, and this is what turns one
 * into the other — so a card the editor can offer a settings button for but that
 * this cannot find would open an empty dialog.
 */
export function findCardInTree(config: DashboardConfig, id: string): CardConfig | null {
  for (const view of config.views) {
    for (const section of view.sections) {
      const found = findCard(section.cards, id);
      if (found) return found;
    }
  }
  return null;
}

function findCard(cards: CardConfig[], id: string): CardConfig | null {
  for (const card of cards) {
    if (card.id === id) return card;
    if (isContainerCard(card)) {
      const found = findCard(card.cards, id);
      if (found) return found;
    }
  }
  return null;
}

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
    if (!isContainerCard(card)) return card;
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
    if (isContainerCard(card)) {
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

/* ── changing and removing, at any depth ──────────────────────────── */

/*
 * Cards nest, so every edit to a card has to reach into containers as well as
 * into sections. These are the only two places that recursion is written, which
 * is deliberate: a second hand-rolled walk that forgot to descend into `grid`
 * would make editing a card inside a container silently do nothing — the dialog
 * would close, the change would be gone, and nothing would report an error.
 */

function mapCardTree(cards: CardConfig[], change: (card: CardConfig) => CardConfig): CardConfig[] {
  return cards.map((card) => {
    const mapped = change(card);
    if (isContainerCard(mapped)) {
      return { ...mapped, cards: mapCardTree(mapped.cards, change) };
    }
    return mapped;
  });
}

function filterCardTree(cards: CardConfig[], keep: (card: CardConfig) => boolean): CardConfig[] {
  return cards.filter(keep).map((card) => {
    if (isContainerCard(card)) {
      return { ...card, cards: filterCardTree(card.cards, keep) };
    }
    return card;
  });
}

export function mapCards(
  config: DashboardConfig,
  change: (card: CardConfig) => CardConfig,
): DashboardConfig {
  return {
    ...config,
    views: config.views.map((view) => ({
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        cards: mapCardTree(section.cards, change),
      })),
    })),
  };
}

export function filterCards(
  config: DashboardConfig,
  keep: (card: CardConfig) => boolean,
): DashboardConfig {
  return {
    ...config,
    views: config.views.map((view) => ({
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        cards: filterCardTree(section.cards, keep),
      })),
    })),
  };
}

