import { TriangleAlert } from "lucide-react";
import { SectionCard } from "@/components/dashboard/sections";
import type { ConditionContext } from "@/lib/dashboard/conditions";

/**
 * The parts every user-built card renderer shares: the panel it sits in, the
 * failure state it degrades to, and the class lookups the containers place it
 * with.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM index.tsx. The container renderer has to
 * recurse through the dispatcher, and the dispatcher has to reach the container
 * renderer. Putting the shared TYPES in the dispatcher would make that a genuine
 * import cycle; putting them here makes both sides depend on a leaf. The
 * recursion itself is passed as an argument rather than imported — see
 * ./container.tsx.
 */

/**
 * A rendered card: what to draw, plus the SIGNALS its visibility condition is
 * evaluated against.
 *
 * Identical in shape to `LoadedCard` in lib/dashboard/cards.tsx, deliberately —
 * a builtin card and a user-built card are the same thing to whoever is placing
 * them, and a second shape would mean the page had two ways to ask "did this
 * card have anything in it?".
 *
 * ── THE SIGNAL VOCABULARY ───────────────────────────────────────────────────
 *
 * Signals are what a visibility condition is written against, which makes them a
 * language rather than a debug dump. A name that means one thing on a list card
 * and another on a chart is the worst kind of bug this file can have: the
 * condition still evaluates, the card still renders, and it is simply wrong on
 * one card type in a way nobody notices until they trust it.
 *
 * So there are exactly four names and each has one meaning everywhere:
 *
 *   count   Rows the query MATCHED, before any display limit. Published by every
 *           query card, always. This is what "hide this when it is empty" means,
 *           and it is why a stat card that sums money runs a second COUNT: a sum
 *           of zero and no rows at all are the same number and different
 *           situations.
 *   total   The AGGREGATE the card computed — the sum, average, minimum or
 *           maximum it exists to show. Stat, gauge and chart, because those are
 *           the cards that compute one.
 *   shown   Rows actually RENDERED, after the row limit. List only.
 *   groups  Slices actually rendered. Chart only.
 *
 * Plus one name that belongs to the containers alone: `children`, how many cards
 * inside a grid or a stack survived their own conditions. It is not `count`
 * precisely because a container runs no query — see ./container.tsx.
 *
 * A LIST CARD PUBLISHES NO `total`, deliberately. It computes no aggregate;
 * there is nothing for the word to mean. Publishing the matched-row count under
 * that name — which this module did until the vocabulary was settled — makes
 * `total` mean "how many" on one card and "how much" on the next, so a condition
 * reading `total greater than 1000` is a row count on a list and rands on a
 * stat. `count` already carries how many, on every card, including this one.
 */
export type RenderedCard = { node: React.ReactNode; signals: Record<string, unknown> };

/**
 * Everything a renderer needs that is not on the card itself.
 *
 * `conditions` is REQUIRED rather than optional, and that is worth defending: a
 * container is the only thing that can apply its children's visibility rules —
 * nobody above it ever sees them — so a context without the answers would leave
 * a nested card's conditions silently unevaluated. An optional field would make
 * that failure quiet, and a quiet failure here means a card someone hid for a
 * role appearing for that role.
 */
export type RenderContext = {
  /** What a visibility condition can ask about, minus each card's own signals. */
  conditions: Omit<ConditionContext, "signals">;
  /**
   * User id → display name, for the `user` field type.
   *
   * A map rather than a lookup function because a card renders inside a request
   * that has already resolved its people, and because the alternative — a
   * renderer that queries per row — is the N+1 that makes a twelve-row list card
   * twelve round trips. An id with no entry renders as an em dash: see
   * ./values.tsx for why a raw id is never printed.
   */
  userNames?: ReadonlyMap<string, string>;
  /** Container nesting depth. Callers leave this alone; ./container.tsx sets it. */
  depth?: number;
};

/** A card that renders nothing at all — disabled, or hidden, or too deep. */
export const NOTHING: RenderedCard = { node: null, signals: {} };

/**
 * The panel a card sits in.
 *
 * Titled cards go through `SectionCard`, the same component the twelve builtin
 * cards use, so a user-built card is visually indistinguishable from a
 * code-defined one — which is the point of letting people build them. The
 * untitled branch repeats SectionCard's panel classes rather than passing an
 * empty title, because an empty title still renders the header row and leaves a
 * blank strip of padding above every untitled card on the screen.
 */
export function CardShell({
  title,
  action,
  children,
}: {
  title?: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  if (title) {
    return (
      <SectionCard title={title} action={action}>
        {children}
      </SectionCard>
    );
  }
  /*
   * Panel classes copied from SectionCard, `h-full` included, so the two are
   * pixel-identical.
   *
   * `h-full` is NOT what makes a card with `rows: 2` tall — believing it was is
   * the bug this file was part of. `height: 100%` needs a containing block with a
   * definite height, and a placement box carrying only `min-height` has
   * `height: auto`, so it resolved to `auto` and the panel stayed short inside a
   * tall empty box. The minimum is handed to the panel directly now; see
   * CARD_MIN_HEIGHT in ./placement.ts. This stays for the layouts where the cell
   * IS definite and stretching is wanted.
   */
  return (
    <div className="flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
      {children}
    </div>
  );
}

/**
 * Verbatim from lib/dashboard/cards.tsx, where it is module-private.
 *
 * Copied rather than imported because that file exports only the card map, and
 * the empty states of the twelve builtin cards and of a user-built list card
 * must look the same — an empty "Leads with no next step" and an empty card
 * someone built themselves are the same sentence to the person reading them.
 */
export const EmptyLine = ({ children }: { children: React.ReactNode }) => (
  <p className="py-2 text-xs text-muted-foreground/70">{children}</p>
);

/**
 * The one state this whole module exists to guarantee.
 *
 * A user-built card runs a query assembled from a saved config against a
 * database that has moved on since it was saved. It WILL fail eventually — a
 * source turned off with a module pack, a permission revoked mid-render, a
 * timeout. The home screen is the page a user cannot route around, so one bad
 * card must cost exactly one card.
 *
 * The message says nothing about WHY. A failure message here would be assembled
 * from an exception thrown by the query compiler, and those carry field names,
 * table names and occasionally values — a card that fails on a row it should
 * never have seen must not describe that row while failing.
 */
export function CouldNotLoad({ title }: { title?: string }) {
  return (
    <CardShell title={title}>
      <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground/70">
        <TriangleAlert className="size-3.5 shrink-0 text-amber-400/80" />
        This card could not be loaded.
      </p>
    </CardShell>
  );
}

/* ── placement ────────────────────────────────────────────────────── */

/*
 * The span, height and column tables live in ./placement.ts.
 *
 * They are pure strings with no React in them, and they were moved out so a test
 * can IMPORT them: this file reaches `server-only` through SectionCard, so
 * anything importing it outside Next throws. A test that cannot import a class
 * name can only grep for it, and grepping is what let two broken versions of the
 * card-height mechanism ship green. See the note at the top of ./placement.ts.
 */
