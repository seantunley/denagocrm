import "server-only";
import { getSetting } from "@/lib/settings";
import { DEFAULT_LABOUR_RATE_CENTS, hoursBetween, jobCardTotals } from "@/lib/workshop-constants";

export const LABOUR_RATE_SETTING = "WORKSHOP_LABOUR_RATE_CENTS";

/** Workshop-wide default labour rate (cents/hour) from settings, or the fallback. */
export async function getDefaultLabourRateCents(): Promise<number> {
  const raw = await getSetting(LABOUR_RATE_SETTING);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LABOUR_RATE_CENTS;
}

/** The rate a specific job bills at: its override, else the workshop default. */
export function effectiveLabourRateCents(jobLabourRateCents: number | null, defaultCents: number): number {
  return jobLabourRateCents != null && jobLabourRateCents > 0 ? jobLabourRateCents : defaultCents;
}

type TimeEntry = { startedAt: Date; endedAt: Date | null };

/** Total logged hours across time entries; the running entry counts up to `now`. */
export function totalLoggedHours(entries: TimeEntry[], now: Date): number {
  const sum = entries.reduce(
    (acc, e) => acc + hoursBetween(e.startedAt, e.endedAt ?? now),
    0,
  );
  return Math.round(sum * 100) / 100;
}

type ProfitItem = { kind: string; qty: number; unitPriceCents: number; part: { costCents: number } | null };

export type JobProfit = {
  partsRevenueCents: number;
  labourRevenueCents: number;
  otherRevenueCents: number;
  revenueCents: number;
  partsCostCents: number;
  subCostCents: number;
  costCents: number;
  profitCents: number;
  marginPct: number;
};

/** Job profitability: labour is the shop's value-add, parts are costed at cost. */
export function jobProfit(items: ProfitItem[], subCostCents: number): JobProfit {
  // Revenue is what the customer is billed, so it comes from the same helper the
  // job card and its printed documents use — including lines whose kind is
  // neither part nor labour, which the old parts+labour sum dropped and so
  // reported a margin the job never earned.
  const { partsCents, labourCents, otherCents, totalCents } = jobCardTotals(items);
  const partsCostCents = items
    .filter((i) => i.kind === "part")
    .reduce((s, i) => s + Math.round(i.qty * (i.part?.costCents ?? 0)), 0);
  const costCents = partsCostCents + subCostCents;
  const profitCents = totalCents - costCents;
  const marginPct = totalCents > 0 ? Math.round((profitCents / totalCents) * 100) : 0;
  return {
    partsRevenueCents: partsCents,
    labourRevenueCents: labourCents,
    otherRevenueCents: otherCents,
    revenueCents: totalCents,
    partsCostCents,
    subCostCents,
    costCents,
    profitCents,
    marginPct,
  };
}
