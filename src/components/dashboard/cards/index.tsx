import "server-only";
import { MAX_CARD_DEPTH, type CardConfig } from "@/lib/dashboard/config";
import { CouldNotLoad, NOTHING, type RenderContext, type RenderedCard } from "./shell";
import { renderBuiltin } from "./builtin";
import { renderStat } from "./stat";
import { renderList } from "./list";
import { renderChart } from "./chart";
import { renderGauge } from "./gauge";
import { renderMarkdown } from "./markdown";
import { renderHeading } from "./heading";
import { renderButton } from "./button";
import { renderGrid, renderStack } from "./container";

/**
 * The card renderer — one function, ten card types, and one guarantee.
 *
 * ── THE GUARANTEE ───────────────────────────────────────────────────────────
 *
 * ONE BAD CARD COSTS EXACTLY ONE CARD. Everything else in this module is
 * arrangeable; this is not. The home screen is the only page a user cannot route
 * around, and a user-built card is a query assembled from a config that was
 * saved under an older release, against a source that may since have been turned
 * off with its module pack, holding a filter on a field someone has had their
 * permission for revoked. It will fail. When it does, the card says "could not
 * be loaded" in its own box and the other thirty-nine render.
 *
 * That is why every path out of this function returns, and none of them throws.
 * A thrown error here would reach the nearest error boundary, which is the page,
 * which means one malformed filter takes down everybody's dashboard until
 * someone works out whose config it was.
 *
 * The failure state deliberately carries NO detail — see `CouldNotLoad`.
 *
 * ── WHAT THIS FUNCTION DOES NOT DO ──────────────────────────────────────────
 *
 * It does not apply the card's own visibility conditions. The caller placing the
 * card does that, against the `signals` returned here, because the caller is
 * what owns the arrangement — the same split the builtin dashboard already uses
 * in app/(app)/page.tsx, where step 3 loads and step 4 filters.
 *
 * The one exception is a container's CHILDREN, whose conditions nothing above
 * the container can see. ./container.tsx applies those, and says why.
 *
 * It also does not do access control. Which sources a viewer may query and which
 * rows come back are decided in the compiler, before any of this. A condition is
 * a preference about what to show; a permission is a fact about what exists.
 */

export type { RenderedCard, RenderContext } from "./shell";

export async function renderCard(card: CardConfig, ctx: RenderContext): Promise<RenderedCard> {
  /*
   * A disabled card is the editor's alternative to deleting one while trying
   * something out. It renders nothing AND queries nothing — a card someone
   * switched off must not still be costing a round trip on every page load,
   * which is the shape this mistake usually takes.
   */
  if (card.disabled) return NOTHING;

  // Depth is capped by the parser and again in ./container.tsx; this is the
  // outermost of the three, covering a config assembled in code rather than read
  // from a row.
  if ((ctx.depth ?? 0) > MAX_CARD_DEPTH) return NOTHING;

  try {
    switch (card.type) {
      case "builtin":
        return await renderBuiltin(card, ctx);
      case "stat":
        return await renderStat(card, ctx);
      case "list":
        return await renderList(card, ctx);
      case "chart":
        return await renderChart(card, ctx);
      case "gauge":
        return await renderGauge(card, ctx);
      case "markdown":
        return renderMarkdown(card, ctx);
      case "heading":
        return renderHeading(card, ctx);
      case "button":
        return renderButton(card, ctx);
      case "grid":
        return await renderGrid(card, ctx, renderCard);
      case "stack":
        return await renderStack(card, ctx, renderCard);
      default:
        // A card type from a newer release, sitting in a config an older build
        // is reading. Nothing to draw and nothing worth saying — the parser's
        // `dropped` list is where the user is told, once, at the top of the page.
        return NOTHING;
    }
  } catch {
    /*
     * The error is swallowed on purpose and not re-thrown, not logged with the
     * config, and not shown. It was raised by a query compiled from user input
     * and its message can carry field names, table names and occasionally the
     * value that broke it — a card that failed on a row the viewer should never
     * have seen must not describe that row on its way out.
     *
     * The signals published are `{ error: true }` and nothing else. Notably NOT
     * `count: 0`: a card that failed does not have a count, and inventing one
     * would let a "hide when empty" condition decide the card is fine. A
     * condition reading `count` simply does not match, which is the same outcome
     * an empty card gets, and `error` is there for whoever wants to tell the two
     * apart.
     */
    return { node: <CouldNotLoad title={card.title} />, signals: { error: true } };
  }
}
