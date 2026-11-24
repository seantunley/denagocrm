import "server-only";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { johannesburgStartOfDay } from "@/lib/activityDay";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { hasAnyPermission, type PermissionUser } from "@/lib/permissions";
import { listActingTenantStaff } from "@/lib/tenantActor";
import type { Disposition } from "./dispositions";

/**
 * My Work's other views (brief §6: "Completed", "Team (permission gated)") and the
 * person's own snooze/dismiss choices. Read from the records, like the list itself.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every read here names the acting workspace (tenantId) rather than relying on
 * tenant enforcement being on — someone can work in more than one workspace.
 */

/** My live snoozes and dismissals in this workspace. */
export async function myDispositions(user: PermissionUser, now: Date): Promise<Disposition[]> {
  return prisma.workDisposition.findMany({
    where: { tenantId: await actingTenantId(), userId: user.id, until: { gt: now } },
    select: { itemKey: true, action: true, until: true, fingerprint: true },
  });
}

export type DoneItem = { key: string; area: string; title: string; at: Date; href: string };

/** What I finished today, on the records themselves: tasks done, cases closed, jobs completed. */
export async function myDoneToday(user: PermissionUser, now: Date): Promise<DoneItem[]> {
  const since = johannesburgStartOfDay(now);
  const modules = await getEnabledModuleIds();
  const tenantId = await actingTenantId();
  const [activities, cases, jobs] = await Promise.all([
    (await hasAnyPermission(user, "activities.view", "activities.manage"))
      ? prisma.activity.findMany({ where: { tenantId, assignedToId: user.id, status: "done", doneAt: { gte: since } }, select: { id: true, summary: true, doneAt: true, leadId: true } })
      : [],
    modules.has("support") && (await hasAnyPermission(user, "cases.view_all", "cases.view_owned"))
      ? prisma.customerCase.findMany({ where: { tenantId, assignedToId: user.id, closedAt: { gte: since } }, select: { id: true, number: true, subject: true, closedAt: true } })
      : [],
    modules.has("automotive") && (await hasAnyPermission(user, "jobcards.view_all", "jobcards.view_owned"))
      ? prisma.jobCard.findMany({ where: { tenantId, technicianId: user.id, completedAt: { gte: since }, deletedAt: null }, select: { id: true, number: true, completedAt: true } })
      : [],
  ]);
  return [
    ...activities.map((a) => ({ key: `activity:${a.id}`, area: "Sales", title: a.summary, at: a.doneAt!, href: a.leadId ? `/leads/${a.leadId}` : "/activities" })),
    ...cases.map((c) => ({ key: `case:${c.id}`, area: "Support", title: `#${c.number} · ${c.subject}`, at: c.closedAt!, href: `/cases/${c.id}` })),
    ...jobs.map((j) => ({ key: `jobcard:${j.id}`, area: "Workshop", title: `JC-${j.number}`, at: j.completedAt!, href: `/jobcards/${j.id}` })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * How suggestions land (brief §7: "measure … dismissal rates"): the items people in this workspace set aside in
 * the last 30 days, by kind — each item ONCE, by its latest choice (one row per person per item; a later choice
 * replaces the earlier one). Owner only, counts only — nobody's customer is named. Many dismissals of one kind says
 * its rule is noisy. The kind comes from the item's saved reason, kept on snoozes and dismissals alike.
 *
 * ponytail: latest choice per item, not every click and not every suggestion shown — either needs an append-only
 * log (a write per click / per page view). Add one if per-rule resolution rates are wanted.
 */
export async function suggestionFeedback(user: PermissionUser, now: Date) {
  if (user.role !== "owner") return null;
  const rows = await prisma.workDisposition.findMany({
    where: { tenantId: await actingTenantId(), updatedAt: { gte: new Date(now.getTime() - 30 * DAY) } },
    select: { itemKey: true, action: true, fingerprint: true },
  });
  const out = new Map<string, { kind: string; dismissed: number; snoozed: number }>();
  for (const row of rows) {
    // Stuck-deal suggestions carry a "stuck:" fingerprint; the rest are named by their source.
    const kind = row.fingerprint?.startsWith("stuck:") ? "Stuck deals" : SOURCE_NAME[row.itemKey.split(":")[0]] ?? "Other";
    const t = out.get(kind) ?? { kind, dismissed: 0, snoozed: 0 };
    if (row.action === "dismissed") t.dismissed += 1;
    else t.snoozed += 1;
    out.set(kind, t);
  }
  return [...out.values()].sort((a, b) => b.dismissed - a.dismissed || b.snoozed - a.snoozed);
}

const SOURCE_NAME: Record<string, string> = {
  lead: "Deals worth contacting",
  quote: "Quotes waiting to be signed",
  activity: "Planned tasks",
  delivery: "Deliveries",
  jobcard: "Job cards",
  case: "Cases",
  approval: "Approvals",
};

export type TeamRow = { id: string; name: string; overdue: number; today: number; cases: number; jobs: number };

/**
 * Each colleague's load — counts only, for the workspace owner (brief §6 "Team,
 * permission gated"). Counts of their planned work, open cases and open job cards;
 * no record content, so it shows nothing an owner could not see anyway.
 */
export async function teamWorkload(user: PermissionUser, now: Date): Promise<TeamRow[] | null> {
  if (user.role !== "owner") return null;
  const start = johannesburgStartOfDay(now);
  const modules = await getEnabledModuleIds();
  const tenantId = await actingTenantId();
  const planned = { tenantId, status: "planned", availabilityBlock: false } as const;
  const [staff, overdue, today, cases, jobs] = await Promise.all([
    listActingTenantStaff(),
    prisma.activity.groupBy({ by: ["assignedToId"], where: { ...planned, dueDate: { lt: now } }, _count: { _all: true } }),
    prisma.activity.groupBy({ by: ["assignedToId"], where: { ...planned, dueDate: { gte: now, lt: new Date(start.getTime() + DAY) } }, _count: { _all: true } }),
    modules.has("support")
      ? prisma.customerCase.groupBy({ by: ["assignedToId"], where: { tenantId, closedAt: null, status: { in: ["new", "open", "waiting_internal"] } }, _count: { _all: true } })
      : [],
    modules.has("automotive")
      ? prisma.jobCard.groupBy({ by: ["technicianId"], where: { tenantId, deletedAt: null, status: { notIn: ["collected", "cancelled"] } }, _count: { _all: true } })
      : [],
  ]);
  const tally = (rows: { who: string | null; n: number }[]) => new Map(rows.map((row) => [row.who, row.n]));
  const byOverdue = tally(overdue.map((r) => ({ who: r.assignedToId, n: r._count._all })));
  const byToday = tally(today.map((r) => ({ who: r.assignedToId, n: r._count._all })));
  const byCases = tally(cases.map((r) => ({ who: r.assignedToId, n: r._count._all })));
  const byJobs = tally(jobs.map((r) => ({ who: r.technicianId, n: r._count._all })));
  return staff
    .map((person) => ({
      id: person.id,
      name: person.name,
      overdue: byOverdue.get(person.id) ?? 0,
      today: byToday.get(person.id) ?? 0,
      cases: byCases.get(person.id) ?? 0,
      jobs: byJobs.get(person.id) ?? 0,
    }))
    .sort((a, b) => b.overdue - a.overdue || b.today - a.today || a.name.localeCompare(b.name));
}
