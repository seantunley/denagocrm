import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const DEFAULT_ACTIVITY_DURATION_MS = 60 * 60 * 1000;

export type StaffAvailabilityConflict = {
  userId: string;
  userName: string;
  start: Date;
  end: Date;
  summary: string;
  note: string | null;
};

type ScheduleDb = Pick<Prisma.TransactionClient, "activity" | "testDriveBooking" | "user">;

export type StaffCommitmentConflict = {
  userId: string;
  userName: string;
  start: Date;
  end: Date;
  summary: string;
};

export function intervalsOverlap(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): boolean {
  return startA < endB && endA > startB;
}

export function effectiveActivityEnd(start: Date, end: Date | null | undefined): Date {
  return end && end > start
    ? end
    : new Date(start.getTime() + DEFAULT_ACTIVITY_DURATION_MS);
}

function formatMoment(date: Date) {
  return date.toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function availabilityConflictMessage(conflict: StaffAvailabilityConflict): string {
  const detail = conflict.note?.trim() || conflict.summary;
  return `${conflict.userName} is unavailable from ${formatMoment(conflict.start)} to ${formatMoment(conflict.end)}${detail ? ` — ${detail}` : ""}. Choose another time or assign another team member.`;
}

export function commitmentConflictMessage(conflict: StaffCommitmentConflict): string {
  return `${conflict.userName} already has ${conflict.summary} from ${formatMoment(conflict.start)} to ${formatMoment(conflict.end)}. Move or cancel that booking before blocking this time.`;
}

export async function lockStaffSchedules(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of Array.from(new Set(userIds.filter(Boolean))).sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-schedule:${tenantId}:${userId}`})::bigint)`;
  }
}

export async function findStaffAvailabilityConflict(args: {
  userId: string;
  start: Date;
  end: Date;
  excludeActivityId?: string | null;
  db?: ScheduleDb;
}): Promise<StaffAvailabilityConflict | null> {
  if (!(args.end > args.start)) throw new Error("Availability check requires an end after the start.");

  const db = args.db ?? (prisma as unknown as ScheduleDb);
  const candidates = await db.activity.findMany({
    where: {
      assignedToId: args.userId,
      availabilityBlock: true,
      status: "planned",
      dueDate: { lt: args.end },
      ...(args.excludeActivityId ? { id: { not: args.excludeActivityId } } : {}),
    },
    select: {
      id: true,
      summary: true,
      note: true,
      dueDate: true,
      endDate: true,
      assignedTo: { select: { id: true, name: true } },
    },
    orderBy: { dueDate: "asc" },
    take: 50,
  });

  for (const block of candidates) {
    const blockEnd = effectiveActivityEnd(block.dueDate, block.endDate);
    if (!intervalsOverlap(args.start, args.end, block.dueDate, blockEnd)) continue;
    return {
      userId: block.assignedTo.id,
      userName: block.assignedTo.name,
      start: block.dueDate,
      end: blockEnd,
      summary: block.summary,
      note: block.note,
    };
  }
  return null;
}

/**
 * Used when somebody creates/moves an availability block. We refuse a block
 * that would silently cover an already-booked customer commitment.
 *
 * Primary test-drive salespeople are represented by their linked Activity and
 * are therefore caught by the first query. The second query exists for the
 * accompanying salesperson, who is a real attendee but has no second Activity.
 */
export async function findStaffCommitmentConflict(args: {
  userId: string;
  start: Date;
  end: Date;
  excludeActivityId?: string | null;
  db?: ScheduleDb;
}): Promise<StaffCommitmentConflict | null> {
  if (!(args.end > args.start)) throw new Error("Commitment check requires an end after the start.");

  const db = args.db ?? (prisma as unknown as ScheduleDb);
  const activities = await db.activity.findMany({
    where: {
      assignedToId: args.userId,
      availabilityBlock: false,
      status: "planned",
      dueDate: { lt: args.end },
      ...(args.excludeActivityId ? { id: { not: args.excludeActivityId } } : {}),
    },
    select: {
      id: true,
      summary: true,
      dueDate: true,
      endDate: true,
      assignedTo: { select: { id: true, name: true } },
    },
    orderBy: { dueDate: "asc" },
    take: 100,
  });

  for (const activity of activities) {
    const activityEnd = effectiveActivityEnd(activity.dueDate, activity.endDate);
    if (!intervalsOverlap(args.start, args.end, activity.dueDate, activityEnd)) continue;
    return {
      userId: activity.assignedTo.id,
      userName: activity.assignedTo.name,
      start: activity.dueDate,
      end: activityEnd,
      summary: activity.summary,
    };
  }

  const drive = await db.testDriveBooking.findFirst({
    where: {
      accompanyingSalespersonId: args.userId,
      deletedAt: null,
      status: { in: ["booked", "confirmed", "checked_out"] },
      scheduledStart: { lt: args.end },
      expectedReturnAt: { gt: args.start },
    },
    select: {
      reference: true,
      scheduledStart: true,
      expectedReturnAt: true,
    },
    orderBy: { scheduledStart: "asc" },
  });
  if (!drive) return null;

  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { id: true, name: true },
  });
  if (!user) return null;

  return {
    userId: user.id,
    userName: user.name,
    start: drive.scheduledStart,
    end: drive.expectedReturnAt,
    summary: `test drive ${drive.reference}`,
  };
}
