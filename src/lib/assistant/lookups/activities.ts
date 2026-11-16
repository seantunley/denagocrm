import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { johannesburgDateKey } from "../../activityDay";
import { getAccessibleActivityIds } from "../../activityAccess";
import { hasAnyPermission } from "../../permissions";
import { activityArgs } from "../../crmAssistantPlan";
import { DAY, ToolOutput, User, fuzzy, dateKey, CANCELLED, refused, saLocal } from "../lookupKit";

export async function findActivities(user: User, raw: z.infer<typeof activityArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return refused("activities");
  const args = activityArgs.parse(raw);
  const ids = await getAccessibleActivityIds(user);
  // Day edges in Johannesburg (UTC+2, no DST) — the timezone every date here shows in.
  const today = johannesburgDateKey(new Date());
  const startOfToday = new Date(`${today}T00:00:00+02:00`);
  const range = {
    overdue: { lt: startOfToday },
    today: { gte: startOfToday, lt: new Date(startOfToday.getTime() + DAY) },
    // Everything still open up to the end of today: what's late has to be done too.
    today_and_overdue: { lt: new Date(startOfToday.getTime() + DAY) },
    this_week: { gte: startOfToday, lt: new Date(startOfToday.getTime() + 7 * DAY) },
    upcoming: { gte: new Date() },
    past: { lt: new Date() },
  }[args.when];
  // A specific day or period ("22 September", "last month") replaces the window.
  const dated = args.from || args.to
    ? {
        ...(args.from ? { gte: new Date(`${args.from}T00:00:00+02:00`) } : {}),
        ...(args.to ? { lt: new Date(new Date(`${args.to}T00:00:00+02:00`).getTime() + DAY) } : {}),
      }
    : null;
  // What's still to do is "planned". What HAPPENED is done too — a golf day on
  // 22 September is marked done afterwards and must still be found. Cancelled is
  // never shown (both spellings are in the data).
  const history = args.when === "past" || dated !== null;
  const take = args.limit ?? 15;
  // BLOCKED TIME IS ON THE CALENDAR. This search is what the assistant is told
  // IS the calendar, and it used to leave blocked time out of every answer — so
  // "what is in my calendar this week?" came back "nothing" for someone whose
  // Tuesday was blocked (Sean, 2026-10-11). It is left out only of the two
  // WORK lists, where it does not belong: time off is never "overdue" and is
  // not something to get done today — whether or not dates were given with it.
  const workList = args.when === "overdue" || args.when === "today_and_overdue";
  const window: { gte?: Date; lt?: Date } = dated ?? range;
  const activities = await prisma.activity.findMany({
    where: {
      ...(ids === null ? {} : { id: { in: ids } }),
      status: history ? { notIn: CANCELLED } : "planned",
      ...(workList ? { availabilityBlock: false } : {}),
      ...(args.type ? { type: fuzzy(args.type) } : {}),
      AND: [
        // Everything is placed by when it STARTS — except blocked time, which
        // lasts: leave from Sunday to Wednesday is in Monday's week although it
        // began before it. The same overlap rule the calendar page draws by.
        {
          OR: [
            { dueDate: window },
            ...(!workList && window.gte ? [{ availabilityBlock: true, dueDate: { lt: window.gte }, endDate: { gt: window.gte } }] : []),
          ],
        },
        // Theirs, or a meeting they're an attendee of.
        ...(args.assignedTo
          ? [{ OR: [{ assignedTo: { name: fuzzy(args.assignedTo) } }, { attendees: { some: { user: { name: fuzzy(args.assignedTo) } } } }] }]
          : []),
        ...(args.search ? [{ OR: [{ summary: fuzzy(args.search) }, { note: fuzzy(args.search) }] }] : []),
      ],
    },
    // Most recent first when looking back with no dates ("what golf days did we have").
    orderBy: { dueDate: args.when === "overdue" || (args.when === "past" && !dated) ? "desc" : "asc" },
    take: take + 1,
    select: {
      id: true, type: true, summary: true, dueDate: true, endDate: true, allDay: true, availabilityBlock: true, status: true, leadId: true, contactId: true,
      assignedTo: { select: { name: true } },
      lead: { select: { name: true } },
    },
  });
  const page = activities.slice(0, take);
  const href = (a: (typeof activities)[number]) =>
    a.leadId ? `/leads/${a.leadId}` : a.contactId ? `/contacts/${a.contactId}` : "/activities";
  if (page.length === 0) {
    // "Nothing" with no dates reads as "nothing ever". Say what was looked at:
    // whose, which days, and that it means the calendar including blocked time.
    const day = (d: Date) => d.toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short" });
    const from = window.gte ? day(window.gte) : null;
    // `lt` is the first moment AFTER the window: its last day is the day before.
    const to = window.lt ? day(new Date(window.lt.getTime() - 1)) : null;
    const span = from && to ? (from === to ? `on ${from}` : `from ${from} to ${to}`) : from ? `from ${from} onwards` : to ? `up to ${to}` : "";
    return {
      truncated: false,
      rows: [],
      data: [{
        note: `Nothing ${history ? "recorded" : "planned"} ${span}${args.assignedTo ? ` for ${args.assignedTo}` : ""}${args.search ? ` matching "${args.search}"` : ""}${args.type ? ` of type ${args.type}` : ""} — no calls, meetings, to-dos or events${workList ? "" : ", and no blocked time"}. Give those dates in your answer.${history ? "" : " Completed items are not included: ask with \"past\" for what was done."}`,
      }],
    };
  }
  return {
    truncated: activities.length > take,
    data: page.map((a) => ({
      // The id is what a reschedule or cancel proposal names.
      id: a.id,
      link: href(a),
      type: a.availabilityBlock ? "blocked time" : a.type,
      summary: a.summary,
      due: dateKey(a.dueDate),
      // A calendar item has a time of day, and blocked time an end: "Tuesday, blocked 09:00–11:00".
      ...(a.allDay ? { allDay: true } : { time: saLocal(a.dueDate).slice(11) }),
      ...(a.availabilityBlock && a.endDate ? { until: a.allDay ? dateKey(new Date(a.endDate.getTime() - 1)) : saLocal(a.endDate).slice(11) } : {}),
      ...(a.availabilityBlock ? { blockedTime: true } : {}),
      ...(history ? { status: a.status } : {}),
      // Leave that began yesterday is not late.
      ...(a.status === "planned" && !a.availabilityBlock && a.dueDate < startOfToday ? { overdue: true } : {}),
      assignedTo: a.assignedTo.name,
      customer: a.lead?.name ?? null,
      leadId: a.leadId,
    })),
    rows: page.map((a) => ({
      label: a.summary,
      detail: `${a.type} · due ${dateKey(a.dueDate)} · ${a.assignedTo.name}`,
      href: href(a),
    })),
  };
}
