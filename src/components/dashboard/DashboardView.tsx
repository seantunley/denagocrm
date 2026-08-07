import { conditionsMet, isServerDecidable, type ConditionContext } from "@/lib/dashboard/conditions";
import type { CardConfig, DashboardConfig, SectionConfig, ViewConfig } from "@/lib/dashboard/config";
import { renderCard, type RenderContext } from "./cards";

/**
 * Turning a stored view into rendered cards.
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
 *
 * ── WHY THIS RETURNS A MAP RATHER THAN MARKUP ───────────────────────────────
 *
 * Cards are server components; the LAYOUT has to be a client one, because
 * arranging is a drag. Handing the layout a map of finished nodes keyed by card
 * id is what lets both modes share one grid: the client places nodes it cannot
 * render and never learns anything about a card it was not given. A card absent
 * from the map is absent for a reason the client does not need to know — refused
 * by permission, hidden by a rule, or empty — and in edit mode it draws a
 * placeholder rather than a hole.
 */

export type ViewerContext = Omit<ConditionContext, "signals">;

/** Server-rendered card nodes, by card id. */
export type CardSlots = Record<string, React.ReactNode>;

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

/** Does this thing's rule admit it, without looking at any card's data? */
function admittedUpFront(visibility: CardConfig["visibility"], ctx: ViewerContext): boolean {
  return !isServerDecidable(visibility) || conditionsMet(visibility, { ...ctx, signals: {} });
}

/**
 * Render every card of one view that this viewer is entitled to and whose rules
 * admit it.
 *
 * Sections load in parallel and so do the cards within them, so a view with
 * twenty cards costs the depth of its slowest query rather than the sum of all
 * twenty.
 */
export async function renderViewSlots(view: ViewConfig, ctx: ViewerContext): Promise<CardSlots> {
  const render: RenderContext = { conditions: ctx };
  const slots: CardSlots = {};

  await Promise.all(
    view.sections.map(async (section) => {
      // Step 1, at section level. Refused here and none of its cards is loaded.
      if (!admittedUpFront(section.visibility, ctx)) return;
      await Promise.all(section.cards.map((card) => fill(card, section, ctx, render, slots)));
    }),
  );

  return slots;
}

async function fill(
  card: CardConfig,
  _section: SectionConfig,
  ctx: ViewerContext,
  render: RenderContext,
  slots: CardSlots,
): Promise<void> {
  if (card.disabled) return;
  // Step 1 for the card. Refused here, `renderCard` is never called, so the
  // query the card would have issued never happens.
  if (!admittedUpFront(card.visibility, ctx)) return;

  /*
   * One card must never take down the home screen.
   *
   * The renderers already turn a failed QUERY into an inline notice, so reaching
   * this catch means something worse — a bug in a renderer, a config shape that
   * got past the parser. Either way the answer is the same and it is not an
   * error page: drop the card, keep the dashboard. This is the screen a user
   * cannot route around.
   */
  let result;
  try {
    result = await renderCard(card, render);
  } catch {
    return;
  }
  if (!result.node) return;
  // Step 3 — the conditions that needed the card's own data.
  if (!conditionsMet(card.visibility, { ...ctx, signals: result.signals })) return;
  slots[card.id] = result.node;
}
