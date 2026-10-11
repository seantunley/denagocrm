import "server-only";
import { prisma } from "@/lib/db";
import { loadTodayLeads, type TodayLead } from "@/lib/leadScoreLoader";
import {
  dashboardViewer, dashboardWindow, grants, leadWhere, quoteWhere,
  leadsThisMonth, prevLeadCount, wonThisMonth, prevWonValue, plannedActivities,
} from "@/lib/dashboard/data";
import { homeBriefLine, homeNumbers, HOME_QUEUE_SIZE, type HomeNumber } from "./focusRules";

/**
 * Everything the home screen shows, loaded once.
 *
 * It asks nothing the rest of the app does not already ask: every figure comes
 * from the dashboard's own permission-aware loaders (./dashboard/data.ts), and
 * the "do next" list is the Today page's ranking. So what a person sees here is
 * exactly what they could already open — narrowed, ordered and summed up, never
 * widened. Each strand is loaded only if the viewer may see that kind of record.
 */
export type HomeFocus = {
  numbers: HomeNumber[];
  brief: string;
  /** The deals most worth contacting next, best first, with why. Empty when the viewer may not see deals. */
  queue: TodayLead[];
  /** How many more there are behind "see all". */
  queueMore: number;
  seesLeads: boolean;
  /** Today's planned work (and anything overdue), or null when the viewer may not see activities. */
  agenda: Awaited<ReturnType<typeof plannedActivities>>["today"] | null;
  /** Quotes out with customers, or null when the viewer may not see signing. */
  waitingSignature: number | null;
};

/** Signing requests still out with a customer, counted only over quotes the viewer may read. */
async function quotesOutForSignature(): Promise<number> {
  const out = await prisma.signatureRequest.findMany({
    where: { quoteId: { not: null }, deletedAt: null, status: { in: ["sent", "viewed", "in_progress"] } },
    select: { quoteId: true },
    take: 200,
  });
  const ids = [...new Set(out.map((r) => r.quoteId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return 0;
  // "May work with signing" does not say WHICH customers' quotes: the count is over the viewer's own quote scope.
  return prisma.quote.count({ where: { ...(await quoteWhere()), id: { in: ids }, deletedAt: null } });
}

export async function loadHomeFocus({ mine }: { mine: boolean }): Promise<HomeFocus> {
  const { user, access } = await dashboardViewer();
  const { todayStart, period } = await dashboardWindow();
  const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
  const seesActivities = grants(access, "activities.view", "activities.manage");
  const seesSigning = grants(access, "signing.view", "signing.manage") && grants(access, "quotes.view_all", "quotes.view_owned");

  const openWhere = seesLeads ? { ...(await leadWhere()), status: "open" } : null;
  const [today, won, prevWon, created, prevCreated, pipeline, openDeals, target, overdueMine, agenda, waiting] = await Promise.all([
    seesLeads ? loadTodayLeads(user, { mine }) : { leads: [] as TodayLead[], truncated: false },
    seesLeads ? wonThisMonth() : [],
    seesLeads ? prevWonValue() : 0,
    seesLeads ? leadsThisMonth() : [],
    seesLeads ? prevLeadCount() : 0,
    openWhere ? prisma.lead.aggregate({ where: openWhere, _sum: { valueCents: true } }) : null,
    openWhere ? prisma.lead.count({ where: openWhere }) : 0,
    seesLeads ? prisma.target.findFirst({ where: { period, metric: "sales_value" }, select: { value: true } }) : null,
    // The viewer's OWN overdue work: assignedToId is the caller, so this is nobody else's whatever their permissions.
    seesActivities ? prisma.activity.count({ where: { status: "planned", availabilityBlock: false, dueDate: { lt: todayStart }, assignedToId: user.id } }) : 0,
    seesActivities ? plannedActivities() : null,
    seesSigning ? quotesOutForSignature() : null,
  ]);

  // A deal is "worth contacting" when the ranking found a reason; the rest of the list is just the pipeline.
  const worth = today.leads.filter((lead) => lead.score > 0);
  const numbers = homeNumbers({
    seesLeads, seesActivities, seesSigning,
    wonCents: won.reduce((sum, w) => sum + w.valueCents, 0),
    prevWonCents: prevWon,
    salesTargetCents: target?.value ?? 0,
    openPipelineCents: pipeline?._sum.valueCents ?? 0,
    openDeals,
    newLeads: created.length,
    prevNewLeads: prevCreated,
    overdueMine,
    waitingSignature: waiting ?? 0,
  });
  return {
    numbers,
    brief: homeBriefLine({ toContact: worth.length, overdueMine, waitingSignature: waiting ?? 0, meetingsToday: agenda?.today.length ?? 0 }),
    queue: worth.slice(0, HOME_QUEUE_SIZE),
    queueMore: Math.max(0, worth.length - HOME_QUEUE_SIZE),
    seesLeads,
    agenda: agenda?.today ?? null,
    waitingSignature: waiting,
  };
}
