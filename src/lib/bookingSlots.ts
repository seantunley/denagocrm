import { addDays, format } from "date-fns";
import { prisma } from "./db";
import { getSetting } from "./settings";

export type SlotConfig = {
  times: string[]; // "08:00" …
  days: number[]; // 1=Mon … 7=Sun
  capacity: number;
  horizonDays: number;
};

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
  return new Date(`${date}T${time}:00`);
}

/** ISO weekday 1–7 for a yyyy-mm-dd. */
function isoDay(date: string): number {
  const d = new Date(`${date}T12:00:00`).getDay();
  return d === 0 ? 7 : d;
}

/** Availability for one day: each configured slot with taken/free state. */
export async function getDayAvailability(date: string) {
  const config = await getSlotConfig();
  if (!isoDayAllowed(date, config)) return { date, open: false, slots: [] as { time: string; available: boolean }[] };

  const dayStart = new Date(`${date}T00:00:00`);
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
      (a) => format(a.dueDate, "HH:mm") === time
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

/**
 * Books a slot atomically: re-checks capacity inside a transaction and throws
 * "SLOT_TAKEN" if it filled up in the meantime.
 */
export async function reserveSlot(input: {
  date: string;
  time: string;
  summary: string;
  note: string | null;
  contactId: string | null;
  leadId: string | null;
  userId: string;
}) {
  const config = await getSlotConfig();
  if (!config.times.includes(input.time)) throw new Error("SLOT_INVALID");
  if (!isoDayAllowed(input.date, config)) throw new Error("SLOT_INVALID");
  const dt = slotDateTime(input.date, input.time);
  if (isNaN(dt.getTime()) || dt <= new Date()) throw new Error("SLOT_INVALID");

  return prisma.$transaction(async (tx) => {
    const taken = await tx.activity.count({
      where: {
        category: "workshop",
        status: "planned",
        dueDate: dt,
      },
    });
    if (taken >= config.capacity) throw new Error("SLOT_TAKEN");
    return tx.activity.create({
      data: {
        type: "meeting",
        category: "workshop",
        summary: input.summary,
        note: input.note,
        dueDate: dt,
        contactId: input.contactId,
        leadId: input.leadId,
        assignedToId: input.userId,
        createdById: input.userId,
      },
    });
  });
}
