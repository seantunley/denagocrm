import "server-only";
import type { z } from "zod";
import { prisma } from "./db";
import { statsArgs } from "./crmAssistantPlan";
import { formatZAR } from "./format";
import { johannesburgDateKey } from "./activityDay";
import { isModuleEnabled } from "./modules/enabled";
import { accessibleTestDriveWhere } from "./testDriveAccess";
import { contactActivityWhere, contactCommunicationWhere } from "./customerContact";
import { getAccessibleLeadIds, getAccessibleQuoteIds, hasAnyPermission, type PermissionUser } from "./permissions";

/**
 * Sales numbers DAX can reason from — "why are sales slower this month?" —
 * worked out here, deterministically, rather than left to the model to count
 * from a list of 25 rows. Every figure is for the period asked AND the one
 * before it, so the answer can say what CHANGED, which is the question a
 * manager is actually asking.
 *
 * Through the person's own visibility (getAccessibleLeadIds / QuoteIds and the
 * test-drive page's rule), so a rep's "my numbers" never include anyone else's
 * deals and a manager's include exactly what their lists show.
 *
 * Not measured, and said so in the result rather than guessed: stage-to-stage
 * conversion (stage moves aren't kept as history, only the current stage and
 * when it was entered) and reply speed.
 */

const DAY = 86_400_000;
const sa = (key: string) => new Date(`${key}T00:00:00+02:00`);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

export type Period = { label: string; start: Date; end: Date; prevLabel: string; prevStart: Date; prevEnd: Date };

/**
 * The period and the one it is compared with, in South African days. A period
 * still running ("this month") is compared with the SAME number of days of the
 * one before — the 1st–6th against the 1st–6th — or a month six days old would
 * always look like a collapse.
 */
export function statsPeriod(name: z.infer<typeof statsArgs>["period"] = "this_month", now: Date = new Date()): Period {
  const today = johannesburgDateKey(now);
  const [y, m] = today.split("-").map(Number);
  const tomorrow = new Date(sa(today).getTime() + DAY);
  const monthKey = (year: number, month: number) => {
    const d = new Date(Date.UTC(year, month - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  };
  const running = (label: string, start: Date, prevStart: Date, prevLabel: string): Period => {
    const length = tomorrow.getTime() - start.getTime();
    return { label, start, end: tomorrow, prevLabel, prevStart, prevEnd: new Date(prevStart.getTime() + length) };
  };
  const rolling = (days: number): Period => {
    const start = new Date(tomorrow.getTime() - days * DAY);
    return { label: `last ${days} days`, start, end: tomorrow, prevLabel: `the ${days} days before`, prevStart: new Date(start.getTime() - days * DAY), prevEnd: start };
  };
  switch (name) {
    case "last_month":
      return {
        label: "last month",
        start: sa(monthKey(y, m - 1)),
        end: sa(monthKey(y, m)),
        prevLabel: "the month before",
        prevStart: sa(monthKey(y, m - 2)),
        prevEnd: sa(monthKey(y, m - 1)),
      };
    case "last_30_days":
      return rolling(30);
    case "last_90_days":
      return rolling(90);
    case "this_quarter": {
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return running("this quarter so far", sa(monthKey(y, q)), sa(monthKey(y, q - 3)), "the same days of last quarter");
    }
    case "this_year":
      return running("this year so far", sa(`${y}-01-01`), sa(`${y - 1}-01-01`), "the same days of last year");
    default:
      return running("this month so far", sa(monthKey(y, m)), sa(monthKey(y, m - 1)), "the same days of last month");
  }
}

type Window = { gte: Date; lt: Date };

export async function salesStats(user: PermissionUser, raw: z.infer<typeof statsArgs>) {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) {
    return { truncated: false, rows: [], data: [{ note: "You don't have access to leads." }] };
  }
  const args = statsArgs.parse(raw);
  const period = statsPeriod(args.period);
  const now: Window = { gte: period.start, lt: period.end };
  const before: Window = { gte: period.prevStart, lt: period.prevEnd };
  const ids = await getAccessibleLeadIds(user);
  const lead = {
    deletedAt: null,
    ...(ids === null ? {} : { id: { in: ids } }),
    ...(args.assignedTo ? { assignedTo: { name: { contains: args.assignedTo, mode: "insensitive" as const } } } : {}),
  };

  /** One period's headline numbers. */
  const headline = async (w: Window) => {
    const [created, won, lost, quoted] = await Promise.all([
      prisma.lead.count({ where: { ...lead, createdAt: w } }),
      prisma.lead.aggregate({ where: { ...lead, status: "won", wonAt: w }, _count: { _all: true }, _sum: { valueCents: true } }),
      prisma.lead.count({ where: { ...lead, status: "lost", lostAt: w } }),
      // Leads that came in this period and have reached a quote (any state).
      prisma.lead.count({ where: { ...lead, createdAt: w, quotes: { some: { deletedAt: null } } } }),
    ]);
    const closed = won._count._all + lost;
    return {
      newLeads: created,
      reachedQuote: `${quoted} (${pct(quoted, created)} of new leads)`,
      won: won._count._all,
      wonValue: formatZAR(won._sum.valueCents ?? 0),
      lost,
      winRate: pct(won._count._all, closed),
    };
  };

  const quoteIds = (await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned")) ? await getAccessibleQuoteIds(user) : [];
  const quoteScope = {
    deletedAt: null,
    supersededAt: null,
    ...(quoteIds === null ? {} : { id: { in: quoteIds } }),
    ...(args.assignedTo ? { lead: { assignedTo: { name: { contains: args.assignedTo, mode: "insensitive" as const } } } } : {}),
  };
  const quoteNumbers = async (w: Window) => {
    if (quoteIds !== null && quoteIds.length === 0) return null;
    const [issued, viewed, signed] = await Promise.all([
      prisma.quote.count({ where: { ...quoteScope, createdAt: w, status: { not: "draft" } } }),
      prisma.quote.count({ where: { ...quoteScope, viewedAt: w } }),
      prisma.quote.count({ where: { ...quoteScope, signedAt: w } }),
    ]);
    return { quotesIssued: issued, quotesOpenedByCustomers: viewed, quotesSigned: signed };
  };

  const [thisPeriod, lastPeriod, quotesNow, quotesBefore, sources, wonBySource, lostReasons, open] = await Promise.all([
    headline(now),
    headline(before),
    quoteNumbers(now),
    quoteNumbers(before),
    prisma.lead.groupBy({ by: ["source"], where: { ...lead, createdAt: now }, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["source"], where: { ...lead, status: "won", wonAt: now }, _count: { _all: true }, _sum: { valueCents: true } }),
    prisma.lead.groupBy({ by: ["lostReason"], where: { ...lead, status: "lost", lostAt: now }, _count: { _all: true }, orderBy: { _count: { lostReason: "desc" } }, take: 5 }),
    // The open pipeline as it stands — small (one workspace's open deals).
    prisma.lead.findMany({
      where: { ...lead, status: "open" },
      take: 2000,
      select: {
        id: true, valueCents: true, stageEnteredAt: true, assignedToId: true,
        assignedTo: { select: { name: true } },
        stage: { select: { name: true, order: true, staleAfterDays: true } },
      },
    }),
  ]);

  // ── Where the open pipeline sits, and what is stuck ──────────────────────────
  const today = Date.now();
  const stageRows = new Map<string, { order: number; open: number; value: number; days: number; stalled: number; stalledValue: number }>();
  for (const l of open) {
    const days = Math.floor((today - l.stageEnteredAt.getTime()) / DAY);
    const row = stageRows.get(l.stage.name) ?? { order: l.stage.order, open: 0, value: 0, days: 0, stalled: 0, stalledValue: 0 };
    row.open++;
    row.value += l.valueCents;
    row.days += days;
    if (l.stage.staleAfterDays && days >= l.stage.staleAfterDays) {
      row.stalled++;
      row.stalledValue += l.valueCents;
    }
    stageRows.set(l.stage.name, row);
  }
  const stages = [...stageRows.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([stage, r]) => ({
      stage,
      open: r.open,
      value: formatZAR(r.value),
      averageDaysInStage: Math.round(r.days / r.open),
      stalled: r.stalled ? `${r.stalled} (${formatZAR(r.stalledValue)}) past the stage's limit` : 0,
    }));

  // ── Each salesperson: their open deals, and whether they're being worked ─────
  const openIds = open.map((l) => l.id);
  const [planned, overdue, lastTouch, wonByPerson] = await Promise.all([
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId: { in: openIds }, status: "planned" }, _count: { _all: true } }),
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId: { in: openIds }, status: "planned", availabilityBlock: false, dueDate: { lt: new Date() } }, _count: { _all: true } }),
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId: { in: openIds }, ...contactCommunicationWhere }, _max: { occurredAt: true } }),
    prisma.lead.groupBy({ by: ["assignedToId"], where: { ...lead, status: "won", wonAt: now }, _count: { _all: true }, _sum: { valueCents: true } }),
  ]);
  const doneTouch = await prisma.activity.groupBy({ by: ["leadId"], where: { leadId: { in: openIds }, ...contactActivityWhere }, _max: { doneAt: true } });
  const hasNextStep = new Set(planned.map((r) => r.leadId));
  const overdueBy = new Map(overdue.map((r) => [r.leadId, r._count._all]));
  const touched = new Map<string, number>();
  for (const r of lastTouch) if (r.leadId && r._max.occurredAt) touched.set(r.leadId, r._max.occurredAt.getTime());
  for (const r of doneTouch) if (r.leadId && r._max.doneAt) touched.set(r.leadId, Math.max(touched.get(r.leadId) ?? 0, r._max.doneAt.getTime()));
  const quietBefore = today - 7 * DAY;

  const people = new Map<string, { name: string; open: number; value: number; withNextStep: number; overdue: number; quiet7: number }>();
  for (const l of open) {
    const key = l.assignedToId ?? "unassigned";
    const p = people.get(key) ?? { name: l.assignedTo?.name ?? "Unassigned", open: 0, value: 0, withNextStep: 0, overdue: 0, quiet7: 0 };
    p.open++;
    p.value += l.valueCents;
    if (hasNextStep.has(l.id)) p.withNextStep++;
    p.overdue += overdueBy.get(l.id) ?? 0;
    if ((touched.get(l.id) ?? 0) < quietBefore) p.quiet7++;
    people.set(key, p);
  }
  const wonFor = new Map(wonByPerson.map((r) => [r.assignedToId ?? "unassigned", r]));
  const salespeople = [...people.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 12)
    .map(([id, p]) => ({
      person: p.name,
      openDeals: p.open,
      openValue: formatZAR(p.value),
      withANextStepPlanned: pct(p.withNextStep, p.open),
      overdueTasks: p.overdue,
      noCustomerContact7Days: p.quiet7,
      wonThisPeriod: wonFor.get(id)?._count._all ?? 0,
      wonValueThisPeriod: formatZAR(wonFor.get(id)?._sum.valueCents ?? 0),
    }));

  // ── Test drives → sales (vehicle workspaces only) ───────────────────────────
  let testDrives: { completed: number; leadsWonSince: number } | null = null;
  if ((await isModuleEnabled("automotive")) && (await hasAnyPermission(user, "activities.view", "activities.manage"))) {
    const drives = await prisma.testDriveBooking.findMany({
      where: { deletedAt: null, status: "completed", scheduledStart: now, ...(await accessibleTestDriveWhere(user)) },
      take: 1000,
      select: { leadId: true },
    });
    const driveLeads = [...new Set(drives.map((d) => d.leadId).filter((x): x is string => Boolean(x)))];
    const won = driveLeads.length ? await prisma.lead.count({ where: { ...lead, id: { in: driveLeads }, status: "won" } }) : 0;
    testDrives = { completed: drives.length, leadsWonSince: won };
  }

  const wonSource = new Map(wonBySource.map((r) => [r.source, r]));
  return {
    truncated: open.length === 2000,
    data: [{
      period: `${period.label} (${johannesburgDateKey(period.start)} to ${johannesburgDateKey(new Date(period.end.getTime() - 1))})`,
      comparedWith: `${period.prevLabel} (${johannesburgDateKey(period.prevStart)} to ${johannesburgDateKey(new Date(period.prevEnd.getTime() - 1))})`,
      ...(args.assignedTo ? { person: args.assignedTo } : {}),
      thisPeriod: { ...thisPeriod, ...(quotesNow ?? {}) },
      previousPeriod: { ...lastPeriod, ...(quotesBefore ?? {}) },
      leadSources: sources
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 8)
        .map((s) => ({ source: s.source, newLeads: s._count._all, wonThisPeriod: wonSource.get(s.source)?._count._all ?? 0, wonValue: formatZAR(wonSource.get(s.source)?._sum.valueCents ?? 0) })),
      lostReasons: lostReasons.map((r) => ({ reason: r.lostReason || "(none given)", count: r._count._all })),
      openPipelineByStage: stages,
      salespeople,
      ...(testDrives ? { testDrives } : {}),
      notMeasured: "Stage-to-stage conversion (stage moves aren't kept as history) and reply speed.",
    }],
    rows: [{ label: "Sales numbers", detail: `${period.label} vs ${period.prevLabel}`, href: "/reports" }],
  };
}
