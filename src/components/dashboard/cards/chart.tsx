import { sourceById } from "@/lib/dashboard/sources";
import type { ChartCard } from "@/lib/dashboard/config";
import { runGroupedQuery, runMetricQuery, scopeContext } from "@/lib/dashboard/compile";
import { CardShell, EmptyLine, type RenderContext, type RenderedCard } from "./shell";
import { formatMetric, isMoneyField, metricField } from "./values";

/**
 * A chart card, drawn in CSS and SVG rather than by a charting library.
 *
 * ── THE LIBRARY QUESTION, ANSWERED HONESTLY ─────────────────────────────────
 *
 * recharts IS already a dependency and IS already used — the sparkline behind
 * the builtin stat tiles is a recharts AreaChart. It is not used here, for two
 * reasons rather than by oversight:
 *
 *   Every recharts component is a client component. Using it would put a
 *   hydration boundary and a chart runtime around a card that has no
 *   interaction in it, on the first screen every user loads, once per chart
 *   card on the page. The sparkline pays that cost because it lives inside a
 *   tile that is already client-side for its count-up and its cursor tilt.
 *
 *   Neither shape needs it. A horizontal bar is a div with a width, which is
 *   what CSS does natively and what recharts reimplements in an SVG it has to
 *   measure the container to size. A donut is one circle per slice with a
 *   dash offset — the same technique the target rings in
 *   components/dashboard/widgets.tsx already use, so the two read as one family.
 *
 * If a chart ever needs a tooltip, a brush or an axis, that is the moment to
 * reach for recharts and accept the boundary. None of that is on a dashboard
 * card that has to be legible in a glance from across a desk.
 */

/**
 * The palette, from globals.css. Cycled, not extended: five distinguishable
 * hues is what the theme defines, and a sixth invented here would be the one
 * colour that does not follow the theme when someone changes it.
 */
const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * How many groups get their own slice before the tail is folded together.
 *
 * A donut with eleven slices has six slices nobody can tell apart and a legend
 * taller than the card. Six plus "Other" keeps the shape readable and keeps the
 * total honest — the folded slice is still counted, it just stops claiming to be
 * a category.
 */
const MAX_SLICES = 6;

type Slice = { key: string; label: string; value: number; color: string };

function toSlices(groups: { key: string; label: string; value: number }[]): Slice[] {
  // Descending, because the question a grouped card answers is "which is
  // biggest" and an unsorted chart makes the reader do that sort by eye.
  const sorted = [...groups].filter((g) => g.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);
  const slices: Slice[] = head.map((g, i) => ({
    key: g.key,
    label: g.label,
    value: g.value,
    color: SLICE_COLORS[i % SLICE_COLORS.length],
  }));
  if (tail.length > 0) {
    slices.push({
      key: "__other",
      label: `Other (${tail.length})`,
      value: tail.reduce((sum, g) => sum + g.value, 0),
      color: "var(--muted-foreground)",
    });
  }
  return slices;
}

/* ── bars ─────────────────────────────────────────────────────────── */

function Bars({ slices, format }: { slices: Slice[]; format: (n: number) => string }) {
  // Scaled against the LARGEST bar, not against the total. A share-of-total bar
  // chart is a stacked bar wearing the wrong clothes: with eight even groups
  // every bar would be 12% wide and the card would look empty.
  const peak = Math.max(...slices.map((s) => s.value));
  return (
    <ul className="space-y-1.5">
      {slices.map((slice) => (
        <li key={slice.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{slice.label}</span>
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
              {format(slice.value)}
            </span>
          </div>
          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {/*
              An inline width, deliberately: this is a measured value rather than
              a design token, so there is no class for it to be and no stylesheet
              it could be scanned into. The colour is a theme variable for the
              same reason the rings use one.
            */}
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (slice.value / peak) * 100)}%`,
                background: slice.color,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ── donut ────────────────────────────────────────────────────────── */

const RADIUS = 32;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Donut({
  slices,
  total,
  format,
}: {
  slices: Slice[];
  total: number;
  format: (n: number) => string;
}) {
  /*
   * The arcs are laid out BEFORE the markup, not accumulated while mapping over
   * it. Each slice's dash offset is the sum of everything ahead of it, which is a
   * running total, and a running total mutated inside a render callback is the
   * one place React makes no promises about how many times it runs — so the walk
   * happens here, once, and the JSX below only reads.
   */
  const arcs: { slice: Slice; length: number; offset: number }[] = [];
  let travelled = 0;
  for (const slice of slices) {
    const length = (slice.value / total) * CIRCUMFERENCE;
    arcs.push({ slice, length, offset: travelled });
    travelled += length;
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative size-[84px] shrink-0">
        {/* Rotated so the first slice starts at twelve o'clock, which is where
            every clock-face reader expects a series to begin. */}
        <svg viewBox="0 0 84 84" className="size-full -rotate-90">
          <circle cx="42" cy="42" r={RADIUS} fill="none" stroke="var(--muted)" strokeWidth="10" />
          {arcs.map(({ slice, length, offset }) => (
            <circle
              key={slice.key}
              cx="42"
              cy="42"
              r={RADIUS}
              fill="none"
              stroke={slice.color}
              strokeWidth="10"
              strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
              strokeDashoffset={-offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="max-w-full truncate px-1 text-[12px] font-semibold tabular-nums text-foreground">
            {format(total)}
          </span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-0.5">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center gap-1.5 text-[11px]">
            <span className="size-2 shrink-0 rounded-full" style={{ background: slice.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{slice.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {format(slice.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── the card ─────────────────────────────────────────────────────── */

export async function renderChart(card: ChartCard, _ctx: RenderContext): Promise<RenderedCard> {
  const source = sourceById(card.query.source);
  // The group-by field is resolved inside `runGroupedQuery`, against the same
  // scope context the query is compiled with — a field this viewer may not group
  // by yields no slices there. Re-checking it here would be a second reader of
  // the same rule with the permission half missing.
  if (!source) return { node: null, signals: {} };

  const scope = await scopeContext(source);
  const isCount = card.metric.fn === "count";

  const [groups, counted] = await Promise.all([
    runGroupedQuery(card.query, card.groupBy, card.metric),
    /*
     * The matched-row count, which a grouped query does not give back.
     *
     * When the metric IS a count, the slices already carry it and summing them
     * is exact enough — the one caveat being a truncated result, where the sum
     * under-reports and the card says so on its face. When the metric is a sum or
     * an average, the slice values are money or hours and adding them up answers
     * a different question entirely, so the count is asked for directly. That is
     * one extra query, and it is the correct price: `count` has to mean rows
     * matched on every card, or a condition written on the stat card next to
     * this one means something else when it is copied here.
     */
    isCount ? Promise.resolve(null) : runMetricQuery(card.query, { fn: "count" }),
  ]);

  const slices = toSlices(groups);
  // The chart's own arithmetic, over the slices it actually draws.
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  // The signal, over every group the query returned — including any this card
  // filtered out as non-positive or folded into "Other".
  const summed = groups.reduce((sum, g) => sum + g.value, 0);
  const asMoney = isMoneyField(metricField(source, card.metric, scope));
  const format = (n: number) => formatMetric(n, asMoney);

  return {
    node: (
      <CardShell title={card.title}>
        {slices.length === 0 || total <= 0 ? (
          <EmptyLine>No {source.noun} to chart.</EmptyLine>
        ) : (
          <>
            {card.style === "donut" ? (
              <Donut slices={slices} total={total} format={format} />
            ) : (
              <Bars slices={slices} format={format} />
            )}
            {/*
              The compiler sets `truncated` when the result stopped describing
              every matching row — either the relation-hop scan hit its cap or
              there were more groups than a chart can carry. It is said out loud
              rather than swallowed: a chart that quietly under-reports is read
              as fact, and someone will make a decision on it. A card that admits
              it is partial costs a line of 10px text.
            */}
            {groups.truncated && (
              <p className="mt-2 text-[10.5px] text-muted-foreground/70">
                Partial view — some {source.noun} are not counted here.
              </p>
            )}
          </>
        )}
      </CardShell>
    ),
    /*
     * The vocabulary from ./shell.tsx, in full: `count` is rows matched — the
     * same thing it means on every other card — `total` is the aggregate, and
     * `groups` is how many slices were drawn.
     *
     * `groups` exists precisely so `count` does not have to do its job. "Hide
     * this chart unless there is more than one thing to compare" is a real and
     * chart-specific wish, and it used to be spelled `count`, which meant a
     * condition reading `count > 5` was rows on a list, rows on a stat and
     * SLICES here.
     */
    signals: { count: counted ?? summed, total: summed, groups: slices.length },
  };
}
