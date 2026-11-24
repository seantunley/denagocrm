/**
 * The Command Centre's KPI DEFINITIONS — the pure half.
 *
 * Every number on the Command Centre cards (./commandCards.tsx) is defined here,
 * once, so the definition the help article states and the definition the query
 * runs cannot drift, and so the rules can be tested without a database.
 *
 * NOTHING HERE INVENTS A NUMBER. Each helper turns rows the viewer may already
 * open into a count, a ratio with a stated denominator, or a per-currency total.
 * There is no score, no likelihood and no projection: where the mockup this was
 * designed from showed one ("customer health 92/100", "team load 78%"), the CRM
 * holds no record that measures it, and it was left out rather than guessed.
 *
 * PURE: no Prisma, no `server-only`, no JSX — the registry.ts discipline.
 */
import { addDays, format, startOfDay, startOfMonth, subMonths } from "date-fns";
import { totalsByCurrency } from "@/lib/currencyRules";
import { ATTENTION_WEIGHTS, type AttentionSignalKind } from "@/lib/attention/score";

/** The trailing window win rate and on-time delivery are measured over. */
export const WINDOW_DAYS = 90;
/** How many calendar months the won-value trend shows, the current one included. */
export const TREND_MONTHS = 12;

type Within = { gte: Date; lt: Date };

/**
 * "Won inside this window" — the SAME rule /targets uses (lib/targetProgress.ts,
 * review of #1107): dated by `wonAt`, the immutable day the deal was won, and
 * only a legacy deal that predates that column falls back to its last update.
 * Reports date wins by `wonAt` too, so the three screens agree on a month.
 */
export function wonWithin(within: Within) {
  return { status: "won", OR: [{ wonAt: within }, { wonAt: null, updatedAt: within }] };
}

/** "Lost inside this window", by the same rule as {@link wonWithin}. */
export function lostWithin(within: Within) {
  return { status: "lost", OR: [{ lostAt: within }, { lostAt: null, updatedAt: within }] };
}

/** The date a won deal counts on: `wonAt`, or its last update for a legacy row with none. */
export function wonOn(row: { wonAt: Date | null; updatedAt: Date }): Date {
  return row.wonAt ?? row.updatedAt;
}

/**
 * Win rate: won ÷ (won + lost) over the window, as a whole percentage.
 * `null` when nothing was decided — 0% would claim every deal was lost.
 */
export function winRatePct(won: number, lost: number): number | null {
  const decided = won + lost;
  return decided === 0 ? null : Math.round((won / decided) * 100);
}

/**
 * Delivered on time: of the deliveries made in the window that HAD a booked
 * date, how many were handed over on or before that day.
 *
 * A delivery with no booked date is not counted either way — there is no
 * promise to have kept or missed, and counting it as on time would flatter the
 * figure. The denominator is returned so the card can say "12 of 14".
 */
export function deliveredOnTime(rows: readonly { deliveredAt: Date; deliveryScheduledFor: Date | null }[]) {
  let booked = 0;
  let onTime = 0;
  for (const row of rows) {
    if (!row.deliveryScheduledFor) continue;
    booked += 1;
    if (row.deliveredAt < addDays(startOfDay(row.deliveryScheduledFor), 1)) onTime += 1;
  }
  return { onTime, booked, pct: booked === 0 ? null : Math.round((onTime / booked) * 100) };
}

export type MonthBucket = { start: Date; end: Date; label: string };

/** The last `n` calendar months, oldest first, the current (partial) month last. */
export function lastMonths(now: Date, n: number): MonthBucket[] {
  const out: MonthBucket[] = [];
  for (let back = n - 1; back >= 0; back -= 1) {
    const start = startOfMonth(subMonths(now, back));
    const end = startOfMonth(subMonths(now, back - 1));
    out.push({ start, end, label: format(start, "MMM") });
  }
  return out;
}

/**
 * Won value per month. Each bar is the BASE currency only — one bar cannot add
 * rands to dollars — and the deals in other currencies are totalled per
 * currency across the whole window, so the card can say what the bars leave out.
 */
export function wonByMonth(
  rows: readonly { at: Date; valueCents: number; currency: string | null }[],
  months: readonly MonthBucket[],
  base: string,
) {
  const bars = months.map((month) => ({ label: month.label, baseCents: 0, count: 0 }));
  const others: typeof rows[number][] = [];
  for (const row of rows) {
    const index = months.findIndex((month) => row.at >= month.start && row.at < month.end);
    if (index < 0) continue;
    bars[index].count += 1;
    if (!row.currency || row.currency === base) bars[index].baseCents += row.valueCents;
    else others.push(row);
  }
  const otherTotals = others.length
    ? totalsByCurrency(others, (row) => ({ cents: row.valueCents, currency: row.currency }), base).filter((t) => t.currency !== base)
    : [];
  return { bars, others: otherTotals };
}

/** How each Attention Centre signal reads as a management exception. */
export const EXCEPTION_LABELS: Record<AttentionSignalKind, string> = {
  unanswered_inbound: "Customer waiting for a reply",
  overdue_task: "Follow-up overdue",
  quote_expiring: "Quote about to expire",
  finance_waiting: "Finance stalled",
  no_next_step: "No next step planned",
  stage_age: "Too long in its stage",
  followup_unanswered: "Our follow-up got no reply",
};

type ExceptionLead = {
  id: string;
  name: string;
  valueCents: number;
  currency: string | null;
  signals: readonly { kind: AttentionSignalKind; detail: string }[];
};

/**
 * Group the Attention Centre's open deals by the REASON they are on it.
 *
 * One deal with two reasons counts once under each — the rows answer "how many
 * deals have this problem", not "how many problems". Ordered by the attention
 * engine's own weights (a customer waiting outranks a stale stage), so the
 * order is the engine's judgement, not a new one. Values are per currency.
 */
export function exceptionGroups(leads: readonly ExceptionLead[], base: string) {
  const groups = new Map<AttentionSignalKind, { kind: AttentionSignalKind; leads: ExceptionLead[]; example: { id: string; name: string; detail: string } }>();
  for (const lead of leads) {
    const seen = new Set<AttentionSignalKind>();
    for (const signal of lead.signals) {
      if (seen.has(signal.kind)) continue;
      seen.add(signal.kind);
      const group = groups.get(signal.kind) ?? { kind: signal.kind, leads: [], example: { id: lead.id, name: lead.name, detail: signal.detail } };
      group.leads.push(lead);
      groups.set(signal.kind, group);
    }
  }
  return [...groups.values()]
    .sort((a, b) => ATTENTION_WEIGHTS[b.kind] - ATTENTION_WEIGHTS[a.kind] || b.leads.length - a.leads.length)
    .map((group) => ({
      kind: group.kind,
      label: EXCEPTION_LABELS[group.kind],
      count: group.leads.length,
      // An empty base total is dropped when another currency has value: "R 0 + $ 50" says nothing.
      totals: totalsByCurrency(group.leads, (lead) => ({ cents: lead.valueCents, currency: lead.currency }), base).filter(
        (total, index, all) => total.cents !== 0 || all.length === 1 || index > 0,
      ),
      example: group.example,
    }));
}
