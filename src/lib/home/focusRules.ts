/**
 * The home screen's rules — which numbers a person sees, in what order, with
 * what context, and the one line that sums the day up.
 *
 * Pure: figures in, what to show out. The design it serves has three layers —
 * a glance (a handful of numbers), a work queue, and detail on demand — and its
 * first rule is restraint: at most FIVE numbers, each with context, each a link
 * to the records behind it. A number that is not the viewer's to see is not
 * shown as a zero; it is not shown.
 */
import { formatZARCompact } from "@/lib/format";

export const MAX_HOME_NUMBERS = 5;
/** How many deals the "do next" list shows before "see all". Past about six, a list stops being scannable. */
export const HOME_QUEUE_SIZE = 6;

export type HomeNumber = {
  key: "sales" | "pipeline" | "new-leads" | "overdue" | "waiting";
  label: string;
  /** The figure, formatted. */
  value: string;
  /** What it is measured against — a target, last month, a count. Never empty: a bare figure says nothing. */
  context: string;
  /** Up or down against the comparison, when there is one. */
  direction?: "up" | "down";
  /** 0–1 of a target reached, when the figure is progress toward one. */
  progress?: number;
  /** Something here needs the viewer. Used for exactly one thing: overdue work. */
  alert?: boolean;
  /** The records behind the figure. */
  href: string;
};

export type HomeFigures = {
  /** What the viewer may see. A figure is built only for what they may open. */
  seesLeads: boolean;
  seesActivities: boolean;
  seesSigning: boolean;
  wonCents: number;
  /** The same span of days into last month. */
  prevWonCents: number;
  /** This month's sales target in cents; 0 when none is set. */
  salesTargetCents: number;
  openPipelineCents: number;
  openDeals: number;
  newLeads: number;
  prevNewLeads: number;
  /** The viewer's OWN planned work that is past due. */
  overdueMine: number;
  /** Signing requests out with customers that the viewer may see. */
  waitingSignature: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "▲ 12% on last month" — or, with nothing to compare against, a plain statement. */
function against(current: number, previous: number): { context: string; direction?: "up" | "down" } {
  if (previous === 0) return { context: current > 0 ? "none by this day last month" : "same as last month" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { context: "level with last month" };
  return { context: `${Math.abs(pct)}% ${pct > 0 ? "up" : "down"} on last month`, direction: pct > 0 ? "up" : "down" };
}

/** The numbers for the top of the home screen, most important first, never more than MAX_HOME_NUMBERS. */
export function homeNumbers(f: HomeFigures): HomeNumber[] {
  const out: HomeNumber[] = [];
  if (f.seesLeads) {
    // With a target, the question is "how far along are we?"; without one, "how does it compare?".
    if (f.salesTargetCents > 0) {
      const progress = Math.min(1, Math.max(0, f.wonCents / f.salesTargetCents));
      out.push({ key: "sales", label: "Sold this month", value: formatZARCompact(f.wonCents), context: `${Math.round(progress * 100)}% of ${formatZARCompact(f.salesTargetCents)} target`, progress, href: "/targets" });
    } else {
      out.push({ key: "sales", label: "Sold this month", value: formatZARCompact(f.wonCents), ...against(f.wonCents, f.prevWonCents), href: "/leads" });
    }
    out.push({ key: "pipeline", label: "Open pipeline", value: formatZARCompact(f.openPipelineCents), context: `across ${plural(f.openDeals, "open deal")}`, href: "/leads" });
    out.push({ key: "new-leads", label: "New leads this month", value: String(f.newLeads), ...against(f.newLeads, f.prevNewLeads), href: "/leads" });
  }
  if (f.seesActivities) {
    out.push({ key: "overdue", label: "Overdue for you", value: String(f.overdueMine), context: f.overdueMine === 0 ? "nothing past due" : "planned and past due", alert: f.overdueMine > 0, href: "/activities" });
  }
  if (f.seesSigning) {
    out.push({ key: "waiting", label: "Out for signature", value: String(f.waitingSignature), context: f.waitingSignature === 0 ? "nothing waiting on a customer" : "waiting on a customer", href: "/signatures" });
  }
  return out.slice(0, MAX_HOME_NUMBERS);
}

/**
 * The one line under the greeting. It does the job of several charts: how much
 * needs the viewer, and of what kind. When nothing does, it says so — a quiet
 * day is a good result and should read as one.
 */
export function homeBriefLine(day: { toContact: number; overdueMine: number; waitingSignature: number; meetingsToday: number }): string {
  const needs: string[] = [];
  if (day.overdueMine > 0) needs.push(`${plural(day.overdueMine, "follow-up")} overdue`);
  if (day.toContact > 0) needs.push(`${plural(day.toContact, "deal")} worth contacting`);
  if (needs.length === 0) {
    const calm = day.meetingsToday > 0 ? `${plural(day.meetingsToday, "thing")} on today's agenda` : "a clear day";
    return day.waitingSignature > 0 ? `Nothing needs you right now — ${calm}, and ${plural(day.waitingSignature, "quote")} out for signature.` : `Nothing needs you right now — ${calm}.`;
  }
  const tail = day.waitingSignature > 0 ? ` ${plural(day.waitingSignature, "quote")} ${day.waitingSignature === 1 ? "is" : "are"} out for signature.` : "";
  return `${needs.join(" and ")}.${tail}`.replace(/^./, (c) => c.toUpperCase());
}
