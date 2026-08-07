import { conditionsMet, isServerDecidable, type ConditionContext } from "@/lib/dashboard/conditions";
import type { DashboardConfig, SectionConfig, ViewConfig } from "@/lib/dashboard/config";
import { renderCard, type RenderContext } from "./cards";
import { cn } from "@/lib/utils";

/**
 * One view of a dashboard, server-rendered.
 *
 * ── THE ORDER OF OPERATIONS IS THE SECURITY MODEL ───────────────────────────
 *
 * This is the same ordering the fixed home page documented and it survives
 * unchanged, because the reason for it did not go away when the layout became
 * configurable:
 *
 *   1. Evaluate every SERVER-DECIDABLE condition first — who is asking, what
 *      they hold, what time it is. A view, section or card refused here is never
 *      loaded, so its query never runs and its contents never reach the browser.
 *   2. Load and render what survived.
 *   3. Apply the remaining conditions — the ones that had to see the card's own
 *      data — against the signals it published.
 *
 * Step 3 can only ever hide MORE. A condition that decided whether a query ran
 * would make the query itself the disclosure, which is why the split in
 * `isServerDecidable` exists rather than one undifferentiated evaluation pass.
 *
 * None of this is the access control. The compiler scopes every row to what the
 * viewer could already open on its own page, so a user who deletes every
 * condition from their own config sees exactly the same rows — just more of the
 * cards that hold them.
 */

/** The grid's column count, as STATIC classes — see the note in shell.tsx. */
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

export type ViewerContext = Omit<ConditionContext, "signals">;

/**
 * Which views this viewer may see.
 *
 * Exported because the TAB STRIP needs the same answer the renderer will reach,
 * and computing it twice is how a tab comes to exist that leads nowhere — or
 * worse, how a tab someone hid stays in the strip advertising its title. One
 * function, two call sites, so they cannot drift. Same discipline as
 * `visibleCards` in registry.ts.
 *
 * Only server-decidable conditions apply here: a tab cannot be hidden by its
 * cards' data, because deciding that would mean loading every card of every tab
 * on every render just to know which tabs to draw.
 */
export function visibleViews(config: DashboardConfig, ctx: ViewerContext): ViewConfig[] {
  return config.views.filter(
    (view) => !isServerDecidable(view.visibility) || conditionsMet(view.visibility, { ...ctx, signals: {} }),
  );
}

export default async function DashboardView({
  view,
  ctx,
}: {
  view: ViewConfig;
  ctx: ViewerContext;
}) {
  const render: RenderContext = { conditions: ctx };

  // Step 1 and 2, per section. Sections are independent, so they load in
  // parallel — a view with four sections costs the depth of its slowest, not
  // the sum of all four.
  const sections = await Promise.all(
    view.sections.map(async (section) => ({
      section,
      cards: (await renderSection(section, ctx, render)) ?? [],
    })),
  );

  // A section whose every card is hidden leaves no empty box behind. A section
  // with a TITLE and no cards is dropped too: a heading over nothing reads as a
  // loading failure rather than as an empty state, and the one thing a user must
  // not conclude from a quiet dashboard is that it is broken.
  const populated = sections.filter(({ cards }) => cards.length > 0);

  if (populated.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border py-12 text-center">
        <p className="text-sm font-medium text-foreground">Nothing needs you right now.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Cards appear here when there is something to show.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("grid items-start gap-4", VIEW_COLUMNS[view.columns])}>
      {populated.map(({ section, cards }) => (
        <section key={section.id} className={cn("min-w-0 space-y-3", SECTION_SPAN[section.columnSpan])}>
          {section.title && (
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h2>
          )}
          <div className={cn("grid items-start gap-4", VIEW_COLUMNS[section.columnSpan])}>
            {cards.map(({ id, node }) => (
              <div key={id} className="min-w-0">
                {node}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * One section's cards, or null when the section itself is refused.
 *
 * Returns null rather than an empty array for a refused section so the caller
 * cannot confuse "you may not see this" with "there was nothing in it" — they
 * look identical on screen and are entirely different facts.
 */
async function renderSection(
  section: SectionConfig,
  ctx: ViewerContext,
  render: RenderContext,
): Promise<{ id: string; node: React.ReactNode }[] | null> {
  if (isServerDecidable(section.visibility) && !conditionsMet(section.visibility, { ...ctx, signals: {} })) {
    return null;
  }

  const rendered = await Promise.all(
    section.cards.map(async (card): Promise<CardSlot | null> => {
      if (card.disabled) return null;
      // Step 1 for the card. A card refused here is never passed to renderCard,
      // so its query is never issued.
      if (isServerDecidable(card.visibility) && !conditionsMet(card.visibility, { ...ctx, signals: {} })) {
        return null;
      }
      /*
       * One card must never take down the home screen.
       *
       * The renderers already turn a failed QUERY into an inline notice, so
       * reaching this catch means something worse — a bug in a renderer, a
       * malformed config that got past the parser. Either way the answer is the
       * same and it is not an error page: drop the card, keep the dashboard.
       * This is the screen a user cannot route around.
       */
      let result;
      try {
        result = await renderCard(card, render);
      } catch {
        return null;
      }
      if (!result.node) return null;
      // Step 3 — the conditions that needed the card's own data.
      if (!conditionsMet(card.visibility, { ...ctx, signals: result.signals })) return null;
      return { id: card.id, node: result.node };
    }),
  );

  return rendered.filter((entry): entry is CardSlot => entry !== null);
}

/** A card that survived every gate, ready to place in the grid. */
type CardSlot = { id: string; node: React.ReactNode };
