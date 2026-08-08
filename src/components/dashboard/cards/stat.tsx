import Link from "next/link";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { normaliseHref, type StatCard } from "@/lib/dashboard/config";
import { sourceById, type PeriodId } from "@/lib/dashboard/sources";
import { pctDelta } from "@/lib/dashboard/data";
import { runMetricQuery, scopeContext } from "@/lib/dashboard/compile";
import { formatMetric, isMoneyField, metricField } from "./values";
import type { RenderContext, RenderedCard } from "./shell";

/**
 * One big number, and what it was last time.
 *
 * ── WHY THIS IS NOT StatSparkCard ───────────────────────────────────────────
 *
 * The obvious move is to reuse the tile the builtin "Sales stats" card already
 * uses. It does not fit, on four counts, and forcing it would have cost more
 * than it saved:
 *
 *   1. `SparkStat.href` is required and the tile IS a `<Link>`. A stat card's
 *      href is optional, and wiring "#" into a link so the markup typechecks
 *      produces a tile that looks clickable and goes nowhere.
 *   2. It draws a sparkline from a daily series. `runMetricQuery` returns one
 *      scalar; there is no series to draw and no query in the compiler that
 *      would produce one. An empty spark renders an empty chart area.
 *   3. Its delta tooltip says "vs the same days last month" in fixed text. That
 *      is true of the builtin tile and not of a card someone pointed at a
 *      different period.
 *   4. It is a client component with a count-up animation and a cursor-tracking
 *      3D tilt — a bundle and a hydration boundary bought for a card with no
 *      interaction in it.
 *
 * So the tile below is server-rendered and copies the builtin's visual language
 * class for class: same border, same radius, same 11px uppercase label, same
 * emerald/red delta pair. Side by side on the same screen they read as one
 * family, which is the part that actually mattered.
 *
 * ── WHY "compare" ONLY WORKS FOR SOME PERIODS ───────────────────────────────
 *
 * `CardQuery.period` is a closed list of RELATIVE windows, on purpose: a card
 * pinned to absolute dates is silently wrong a month later. The cost of that
 * closure is that "the preceding window of the same length" is only expressible
 * where the list happens to contain it, and it contains exactly one such pair.
 * Rather than invent a shifted-window parameter the compiler does not have, a
 * card whose period has no predecessor simply shows no delta — a missing
 * comparison is honest, whereas comparing this month against all time is a
 * number that means nothing and will still be believed.
 *
 * THE TABLE IS TOTAL, not partial, and that is the whole point of writing it out.
 * `Record<PeriodId, …>` means adding a window to PERIODS fails the build here
 * until someone decides what it compares against. A `Partial` would compile and
 * quietly stop drawing deltas for the new window, which is a bug that looks
 * exactly like a card nobody has configured yet.
 */
const PRECEDING_PERIOD: Record<PeriodId, PeriodId | null> = {
  // No window at all, so nothing to be the preceding one.
  all: null,
  // No "yesterday" in the list, and no honest substitute for it.
  today: null,
  // "The 7 days before the last 7" is not in the list either. `older_7d` is NOT
  // it — that reaches back to the beginning of time, so comparing against it
  // would be this week against all of history, growing every day.
  "7d": null,
  "30d": null,
  "90d": null,
  month: "last_month",
  // The month before last is not expressible, so last month has no predecessor.
  last_month: null,
  year: null,
  /*
   * The stale windows are OPEN-ENDED on the early side — "older than 30 days"
   * already runs back to the first row ever written. There is no earlier window
   * for one to be compared against, and the number it would produce (this
   * unbounded past against that unbounded past) is not a change over time. A
   * stale-work card answers "how much is rotting", which is a level, not a rate.
   */
  older_7d: null,
  older_30d: null,
  older_90d: null,
};

export async function renderStat(card: StatCard, _ctx: RenderContext): Promise<RenderedCard> {
  const source = sourceById(card.query.source);
  const asMoney = source
    ? isMoneyField(metricField(source, card.metric, await scopeContext(source)))
    : false;
  // `?? null` covers a period id retired since this config was saved: an unknown
  // window gets no delta rather than an undefined lookup used as a period.
  const previousPeriod = card.compare
    ? (PRECEDING_PERIOD[card.query.period as PeriodId] ?? null)
    : null;

  /*
   * The count runs alongside the metric whenever the metric is not itself a
   * count. It buys the one thing a condition cannot otherwise ask: a sum of zero
   * and no rows at all are the same number and different situations, and "hide
   * this card when it is empty" means the second one. One extra COUNT against a
   * where-clause the database has just planned is the cheapest query on the page.
   */
  const [value, previous, count] = await Promise.all([
    runMetricQuery(card.query, card.metric),
    previousPeriod
      ? runMetricQuery({ ...card.query, period: previousPeriod }, card.metric)
      : Promise.resolve(null),
    card.metric.fn === "count"
      ? Promise.resolve(null)
      : runMetricQuery(card.query, { fn: "count" }),
  ]);

  const delta = previous === null ? null : pctDelta(value, previous);
  const href = card.href ? normaliseHref(card.href) : null;

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {card.title ?? source?.label ?? "Total"}
        </p>
        {href && (
          <ArrowRight className="size-3.5 shrink-0 text-primary/70 transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <p className="truncate text-2xl font-semibold tabular-nums text-foreground">
          {formatMetric(value, asMoney)}
        </p>
        {delta !== null && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 text-xs font-medium tabular-nums",
              delta >= 0 ? "text-emerald-400" : "text-red-400",
            )}
          >
            {delta >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {Math.abs(delta)}%
          </span>
        )}
      </div>
      {previousPeriod && (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {delta === null ? "No comparison available" : "vs the previous period"}
        </p>
      )}
    </>
  );

  const panel = "group block min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm";

  return {
    node: href ? (
      <Link href={href} className={cn(panel, "transition-colors hover:border-primary/40")}>
        {body}
      </Link>
    ) : (
      <div className={panel}>{body}</div>
    ),
    // `count` is rows matched, `total` is the aggregate — the vocabulary in
    // ./shell.tsx. They are the same number when the metric IS a count, and that
    // is a coincidence of that one metric rather than the two names agreeing.
    signals: { count: count ?? value, total: value },
  };
}
