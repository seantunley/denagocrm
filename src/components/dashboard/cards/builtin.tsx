import { DASHBOARD_CARD_IMPLS } from "@/lib/dashboard/cards";
import { canSeeCard, cardById } from "@/lib/dashboard/registry";
import type { BuiltinCard } from "@/lib/dashboard/config";
import { NOTHING, type RenderContext, type RenderedCard } from "./shell";

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
export async function renderBuiltin(card: BuiltinCard, ctx: RenderContext): Promise<RenderedCard> {
  const impl = DASHBOARD_CARD_IMPLS[card.card];
  // The union makes this unreachable at compile time. It is checked anyway
  // because a config outlives the build that wrote it: a card id retired in a
  // later release is still sitting in someone's saved layout, and the parser
  // that would have dropped it only knows the ids THIS build declares.
  if (!impl) return NOTHING;

  /*
   * THE PERMISSION AND MODULE GATE. Do not remove this believing the loaders
   * cover it — they do not, and the gap is not visible from inside them.
   *
   * When the home screen was a fixed list, `visibleCards(layout, access)` ran
   * over the whole layout before anything loaded, and that single call was what
   * kept "Out for signature" away from someone without `signing.view` and the
   * workshop cards away from a tenant with the automotive pack switched off.
   * Making the layout configurable moved the card list out of that function's
   * reach: a config can now NAME any builtin id directly, and without this check
   * naming it is enough to load it.
   *
   * The loaders in lib/dashboard/cards.tsx do re-check permissions strand by
   * strand, which is why this is a hardening rather than a hole in every card —
   * but it is a hole in some. MODULE state is not checked by any loader at all,
   * because it never had to be: a pack being off used to mean the card was never
   * in the list. And a config is not a trusted input. It is JSON the user can
   * write directly through the raw editor, it outlives the build that wrote it,
   * and it survives a permission being revoked — which is exactly the sequence
   * this guards: hold a permission, add the card, lose the permission, keep
   * seeing it.
   *
   * `canSeeCard` is the SAME function the old page and the add-card picker use,
   * deliberately, so the three cannot drift into disagreeing about who may see
   * what.
   */
  const meta = cardById(card.card);
  if (!meta) return NOTHING;
  if (
    !canSeeCard(meta, {
      permissions: ctx.conditions.permissions,
      modules: ctx.conditions.modules,
    })
  ) {
    return NOTHING;
  }

  const { node, signals } = await impl.load();
  return { node, signals };
}
