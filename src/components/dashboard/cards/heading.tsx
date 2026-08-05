import type { HeadingCard } from "@/lib/dashboard/config";
import type { RenderContext, RenderedCard } from "./shell";

/**
 * A title and a rule. No panel, no data, no query.
 *
 * The absence of a card panel is the whole point: a heading that sat in a
 * bordered box would be another card in the row rather than a break between
 * rows, and someone reaching for one is reaching for a divider. It defaults to
 * spanning the full width in the schema for the same reason.
 *
 * An untitled heading still draws its rule — a plain separator is a legitimate
 * thing to want, and dropping the card because its title happens to be empty
 * would make it look broken in the editor.
 */
export function renderHeading(card: HeadingCard, _ctx: RenderContext): RenderedCard {
  return {
    node: (
      <div className="min-w-0 pt-1">
        {card.title && (
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {card.title}
          </p>
        )}
        <div className="mt-1.5 h-px w-full bg-border" />
      </div>
    ),
    signals: {},
  };
}
