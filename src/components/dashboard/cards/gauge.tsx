import { TargetRings, type RingDef } from "@/components/dashboard/widgets";
import type { GaugeCard } from "@/lib/dashboard/config";
import { sourceById } from "@/lib/dashboard/sources";
import { runMetricQuery, scopeContext } from "@/lib/dashboard/compile";
import { CardShell, type RenderContext, type RenderedCard } from "./shell";
import { formatMetric, isMoneyField, metricField } from "./values";

/**
 * Progress against a target.
 *
 * REUSED WHOLESALE from the builtin "Month targets" card. `TargetRings` in
 * components/dashboard/widgets.tsx already draws exactly this — an animated arc
 * with a percentage in the middle, a tooltip reading "X of Y target", and the
 * celebratory flourish when a target is met. Writing a second progress ring
 * would have produced two rings on one screen, slightly different, and the one
 * on the user's own card would be the one that looked wrong.
 *
 * TWO ADAPTATIONS ARE NEEDED, AND BOTH ARE WORTH NAMING:
 *
 *   The ring grid is built for up to four metrics and lays them out four across.
 *   A gauge card has exactly one, and one ring in the first cell of a
 *   four-column grid sits in the left quarter of the card looking abandoned. The
 *   wrapper below overrides that grid to a single column, which centres it. A
 *   variant prop on `TargetRings` would have been the tidier fix and is not
 *   available to this change — components/dashboard/widgets.tsx is outside it.
 *
 *   `RingDef.display: "zar"` formats RANDS, not cents — the builtin card divides
 *   before it passes the value in. So does this one. See the target note below
 *   for which side of that divide `card.target` is on.
 */
export async function renderGauge(card: GaugeCard, _ctx: RenderContext): Promise<RenderedCard> {
  const source = sourceById(card.query.source);
  // Resolved through the compiler's own gate, not by looking at the field's
  // name — see `metricField`. Which unit this card compares in hangs off the
  // answer, so guessing from a key called `value` or `valueCents` would be
  // guessing about money.
  const asMoney = source
    ? isMoneyField(metricField(source, card.metric, await scopeContext(source)))
    : false;

  const [value, count] = await Promise.all([
    runMetricQuery(card.query, card.metric),
    // Same reasoning as the stat card: a gauge showing R0 of R500k has not told
    // anyone whether there were no deals or only worthless ones, and a condition
    // that hides the card when it is empty means the first.
    card.metric.fn === "count" ? Promise.resolve(null) : runMetricQuery(card.query, { fn: "count" }),
  ]);

  /*
   * THE TARGET IS STORED IN RANDS AND COMPARED IN CENTS.
   *
   * ── THE EDITOR MUST COLLECT RANDS ───────────────────────────────────────
   *
   * `card.target` is whatever a person typed into the target box, in the units
   * they think in. For a money metric that is RANDS: 50000 means R50 000. The
   * conversion to cents happens here, on the way to the comparison, and nowhere
   * else. Whoever builds the editor: collect rands, store rands, do not
   * pre-multiply.
   *
   * ── WHY THAT WAY ROUND ──────────────────────────────────────────────────
   *
   * Because it is already the convention everywhere else a number meets money in
   * this feature. `coerceValue` in lib/dashboard/compile.ts takes a filter value
   * in rands and emits cents, and calls itself the only place that conversion
   * happens. If the target were the exception, one number typed into a filter
   * and the same number typed into a target would differ by a factor of a
   * hundred, in the same editor, on the same card. Nobody would find that on
   * their own — they would find a gauge reading 100% at one percent of the goal,
   * and by then they would have believed it.
   *
   * The metric comes back in cents (see `runMetricQuery`), so the multiplication
   * is what makes `actual >= target` a comparison of like with like. Rounded,
   * because a target of 1234.567 rands is not a number of cents.
   *
   * NON-MONEY METRICS ARE UNTOUCHED. A target of 20 job cards is 20.
   *
   * The schema's floor is 1, so the clamp is belt-and-braces: a zero target
   * would make `TargetRings` offer its "set this month's targets" link, which
   * belongs to the builtin card and not to this one.
   */
  const target = Math.max(1, asMoney ? Math.round(card.target * 100) : card.target);

  const readout = `${formatMetric(value, asMoney)} of ${formatMetric(target, asMoney)}${
    card.unit ? ` ${card.unit}` : ""
  }`;

  const ring: RingDef = {
    label: readout,
    actual: asMoney ? value / 100 : value,
    target: asMoney ? target / 100 : target,
    display: asMoney ? "zar" : "int",
    color: "var(--chart-1)",
  };

  return {
    node: (
      <CardShell title={card.title}>
        {/* One ring, centred — see the note above about the four-across grid. */}
        <div className="[&>div>div]:grid-cols-1">
          <TargetRings rings={[ring]} />
        </div>
      </CardShell>
    ),
    // `count` is rows matched and `total` the aggregate, as everywhere else.
    // `target` is published in the SAME units as `total` — cents for money — so
    // a condition can compare the two without knowing which card it is on.
    signals: { count: count ?? value, total: value, target },
  };
}
