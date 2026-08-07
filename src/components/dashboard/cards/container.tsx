import { cn } from "@/lib/utils";
import { MAX_CARD_DEPTH, type CardConfig, type GridCardConfig, type StackCardConfig } from "@/lib/dashboard/config";
import { conditionsMet, isServerDecidable } from "@/lib/dashboard/conditions";
import {
  GRID_COLUMNS_CLASS,
  SPAN_IN_GRID,
  STACK_GROW,
  type RenderContext,
  type RenderedCard,
} from "./shell";

/**
 * The two container cards — a grid and a stack.
 *
 * ── THE RECURSION IS PASSED IN, NOT IMPORTED ────────────────────────────────
 *
 * A container renders whatever cards it holds, which means it needs the
 * dispatcher, which needs the containers. Importing ./index here would close
 * that loop. Module cycles between function declarations happen to work under
 * both bundlers this app uses, which is precisely why they are worth avoiding —
 * the failure, when the shape changes, is an `undefined is not a function` at
 * render time on the home page rather than an error at build time. Taking the
 * dispatcher as an argument makes the dependency one-directional and visible.
 *
 * ── WHY VISIBILITY IS APPLIED HERE AND NOWHERE ELSE ─────────────────────────
 *
 * `renderCard` does not evaluate a card's OWN conditions — the caller placing
 * the card does that, against the signals it returns. That works at the top
 * level, where the page can see both. It cannot work for a nested card: nobody
 * above the container ever sees the children, so if the container does not apply
 * their conditions, nothing does, and a card someone hid for a role would
 * quietly appear for that role.
 *
 * The order below mirrors the page's, and the order is the point:
 *
 *   1. Conditions that can be settled WITHOUT the card's data — role, user,
 *      permission, module, time — are settled first, and a child they hide is
 *      never rendered, so its query never runs.
 *   2. The survivors load in parallel.
 *   3. Data conditions are applied afterwards, against the signals each child
 *      published. That is the honest cost of "hide when empty": the query has
 *      already happened by the time the answer exists.
 *
 * None of this is access control. The source's own permission and module gates
 * run in the compiler, before any of it, and a user who strips every condition
 * out of their own config does not thereby see one extra row.
 *
 * ── A CONTAINER PUBLISHES `children`, NEVER `count` ─────────────────────────
 *
 * `count` means rows the query matched — see the vocabulary in ./shell.tsx — and
 * a container runs no query, so it has no count to report. It reports how many
 * of its children survived their own conditions, under a name that can only mean
 * that.
 *
 * This card published that number as `count` until the vocabulary was settled,
 * which is worth recording because it is the subtlest instance of the bug: "hide
 * this when it is empty" is a sentence someone writes once and then copies onto
 * every card they build, and on a grid it silently asked a question about the
 * grid's own contents rather than about any data at all. The condition still
 * evaluated. It was simply about something else.
 *
 * `children: 0` is still published when the container renders nothing, rather
 * than an empty bag, so "hide the section heading when the grid under it came up
 * empty" is expressible without the condition having to distinguish a zero from
 * an absent signal.
 */
type Render = (card: CardConfig, ctx: RenderContext) => Promise<RenderedCard>;

async function renderChildren(
  cards: readonly CardConfig[],
  ctx: RenderContext,
  render: Render,
): Promise<{ card: CardConfig; node: React.ReactNode }[]> {
  const childCtx: RenderContext = { ...ctx, depth: (ctx.depth ?? 0) + 1 };

  const admitted = cards.filter(
    (child) =>
      !isServerDecidable(child.visibility) ||
      conditionsMet(child.visibility, { ...ctx.conditions, signals: {} }),
  );

  const rendered = await Promise.all(
    admitted.map(async (child) => ({ child, ...(await render(child, childCtx)) })),
  );

  return rendered
    .filter(
      ({ child, node, signals }) =>
        node !== null && conditionsMet(child.visibility, { ...ctx.conditions, signals }),
    )
    .map(({ child, node }) => ({ card: child, node }));
}

/**
 * Depth is checked here as well as in the parser.
 *
 * `parseCard` refuses a config nested past MAX_CARD_DEPTH, so this is
 * unreachable through the normal path. It is here because the parser's cap
 * belongs to the config as it was READ, and this recursion is what actually
 * walks it — a future caller assembling a config in memory, or a default layout
 * built in code, never passes through the parser at all. The cost of being wrong
 * is a stack overflow on the home page.
 */
function tooDeep(ctx: RenderContext): boolean {
  return (ctx.depth ?? 0) >= MAX_CARD_DEPTH;
}

export async function renderGrid(
  card: GridCardConfig,
  ctx: RenderContext,
  render: Render,
): Promise<RenderedCard> {
  if (tooDeep(ctx)) return { node: null, signals: { children: 0 } };
  const children = await renderChildren(card.cards, ctx, render);
  if (children.length === 0) return { node: null, signals: { children: 0 } };

  const spans = SPAN_IN_GRID[card.columns];

  return {
    node: (
      <div className="min-w-0 space-y-2">
        {card.title && (
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {card.title}
          </p>
        )}
        <div className={cn("grid items-start gap-3", GRID_COLUMNS_CLASS[card.columns])}>
          {children.map(({ card: child, node }) => (
            <div key={child.id} className={cn("min-w-0", spans[child.span])}>
              {node}
            </div>
          ))}
        </div>
      </div>
    ),
    signals: { children: children.length },
  };
}

export async function renderStack(
  card: StackCardConfig,
  ctx: RenderContext,
  render: Render,
): Promise<RenderedCard> {
  if (tooDeep(ctx)) return { node: null, signals: { children: 0 } };
  const children = await renderChildren(card.cards, ctx, render);
  if (children.length === 0) return { node: null, signals: { children: 0 } };

  const horizontal = card.direction === "horizontal";

  return {
    node: (
      <div className="min-w-0 space-y-2">
        {card.title && (
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {card.title}
          </p>
        )}
        {/*
          A horizontal stack WRAPS, and collapses to a column on a phone. There
          is no width at which four cards side by side on a 380px screen is
          anything other than four slivers, and a stack that scrolled sideways
          would hide its own contents on the one device most dashboards are
          glanced at from.
        */}
        <div
          className={cn(
            "flex min-w-0 gap-3",
            horizontal ? "flex-col items-stretch sm:flex-row sm:flex-wrap" : "flex-col",
          )}
        >
          {children.map(({ card: child, node }) => (
            <div
              key={child.id}
              // Span means "share of the row" in a horizontal stack — there is no
              // column grid here to span. Vertically it means nothing at all, so
              // it is not applied: a card cannot be two rows tall.
              className={cn(
                "min-w-0",
                horizontal && "basis-0",
                horizontal && STACK_GROW[child.span],
              )}
            >
              {node}
            </div>
          ))}
        </div>
      </div>
    ),
    signals: { children: children.length },
  };
}
