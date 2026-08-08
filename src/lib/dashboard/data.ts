import "server-only";
import { cache } from "react";
import { subDays, addDays, startOfDay, startOfMonth, subMonths } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import {
  getUserPermissionList,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  getAccessibleJobCardIds,
  type PermissionKey,
  type PermissionUser,
} from "@/lib/permissions";
import { computeDue } from "@/lib/serviceDue";
import { DEFAULT_LAYOUT, normaliseLayout, type DashboardAccess, type DashboardCardId } from "./registry";

/**
 * The dashboard's shared data layer.
 *
 * THE COST PROBLEM. A dashboard is N cards firing queries at once, and it is the
 * first screen every user sees, so a naive card registry — each card owning its
 * own loader — multiplies the query count the moment two cards want the same
 * rows. The old page avoided that by hand: one 22-way `Promise.all` at the top,
 * with results shared between sections.
 *
 * Every export here is wrapped in React's `cache()`, which memoises per REQUEST.
 * That gives each card an independent loader that asks for exactly what it needs
 * while the underlying query still runs once: `salesAgenda` and `serviceAgenda`
 * both call `plannedActivities()` and one query is issued; `salesStats` and
 * `monthTargets` both call `leadsThisMonth()` and one query is issued. So the
 * page's cost is the number of DISTINCT queries the visible cards need, not the
 * number of cards — and a card the user cannot see never runs its loader at all,
 * which is the cheapest query of the lot.
 *
 * THE LEAK PROBLEM. The queries lifted from the old page were unscoped —
 * `prisma.lead.count({ where: { status: "open" } })` counts EVERY open lead, so
 * a rep holding only `leads.view_owned` was being shown a total covering leads
 * they cannot open. That is precisely the way a dashboard leaks: not by naming a
 * record, but by aggregating over records the viewer has no access to. Every
 * lead/quote/vehicle/job-card query below is therefore constrained by the
 * caller's accessible-id scope. `null` from those helpers means UNRESTRICTED
 * (owner / view_all), which is why `scopeIds` returns `{}` rather than an empty
 * `in` list — confusing the two either opens everything or closes it.
 */

/* ── the viewer ───────────────────────────────────────────────────── */

/**
 * Everything the dashboard needs to know about who is asking, resolved ONCE.
 *
 * The permission list is read a single time and handed to every card as a set,
 * so eleven cards cost one RBAC lookup rather than eleven. `getUserPermissionList`
 * already collapses the special cases: an owner gets the whole catalogue, and an
 * unavailable/uninitialised RBAC state gets the empty set (fail closed).
 */
export const dashboardViewer = cache(
  async (): Promise<{ user: PermissionUser; access: DashboardAccess }> => {
    const user = await requireUser();
    const [permissions, modules] = await Promise.all([
      getUserPermissionList(user),
      getEnabledModuleIds(),
    ]);
    return { user, access: { permissions: new Set(permissions), modules: new Set(modules) } };
  },
);

/** Synchronous "does the viewer hold any of these?" against the resolved set. */
export function grants(access: DashboardAccess, ...keys: PermissionKey[]): boolean {
  return keys.some((key) => access.permissions.has(key));
}

/**
 * The signed-in user's saved arrangement, or the default if they have never
 * touched it.
 *
 * Keyed on the SESSION user, never on an argument — there is no way to ask this
 * for somebody else. Combined with the action file's identical rule, one user's
 * layout has no path to another user's screen.
 *
 * Whatever comes back from the database goes through `normaliseLayout`, which is
 * what makes a stale saved layout safe: a card id retired in a later release is
 * dropped here rather than reaching the renderer and failing to resolve.
 */
export const dashboardLayoutForViewer = cache(async (): Promise<DashboardCardId[]> => {
  const { user } = await dashboardViewer();
  const row = await prisma.dashboardLayout.findFirst({
    where: { userId: user.id },
    select: { cards: true },
  });
  return row ? normaliseLayout(row.cards) : [...DEFAULT_LAYOUT];
});

/* ── the shared time window ───────────────────────────────────────── */

/**
 * One clock for the whole render. Cards compare against each other ("leads this
 * month" beside "target for this month"), so they must agree on where the month
 * starts — computing `new Date()` independently in eleven loaders would let a
 * render that straddles midnight produce two different months on one screen.
 */
export const dashboardWindow = cache(async () => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const monthStart = startOfMonth(now);
  const prevMonthStart = startOfMonth(subMonths(now, 1));
  return {
    now,
    todayStart,
    tomorrowStart: addDays(todayStart, 1),
    dayAfterStart: addDays(todayStart, 2),
    monthStart,
    prevMonthStart,
    // The same span of days into last month, so a mid-month comparison is honest.
    prevSameDay: new Date(prevMonthStart.getTime() + (now.getTime() - monthStart.getTime())),
    period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    daysSoFar: now.getDate(),
    staleQuoteCutoff: subDays(now, 3),
  };
});

/* ── record-level scopes ──────────────────────────────────────────── */

/**
 * Turn an accessible-id list into a `where` fragment.
 *
 * `null` means unrestricted → no filter. A non-null but EMPTY list means the
 * user may see nothing of this type → `in: []`, which matches no row. Returning
 * `{}` for the empty case would show them everything.
 */
function scopeIds(ids: string[] | null): Record<string, unknown> {
  return ids === null ? {} : { id: { in: ids } };
}

const leadScope = cache(async () => getAccessibleLeadIds((await dashboardViewer()).user));
const quoteScope = cache(async () => getAccessibleQuoteIds((await dashboardViewer()).user));
const vehicleScope = cache(async () => getAccessibleVehicleIds((await dashboardViewer()).user));
const jobCardScope = cache(async () => getAccessibleJobCardIds((await dashboardViewer()).user));

export const leadWhere = cache(async () => scopeIds(await leadScope()));
export const quoteWhere = cache(async () => scopeIds(await quoteScope()));
export const vehicleWhere = cache(async () => scopeIds(await vehicleScope()));
export const jobCardWhere = cache(async () => scopeIds(await jobCardScope()));

/* ── shared queries ───────────────────────────────────────────────── */

/** Leads created this month — feeds the "new leads" stat AND the leads target ring. */
export const leadsThisMonth = cache(async () => {
  const { monthStart } = await dashboardWindow();
  return prisma.lead.findMany({
    where: { ...(await leadWhere()), createdAt: { gte: monthStart } },
    select: { createdAt: true },
  });
});

export const prevLeadCount = cache(async () => {
  const { prevMonthStart, prevSameDay } = await dashboardWindow();
  return prisma.lead.count({
    where: { ...(await leadWhere()), createdAt: { gte: prevMonthStart, lt: prevSameDay } },
  });
});

/** Deals marked won this month — feeds the "won value" stat AND the sales ring. */
export const wonThisMonth = cache(async () => {
  const { monthStart } = await dashboardWindow();
  // updatedAt ≈ when the deal was marked won.
  return prisma.lead.findMany({
    where: { ...(await leadWhere()), status: "won", updatedAt: { gte: monthStart } },
    select: { updatedAt: true, valueCents: true },
  });
});

export const prevWonValue = cache(async () => {
  const { prevMonthStart, prevSameDay } = await dashboardWindow();
  const rows = await prisma.lead.findMany({
    where: {
      ...(await leadWhere()),
      status: "won",
      updatedAt: { gte: prevMonthStart, lt: prevSameDay },
    },
    select: { valueCents: true },
  });
  return rows.reduce((sum, row) => sum + row.valueCents, 0);
});

/** Services completed this month — feeds the service stat AND the services ring. */
export const servicesThisMonth = cache(async () => {
  const { monthStart } = await dashboardWindow();
  return prisma.jobCard.findMany({
    where: { ...(await jobCardWhere()), status: "completed", completedAt: { gte: monthStart } },
    select: { completedAt: true },
  });
});

/** Quotes delivered this month — feeds the deliveries ring. */
export const deliveriesThisMonth = cache(async () => {
  const { monthStart } = await dashboardWindow();
  return prisma.quote.count({
    where: { ...(await quoteWhere()), deliveredAt: { gte: monthStart } },
  });
});

/**
 * Planned activities for today and tomorrow, fetched ONCE and split by the
 * caller. The sales agenda wants the non-workshop ones and the workshop agenda
 * wants the rest; two queries would be two scans of the same window.
 */
export const plannedActivities = cache(async () => {
  const { tomorrowStart, dayAfterStart } = await dashboardWindow();
  const include = { lead: true, contact: true, assignedTo: true } as const;
  const [today, tomorrow] = await Promise.all([
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { lt: tomorrowStart } },
      orderBy: { dueDate: "asc" },
      include,
      take: 20,
    }),
    prisma.activity.findMany({
      where: { status: "planned", dueDate: { gte: tomorrowStart, lt: dayAfterStart } },
      orderBy: { dueDate: "asc" },
      include,
      take: 20,
    }),
  ]);
  return { today, tomorrow };
});

/**
 * Vehicles that are overdue or coming up for a service.
 *
 * The single most expensive query on the page — every vehicle, with its latest
 * service record and mileage log — because `computeDue` is TypeScript, not SQL,
 * so the due set cannot be narrowed in the database. It is shared by the service
 * stats card and the service-due list; caching it is what keeps adding the
 * second card free. Left otherwise as it was rather than bounded with a `take`,
 * because a limit here would silently under-report the "service due" count.
 */
export const vehiclesDueForService = cache(async () => {
  const vehicles = await prisma.vehicle.findMany({
    where: await vehicleWhere(),
    include: {
      contact: true,
      serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });
  const due = vehicles
    .map((vehicle) => ({ vehicle, due: computeDue(vehicle) }))
    .filter((x) => x.due.status === "overdue" || x.due.status === "due_soon")
    .sort((a, b) => (a.due.status === "overdue" ? -1 : 1) - (b.due.status === "overdue" ? -1 : 1));
  return { total: vehicles.length, due };
});

/* ── small helpers shared by the card renderers ───────────────────── */

/** Daily counts (index 0 = 1st of the month) for the sparklines. */
export function dailySeries(dates: Date[], daysInSeries: number, value?: (i: number) => number) {
  const out = new Array(Math.max(2, daysInSeries)).fill(0);
  dates.forEach((d, i) => {
    const idx = d.getDate() - 1;
    if (idx >= 0 && idx < out.length) out[idx] += value ? value(i) : 1;
  });
  return out;
}

export const pctDelta = (cur: number, prev: number): number | null =>
  prev === 0 ? (cur > 0 ? 100 : null) : Math.round(((cur - prev) / prev) * 100);
