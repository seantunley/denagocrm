import { DASHBOARD_CARD_IMPLS } from "@/lib/dashboard/cards";
import type { BuiltinCard } from "@/lib/dashboard/config";
import type { RenderContext, RenderedCard } from "./shell";

/**
 * A code-defined card, placed by a user-defined config.
 *
 * This is a pass-through and must stay one. The twelve builtin cards keep their
 * own loaders, their own strand-by-strand permission checks and their own
 * chrome — a user-built dashboard is a reason to be able to put "Pipeline
 * snapshot" next to something of your own, never a reason to lose it or to get a
 * subtly different version of it.
 *
 * So: no shell wrapped around it, and `card.title` is IGNORED. Every builtin
 * draws its own SectionCard with its own heading and its own "Board" / "Targets"
 * action link; putting a second title above that would give the card two, and
 * letting a config rename "System alerts" to something friendlier is how an
 * alert stops reading as an alert.
 *
 * The signals come straight from the loader, so a builtin's own condition
 * vocabulary (`count`, as published in lib/dashboard/cards.tsx) works unchanged
 * when the card is placed by a config instead of by the default layout.
 */
export async function renderBuiltin(
  card: BuiltinCard,
  _ctx: RenderContext,
): Promise<RenderedCard> {
  const impl = DASHBOARD_CARD_IMPLS[card.card];
  // The union makes this unreachable at compile time. It is checked anyway
  // because a config outlives the build that wrote it: a card id retired in a
  // later release is still sitting in someone's saved layout, and the parser
  // that would have dropped it only knows the ids THIS build declares.
  if (!impl) return { node: null, signals: {} };

  const { node, signals } = await impl.load();
  return { node, signals };
}
