import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { contactName } from "../../format";
import { johannesburgDateKey } from "../../activityDay";
import { listActingTenantStaff } from "../../tenantActor";
import { getAccessibleActivityIds } from "../../activityAccess";
import { isModuleEnabled } from "../../modules/enabled";
import { accessibleTestDriveWhere } from "../../testDriveAccess";
import { hasAnyPermission } from "../../permissions";
import { scheduleArgs } from "../../crmAssistantPlan";
import { DAY, ToolOutput, User, refused } from "../lookupKit";

/** "Tue 7 Oct 10:00" in South African time. */
export const when = (d: Date) =>
  d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const nameOfContact = (c: { firstName: string; lastName: string | null } | null | undefined) => (c ? contactName(c) : null);

/**
 * Which activities `schedule` shows. It is the AVAILABILITY tool: what is still
 * planned is busy time. A meeting later today can be marked done early (the
 * completion guard only blocks future days), so a done activity that hasn't
 * ended yet is NOT busy — it would make DAX turn down a free slot. A done
 * activity wholly in the past is history ("what was on 22 September"), shown
 * with its status. Cancelled never shows.
 */
export function scheduleStatusWhere(now: Date) {
  return {
    OR: [
      { status: "planned" },
      { status: "done", OR: [{ endDate: { lt: now } }, { endDate: null, dueDate: { lt: now } }] },
    ],
  };
}

/**
 * Who is busy when — meetings, blocked time and test drives (with their demo
 * vehicle) — so a suggested time never clashes. Through the calendar's own
 * visibility (getAccessibleActivityIds, accessibleTestDriveWhere). A blocked-out
 * slot shows as "busy", never its private reason.
 */
export async function schedule(user: User, raw: z.infer<typeof scheduleArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return refused("the calendar");
  const args = scheduleArgs.parse(raw);
  const start = new Date(`${args.from ?? johannesburgDateKey(new Date())}T00:00:00+02:00`);
  const end = new Date(start.getTime() + (args.days ?? 3) * DAY);
  const staff = await listActingTenantStaff();
  const wanted = args.person?.toLowerCase();
  const person = wanted ? staff.find((s) => s.name.toLowerCase() === wanted) ?? staff.find((s) => s.name.toLowerCase().startsWith(wanted)) : null;
  if (args.person && !person) return { truncated: false, rows: [], data: [{ note: `No one called "${args.person}" in this workspace.` }] };

  const ids = await getAccessibleActivityIds(user);
  const activities = await prisma.activity.findMany({
    where: {
      ...(ids === null ? {} : { id: { in: ids } }),
      dueDate: { lt: end },
      AND: [
        scheduleStatusWhere(new Date()),
        { OR: [{ endDate: { gte: start } }, { endDate: null, dueDate: { gte: start } }] },
        person ? { OR: [{ assignedToId: person.id }, { attendees: { some: { userId: person.id } } }] } : {},
      ],
    },
    orderBy: { dueDate: "asc" },
    take: 80,
    select: {
      type: true, summary: true, status: true, dueDate: true, endDate: true, allDay: true, availabilityBlock: true,
      assignedTo: { select: { name: true } },
      attendees: { select: { user: { select: { name: true } } } },
    },
  });

  let testDrives: { reference: string; status: string; scheduledStart: Date; expectedReturnAt: Date; salespersonId: string; contactId: string; demoVehicle: { name: string } | null }[] = [];
  if (await isModuleEnabled("automotive")) {
    testDrives = await prisma.testDriveBooking.findMany({
      where: {
        deletedAt: null,
        ...(await accessibleTestDriveWhere(user)),
        status: { notIn: ["cancelled", "no_show"] },
        scheduledStart: { lt: end },
        expectedReturnAt: { gte: start },
        ...(person ? { OR: [{ salespersonId: person.id }, { accompanyingSalespersonId: person.id }] } : {}),
      },
      orderBy: { scheduledStart: "asc" },
      take: 40,
      select: { reference: true, status: true, scheduledStart: true, expectedReturnAt: true, salespersonId: true, contactId: true, demoVehicle: { select: { name: true } } },
    });
  }
  const contacts = testDrives.length
    ? new Map((await prisma.contact.findMany({ where: { id: { in: testDrives.map((t) => t.contactId) } }, select: { id: true, firstName: true, lastName: true } })).map((c) => [c.id, c]))
    : new Map();
  const staffName = new Map(staff.map((s) => [s.id, s.name]));

  return {
    truncated: activities.length === 80,
    data: [{
      window: `${johannesburgDateKey(start)} to ${johannesburgDateKey(new Date(end.getTime() - 1))}`,
      ...(person ? { person: person.name } : {}),
      busy: activities.map((a) => ({
        from: when(a.dueDate),
        until: a.endDate ? when(a.endDate) : null,
        allDay: a.allDay,
        what: a.availabilityBlock ? "busy (blocked out)" : `${a.type}: ${a.summary}`,
        ...(a.availabilityBlock ? {} : { status: a.status }),
        people: [a.assignedTo.name, ...a.attendees.map((x) => x.user.name)],
      })),
      testDrives: testDrives.map((t) => ({
        ref: t.reference,
        status: t.status,
        from: when(t.scheduledStart),
        until: when(t.expectedReturnAt),
        vehicle: t.demoVehicle?.name ?? "no demo vehicle set",
        salesperson: staffName.get(t.salespersonId) ?? null,
        customer: nameOfContact(contacts.get(t.contactId)),
      })),
    }],
    rows: [{ label: "Calendar", detail: `${activities.length} commitments · ${testDrives.length} test drives`, href: "/calendar" }],
  };
}
