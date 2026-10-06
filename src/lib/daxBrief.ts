import "server-only";
import { cache } from "react";

import { prisma } from "./db";
import {
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  type PermissionUser,
} from "./permissions";
import { loadAttentionList } from "./attention/load";
import { loadTodayLeads } from "./leadScoreLoader";
import { accessibleTestDriveWhere } from "./testDriveAccess";
import { isModuleEnabled } from "./modules/enabled";
import { johannesburgDateKey } from "./activityDay";
import { contactName } from "./format";
import { listActingTenantStaff } from "./tenantActor";
import { buildBrief, buildTeamRows, type BriefLead, type DaxBrief, type TeamRow } from "./daxBriefRules";

export {
  buildBrief,
  buildTeamRows,
  briefForAssistant,
  type BriefItem,
  type DaxBrief,
  type TeamRow,
} from "./daxBriefRules";

/**
 * The DAX daily brief — the IMPURE half: gathers the facts `buildBrief` orders.
 *
 * Nothing here decides what matters; it only fetches. Every lead fact comes from
 * the loaders the rest of the app already trusts — `loadAttentionList` for what
 * is wrong, `loadTodayLeads` for what is warm — so the brief can never disagree
 * with the Attention Centre or the Today page about the same deal.
 *
 * ── NEVER MORE THAN THEIR OWN LISTS ─────────────────────────────────────────
 *
 * Every read is the tenant-scoped `prisma` plus the same scope helper the
 * matching page uses (leads, quotes, test drives), and each section is gated on
 * the permission that page checks. A brief that named a quote the person cannot
 * open would be a leak with a friendly greeting on it.
 *
 * `cache()` per request, like `loadAttentionList`, so the home card and anything
 * else on the render that asks share one execution.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's still-planned activities that are theirs: assigned, or attending. */
async function myAgenda(user: PermissionUser, dayStart: Date, dayEnd: Date) {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) {
    return { activities: [], testDrives: [] };
  }
  const activities = await prisma.activity.findMany({
    where: {
      status: "planned",
      availabilityBlock: false,
      // Test drives are read from their bookings below, which carry the vehicle.
      type: { not: "test_drive" },
      dueDate: { gte: dayStart, lt: dayEnd },
      OR: [{ assignedToId: user.id }, { attendees: { some: { userId: user.id } } }],
    },
    select: { type: true, dueDate: true },
  });
  if (!(await isModuleEnabled("automotive"))) return { activities, testDrives: [] };
  const bookings = await prisma.testDriveBooking.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["cancelled", "no_show", "completed"] },
      scheduledStart: { gte: dayStart, lt: dayEnd },
      AND: [
        await accessibleTestDriveWhere(user),
        { OR: [{ salespersonId: user.id }, { accompanyingSalespersonId: user.id }] },
      ],
    },
    orderBy: { scheduledStart: "asc" },
    select: { scheduledStart: true, demoVehicle: { select: { name: true } } },
  });
  return {
    activities,
    testDrives: bookings.map((b) => ({ scheduledStart: b.scheduledStart, vehicle: b.demoVehicle?.name ?? null })),
  };
}

/** Sent, unsigned quotes the customer has opened, on deals that are theirs or nobody's. */
async function viewedQuotes(user: PermissionUser, quoteIds: string[] | null) {
  if (quoteIds !== null && quoteIds.length === 0) return [];
  const rows = await prisma.quote.findMany({
    where: {
      ...(quoteIds === null ? {} : { id: { in: quoteIds } }),
      status: "sent",
      deletedAt: null,
      signedAt: null,
      supersededAt: null,
      viewedAt: { not: null },
      lead: { status: "open", deletedAt: null, OR: [{ assignedToId: user.id }, { assignedToId: null }] },
    },
    orderBy: { viewedAt: "desc" },
    select: { id: true, number: true, leadId: true, viewedAt: true, lead: { select: { name: true } } },
  });
  return rows.map((q) => ({
    id: q.id,
    number: q.number,
    leadId: q.leadId,
    leadName: q.lead?.name ?? `Q-${q.number}`,
    viewedAt: q.viewedAt!,
  }));
}

/**
 * Signed deals not yet delivered. The deliveries board is a shared operational
 * board, so this is scoped by the board's own gate (permission + automotive
 * module) and quote access — not narrowed to "mine".
 */
async function openDeliveries(user: PermissionUser, quoteIds: string[] | null) {
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return [];
  if (!(await isModuleEnabled("automotive"))) return [];
  if (quoteIds !== null && quoteIds.length === 0) return [];
  const rows = await prisma.quote.findMany({
    where: {
      ...(quoteIds === null ? {} : { id: { in: quoteIds } }),
      status: "accepted",
      supersededAt: null,
      deletedAt: null,
      deliveredAt: null,
    },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true, number: true, invoicedAt: true, depositPaidAt: true, deliveryScheduledFor: true, deliveredAt: true,
      contact: { select: { firstName: true, lastName: true } },
      lead: { select: { name: true } },
    },
  });
  return rows.map(({ contact, lead, ...q }) => ({
    ...q,
    customer: (contact ? contactName(contact) : null) ?? lead?.name ?? "no customer",
  }));
}

/**
 * Who this person oversees: `null` = everyone (an owner), a set = the members of
 * the active teams they manage, `undefined` = nobody, so no team view at all.
 */
async function teamMembers(user: PermissionUser): Promise<Set<string> | null | undefined> {
  if (user.role === "owner") return null;
  const teams = await prisma.team.findMany({
    where: { managerId: user.id, active: true, deletedAt: null },
    select: { members: { select: { userId: true } } },
  });
  if (teams.length === 0) return undefined;
  return new Set(teams.flatMap((team) => team.members.map((m) => m.userId)));
}

async function teamView(user: PermissionUser, leads: BriefLead[]): Promise<TeamRow[] | undefined> {
  const members = await teamMembers(user);
  if (members === undefined) return undefined;
  // The same scope the attention list used, so pipeline totals cover exactly
  // the deals the viewer could open — `[]` stays an impossible match.
  const ids = await getAccessibleLeadIds(user);
  const [pipeline, staff] = await Promise.all([
    prisma.lead.groupBy({
      by: ["assignedToId"],
      where: {
        status: "open",
        deletedAt: null,
        stage: { isClosed: false },
        ...(ids === null ? {} : { id: { in: ids } }),
        assignedToId: members === null ? { not: null } : { in: [...members] },
      },
      _sum: { valueCents: true },
    }),
    listActingTenantStaff(),
  ]);
  return buildTeamRows({
    leads,
    pipeline: pipeline
      .filter((p) => p.assignedToId)
      .map((p) => ({ ownerId: p.assignedToId as string, valueCents: p._sum.valueCents ?? 0 })),
    names: new Map(staff.map((s) => [s.id, s.name])),
    members,
  });
}

export const loadDaxBrief = cache(async (user: PermissionUser, now: Date = new Date()): Promise<DaxBrief> => {
  // The Johannesburg day, not the server's: on Vercel (UTC) "today" would start
  // at 02:00 local and miss the first two hours of the morning.
  const dayStart = new Date(`${johannesburgDateKey(now)}T00:00:00+02:00`);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const [attention, today, agenda, quoteIds] = await Promise.all([
    loadAttentionList(user, now),
    loadTodayLeads(user, { mine: true }, now),
    myAgenda(user, dayStart, dayEnd),
    getAccessibleQuoteIds(user),
  ]);
  const [viewed, deliveries, team] = await Promise.all([
    viewedQuotes(user, quoteIds),
    openDeliveries(user, quoteIds),
    teamView(user, attention.leads),
  ]);

  return buildBrief({
    now,
    userId: user.id,
    userName: user.name,
    leads: attention.leads,
    hot: today.leads,
    activities: agenda.activities,
    testDrives: agenda.testDrives,
    viewedQuotes: viewed,
    deliveries,
    team,
  });
});
