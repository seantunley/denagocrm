import { addDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { getSetting } from "./settings";
import { writeTenantId } from "./tenantWrite";

export type SlotConfig = {
  times: string[];
  days: number[];
  capacity: number;
  horizonDays: number;
};

export async function getSlotConfig(): Promise<SlotConfig> {
  const [times, days, capacity, horizon] = await Promise.all([
    getSetting("BOOKING_SLOT_TIMES"), getSetting("BOOKING_DAYS"),
    getSetting("BOOKING_CAPACITY"), getSetting("BOOKING_HORIZON_DAYS"),
  ]);
  return {
    times: (times ?? "08:00,10:00,12:00,14:00").split(",").map((t) => t.trim()).filter((t) => /^\d{2}:\d{2}$/.test(t)),
    days: (days ?? "1,2,3,4,5").split(",").map((d) => parseInt(d.trim(), 10)).filter((d) => d >= 1 && d <= 7),
    capacity: Math.max(1, parseInt(capacity ?? "1", 10) || 1),
    horizonDays: Math.max(1, parseInt(horizon ?? "30", 10) || 30),
  };
}

export function slotDateTime(date: string, time: string): Date { return new Date(`${date}T${time}:00+02:00`); }
function johannesburgTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false });
}
function isoDay(date: string): number {
  const d = new Date(`${date}T12:00:00+02:00`).getUTCDay();
  return d === 0 ? 7 : d;
}

export async function getDayAvailability(date: string) {
  const config = await getSlotConfig();
  if (!isoDayAllowed(date, config)) return { date, open: false, slots: [] as { time: string; available: boolean }[] };
  const dayStart = new Date(`${date}T00:00:00+02:00`);
  const dayEnd = addDays(dayStart, 1);
  const existing = await prisma.activity.findMany({
    where: { category: "workshop", status: "planned", dueDate: { gte: dayStart, lt: dayEnd } },
    select: { dueDate: true },
  });
  const now = new Date();
  const slots = config.times.map((time) => {
    const dt = slotDateTime(date, time);
    const takenCount = existing.filter((activity) => johannesburgTime(activity.dueDate) === time).length;
    return { time, available: takenCount < config.capacity && dt > now };
  });
  return { date, open: true, slots };
}

export function isoDayAllowed(date: string, config: SlotConfig): boolean { return config.days.includes(isoDay(date)); }
export function slotInstantOrThrow(date: string, time: string, config: SlotConfig): Date {
  if (!config.times.includes(time) || !isoDayAllowed(date, config)) throw new Error("SLOT_INVALID");
  const dt = slotDateTime(date, time);
  if (isNaN(dt.getTime()) || dt <= new Date()) throw new Error("SLOT_INVALID");
  return dt;
}

export async function claimSlotCapacity(
  tx: Prisma.TransactionClient,
  dt: Date,
  capacity: number,
  tenantId: string | null,
): Promise<void> {
  const instant = Math.floor(dt.getTime() / 1000);
  if (tenantId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`slot:${tenantId}:${instant}`})::bigint)`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BigInt(instant)})`;
  const taken = await tx.activity.count({
    where: { category: "workshop", status: "planned", dueDate: dt, ...(tenantId ? { tenantId } : {}) },
  });
  if (taken >= capacity) throw new Error("SLOT_TAKEN");
}

/**
 * Books a slot atomically. `dedupeMarker`, when present, lives in the Activity
 * written by the effect itself. On a provider retry we find that same Activity
 * under the slot transaction before consuming capacity again.
 */
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
  dedupeMarker?: string | null;
}) {
  const config = await getSlotConfig();
  const dt = slotInstantOrThrow(input.date, input.time, config);
  const tenantId = writeTenantId();

  return basePrisma.$transaction(async (tx) => {
    if (input.dedupeMarker) {
      // The marker lives in free text with no unique constraint behind it, so this
      // read is advisory. Lock the marker BEFORE reading it: claimSlotCapacity's
      // lock only serialises capacity, so without this two concurrent retries of
      // the same action could both miss the marker and both book — visible
      // whenever the slot has room for more than one.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-slot:${tenantId ?? "global"}:${input.dedupeMarker}`})::bigint)`;
      const existing = await tx.activity.findFirst({
        where: {
          category: "workshop",
          note: { contains: input.dedupeMarker },
          ...(tenantId ? { tenantId } : {}),
        },
      });
      if (existing) return existing;
    }

    await claimSlotCapacity(tx, dt, config.capacity, tenantId);
    const note = [input.note, input.dedupeMarker].filter(Boolean).join("\n") || null;
    return tx.activity.create({
      data: {
        type: input.type ?? "meeting",
        category: "workshop",
        summary: input.summary,
        note,
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
