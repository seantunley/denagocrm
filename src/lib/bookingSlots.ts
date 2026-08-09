import { addDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { getSetting } from "./settings";
import { writeTenantId } from "./tenantWrite";

export type SlotConfig = {
  times: string[]; // "08:00" …
  days: number[]; // 1=Mon … 7=Sun
  capacity: number;
  horizonDays: number;
};

export type WorkshopBookingOwner = { contactId: string | null; leadId: string | null };

export async function getSlotConfig(): Promise<SlotConfig> {
  const [times, days, capacity, horizon] = await Promise.all([
    getSetting("BOOKING_SLOT_TIMES"),
    getSetting("BOOKING_DAYS"),
    getSetting("BOOKING_CAPACITY"),
    getSetting("BOOKING_HORIZON_DAYS"),
  ]);
  return {
    times: (times ?? "08:00,10:00,12:00,14:00")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => /^\d{2}:\d{2}$/.test(t)),
    days: (days ?? "1,2,3,4,5")
      .split(",")
      .map((d) => parseInt(d.trim(), 10))
      .filter((d) => d >= 1 && d <= 7),
    capacity: Math.max(1, parseInt(capacity ?? "1", 10) || 1),
    horizonDays: Math.max(1, parseInt(horizon ?? "30", 10) || 30),
  };
}

export function slotDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+02:00`);
}

function johannesburgTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** ISO weekday 1–7 for a yyyy-mm-dd. */
function isoDay(date: string): number {
  const d = new Date(`${date}T12:00:00+02:00`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Availability for one day: each configured slot with taken/free state. */
export async function getDayAvailability(date: string) {
  const config = await getSlotConfig();
  if (!isoDayAllowed(date, config)) {
    return {
      date,
      open: false,
      slots: [] as { time: string; available: boolean }[],
    };
  }

  const dayStart = new Date(`${date}T00:00:00+02:00`);
  const dayEnd = addDays(dayStart, 1);
  const existing = await prisma.activity.findMany({
    where: {
      category: "workshop",
      status: "planned",
      dueDate: { gte: dayStart, lt: dayEnd },
    },
    select: { dueDate: true },
  });

  const now = new Date();
  const slots = config.times.map((time) => {
    const dt = slotDateTime(date, time);
    const takenCount = existing.filter(
      (activity) => johannesburgTime(activity.dueDate) === time,
    ).length;
    return {
      time,
      available: takenCount < config.capacity && dt > now,
    };
  });
  return { date, open: true, slots };
}

export function isoDayAllowed(date: string, config: SlotConfig): boolean {
  return config.days.includes(isoDay(date));
}

/** Validate a requested slot, returning its instant or throwing "SLOT_INVALID". */
export function slotInstantOrThrow(date: string, time: string, config: SlotConfig): Date {
  if (!config.times.includes(time)) throw new Error("SLOT_INVALID");
  if (!isoDayAllowed(date, config)) throw new Error("SLOT_INVALID");
  const dt = slotDateTime(date, time);
  if (isNaN(dt.getTime()) || dt <= new Date()) throw new Error("SLOT_INVALID");
  return dt;
}

/**
 * Claim capacity for a slot inside an existing transaction. Takes a
 * transaction-scoped advisory lock keyed on the slot instant so two concurrent
 * bookings can't both pass the count check and overfill the slot.
 */
export async function claimSlotCapacity(
  tx: Prisma.TransactionClient,
  dt: Date,
  capacity: number,
  tenantId: string | null
): Promise<void> {
  const instant = Math.floor(dt.getTime() / 1000);
  if (tenantId) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`slot:${tenantId}:${instant}`})::bigint)`;
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BigInt(instant)})`;
  }
  const taken = await tx.activity.count({
    where: {
      category: "workshop",
      status: "planned",
      dueDate: dt,
      ...(tenantId ? { tenantId } : {}),
    },
  });
  if (taken >= capacity) throw new Error("SLOT_TAKEN");
}

async function lockWorkshopBooking(
  tx: Prisma.TransactionClient,
  bookingId: string,
  tenantId: string | null,
): Promise<void> {
  const namespace = `workshop-booking:${tenantId ?? "global"}:${bookingId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${namespace})::bigint)`;
}

function ownerWhere(owner: WorkshopBookingOwner) {
  const OR: ({ contactId: string } | { leadId: string })[] = [];
  if (owner.contactId) OR.push({ contactId: owner.contactId });
  if (owner.leadId) OR.push({ leadId: owner.leadId });
  return OR.length ? { OR } : null;
}

/** Books a slot atomically under the slot-capacity lock. */
export async function reserveSlot(input: {
  date: string;
  time: string;
  summary: string;
  note: string | null;
  contactId: string | null;
  leadId: string | null;
  userId: string;
  assignedToId?: string | null;
  type?: string | null;
  location?: string | null;
}) {
  const config = await getSlotConfig();
  const dt = slotInstantOrThrow(input.date, input.time, config);
  const tenantId = writeTenantId();

  return basePrisma.$transaction(async (tx) => {
    await claimSlotCapacity(tx, dt, config.capacity, tenantId);
    return tx.activity.create({
      data: {
        type: input.type ?? "meeting",
        category: "workshop",
        summary: input.summary,
        note: input.note,
        dueDate: dt,
        location: input.location ?? null,
        contactId: input.contactId,
        leadId: input.leadId,
        assignedToId: input.assignedToId ?? input.userId,
        createdById: input.userId,
        ...(tenantId ? { tenantId } : {}),
      },
    });
  });
}

/**
 * Cancel one customer-owned future workshop booking while holding a per-booking
 * lock. This serialises cancel-vs-reschedule races and retains the Activity row.
 */
export async function cancelWorkshopBooking(input: {
  bookingId: string;
  owner: WorkshopBookingOwner;
}): Promise<{ ok: boolean; alreadyCancelled?: boolean; dueDate?: Date; summary?: string }> {
  const scope = ownerWhere(input.owner);
  if (!scope) return { ok: false };
  const tenantId = writeTenantId();
  return basePrisma.$transaction(async (tx) => {
    await lockWorkshopBooking(tx, input.bookingId, tenantId);
    const existing = await tx.activity.findFirst({
      where: {
        id: input.bookingId,
        category: "workshop",
        dueDate: { gte: new Date() },
        ...(tenantId ? { tenantId } : {}),
        ...scope,
      },
      select: { id: true, status: true, dueDate: true, summary: true },
    });
    if (!existing?.dueDate) return { ok: false };
    if (existing.status === "cancelled") return { ok: true, alreadyCancelled: true, dueDate: existing.dueDate, summary: existing.summary };
    if (existing.status !== "planned") return { ok: false };
    await tx.activity.update({ where: { id: existing.id }, data: { status: "cancelled" } });
    return { ok: true, dueDate: existing.dueDate, summary: existing.summary };
  });
}

/**
 * Atomically MOVE an existing customer-owned booking. We first serialise all
 * mutations of that booking, then claim the destination slot capacity under the
 * same transaction, then update the existing Activity row. There is never a
 * second live booking and therefore no crash window between "book new" and
 * "cancel old".
 */
export async function rescheduleWorkshopBooking(input: {
  bookingId: string;
  date: string;
  time: string;
  owner: WorkshopBookingOwner;
}): Promise<{ ok: boolean; dueDate?: Date; summary?: string }> {
  const scope = ownerWhere(input.owner);
  if (!scope) return { ok: false };
  const config = await getSlotConfig();
  const destination = slotInstantOrThrow(input.date, input.time, config);
  const tenantId = writeTenantId();

  return basePrisma.$transaction(async (tx) => {
    await lockWorkshopBooking(tx, input.bookingId, tenantId);
    const existing = await tx.activity.findFirst({
      where: {
        id: input.bookingId,
        category: "workshop",
        status: "planned",
        dueDate: { gte: new Date() },
        ...(tenantId ? { tenantId } : {}),
        ...scope,
      },
      select: { id: true, dueDate: true, summary: true },
    });
    if (!existing?.dueDate) return { ok: false };
    if (existing.dueDate.getTime() === destination.getTime()) {
      return { ok: true, dueDate: existing.dueDate, summary: existing.summary };
    }

    await claimSlotCapacity(tx, destination, config.capacity, tenantId);
    const moved = await tx.activity.update({
      where: { id: existing.id },
      data: { dueDate: destination },
      select: { dueDate: true, summary: true },
    });
    return { ok: true, dueDate: moved.dueDate ?? destination, summary: moved.summary };
  });
}
