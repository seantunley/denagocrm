import "server-only";
import { prisma } from "@/lib/db";
import { loadTodayLeads, type TodayLead } from "@/lib/leadScoreLoader";
import {
  dashboardViewer, dashboardWindow, grants, leadWhere, quoteWhere,
  leadsThisMonth, prevLeadCount, wonThisMonth, prevWonValue, plannedActivities, dailySeries,
} from "@/lib/dashboard/data";
import { homeBriefLine, homeMood, homeNumbers, HOME_QUEUE_SIZE, type HomeNumber } from "./focusRules";

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
  /** How urgent the day is: sets the colour of the summary band. */
  mood: "calm" | "busy" | "behind";
  /** Day-by-day this month, for the small trend line behind a number. Only for figures that have a daily shape. */
  sparks: Partial<Record<HomeNumber["key"], number[]>>;
  /** Open deals by stage, in pipeline order — the one chart on the page. Empty when the viewer may not see deals. */
  stages: { name: string; color: string; count: number; value: number }[];
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
  const { todayStart, period, daysSoFar } = await dashboardWindow();
  const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
  const seesActivities = grants(access, "activities.view", "activities.manage");
  const seesSigning = grants(access, "signing.view", "signing.manage") && grants(access, "quotes.view_all", "quotes.view_owned");

  const openWhere = seesLeads ? { ...(await leadWhere()), status: "open" } : null;
  const [today, won, prevWon, created, prevCreated, open, target, overdueMine, agenda, waiting] = await Promise.all([
    seesLeads ? loadTodayLeads(user, { mine }) : { leads: [] as TodayLead[], truncated: false },
    seesLeads ? wonThisMonth() : [],
    seesLeads ? prevWonValue() : 0,
    seesLeads ? leadsThisMonth() : [],
    seesLeads ? prevLeadCount() : 0,
    // One read gives the pipeline's total, its size and its shape by stage.
    openWhere ? prisma.lead.findMany({ where: openWhere, select: { valueCents: true, stage: { select: { id: true, name: true, color: true, order: true } } } }) : [],
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
    openPipelineCents: open.reduce((sum, lead) => sum + lead.valueCents, 0),
    openDeals: open.length,
    newLeads: created.length,
    prevNewLeads: prevCreated,
    overdueMine,
    waitingSignature: waiting ?? 0,
  });
  const byStage = new Map<string, { name: string; color: string; count: number; value: number; order: number }>();
  for (const lead of open) {
    const stage = byStage.get(lead.stage.id) ?? { name: lead.stage.name, color: lead.stage.color, count: 0, value: 0, order: lead.stage.order };
    stage.count += 1;
    stage.value += lead.valueCents;
    byStage.set(lead.stage.id, stage);
  }
  return {
    numbers,
    mood: homeMood({ toContact: worth.length, overdueMine }),
    sparks: seesLeads
      ? {
          sales: dailySeries(won.map((w) => w.updatedAt), daysSoFar, (i) => Math.round(won[i].valueCents / 100)),
          "new-leads": dailySeries(created.map((lead) => lead.createdAt), daysSoFar),
        }
      : {},
    stages: [...byStage.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...stage }) => { void _order; return stage; }),
    brief: homeBriefLine({ toContact: worth.length, overdueMine, waitingSignature: waiting ?? 0, meetingsToday: agenda?.today.length ?? 0 }),
    queue: worth.slice(0, HOME_QUEUE_SIZE),
    queueMore: Math.max(0, worth.length - HOME_QUEUE_SIZE),
    seesLeads,
    agenda: agenda?.today ?? null,
    waitingSignature: waiting,
  };
}
