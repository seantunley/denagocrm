import { addDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { getSetting } from "./settings";
import { writeTenantId } from "./tenantWrite";
import {
  adoptsUnownedParents,
  bookingTenantId,
  bookingTenantWhere,
  slotLock,
} from "./bookingTenant";

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
  // WHOSE calendar this is. The read goes through the guarded client, but the guard
  // only filters while `tenantEnforcing()` is true — which it is not — so without
  // this predicate a second workshop's bookings make this workshop's slots read as
  // full, and vice versa. `writeTenantId()` throws when the scope has been LOST, so
  // this fails closed rather than falling back to every tenant's rows; it returns
  // null when the scope is GLOBAL, which the founding tenant stands in for.
  //
  // The SAME predicate is used by `claimSlotCapacity` below, deliberately: an
  // availability read that disagreed with the capacity count would offer a slot the
  // booker then refuses with SLOT_TAKEN.
  const tenantId = bookingTenantId(writeTenantId());
  const existing = await prisma.activity.findMany({
    where: {
      category: "workshop",
      status: "planned",
      dueDate: { gte: dayStart, lt: dayEnd },
      ...bookingTenantWhere(tenantId),
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
 * bookings can't both pass the count check and overfill the slot (the old
 * count-then-create had no lock — READ COMMITTED let both readers see the same
 * count). Throws "SLOT_TAKEN" when full. Does NOT create the activity — the
 * caller creates it (and any contact/job card) in the same transaction so a full
 * slot rolls everything back.
 *
 * TENANT SCOPING: this runs on `basePrisma` (the guard does NOT scope it), so both
 * the lock and the count are namespaced by `tenantId` EXPLICITLY, and `tenantId` is
 * ALWAYS a real tenant — `bookingTenantId()` resolves the global/dormant null to the
 * founding tenant. It used to be nullable, and null meant "no namespace, no filter":
 * one tenant's bookings consumed another's capacity and contended on its lock, and
 * the count disagreed with what `getDayAvailability()` showed the customer.
 *
 * The count uses the SAME predicate as that read (`bookingTenantWhere`), which keeps
 * counting legacy tenantless rows for the founding tenant. That is not sloppiness —
 * a count that stopped seeing them would report a taken slot as free and double-book
 * the workshop. See src/lib/bookingTenant.ts for why the NULL arm outlives the
 * backfill migration.
 */
export async function claimSlotCapacity(
  tx: Prisma.TransactionClient,
  dt: Date,
  capacity: number,
  tenantId: string
): Promise<void> {
  const instant = Math.floor(dt.getTime() / 1000);
  const lock = slotLock(tenantId, instant);
  if (lock.kind === "tenant") {
    // Per-tenant lock namespace: the same instant in two tenants is two slots.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lock.key})::bigint)`;
  } else {
    // The founding tenant keeps the pre-tenancy key so a rolling deploy never has
    // two instances holding different locks for the same slot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BigInt(lock.instant)})`;
  }
  const taken = await tx.activity.count({
    where: {
      category: "workshop",
      status: "planned",
      dueDate: dt,
      ...bookingTenantWhere(tenantId),
    },
  });
  if (taken >= capacity) throw new Error("SLOT_TAKEN");
}

/**
 * Adopt a booking's still-un-owned parent rows into `tenantId` before a STAMPED
 * activity is written against them.
 *
 * 20260727140000_composite_tenant_fks added composite tenant foreign keys —
 * `Activity("tenantId","contactId") -> Contact("tenantId","id")` and the same for
 * Lead — and they are MATCH SIMPLE: a NULL "tenantId" satisfies them trivially,
 * which is the only reason today's tenantless bookings are legal. Stamping the
 * activity makes the check REAL, so an activity stamped with the founding tenant
 * whose contact is still un-owned is refused and the booking 500s. The backfill
 * migration clears every row that exists when it runs, but it cannot keep them
 * clear: while enforcement is dormant an ordinary `prisma.contact.create` (the
 * chatbot's `ensureContact`, the CRM's own new-contact form) still writes
 * tenantless rows the next booking may link to.
 *
 * `tenantId: null` in every WHERE means ANOTHER tenant's record is never adopted —
 * a genuinely cross-tenant link stays a hard foreign-key refusal. And the caller
 * only runs this while the scope is global (see `adoptsUnownedParents`): under
 * enforcement the guard stamps parents itself and an unresolvable link must fail.
 *
 * Ordered parents-first, because adopting a Lead re-checks Lead -> PipelineStage /
 * Product / Contact. Every statement matches zero rows in steady state.
 */
async function adoptUnownedBookingParents(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string | null,
  leadId: string | null
): Promise<void> {
  if (leadId) {
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
      select: { tenantId: true, stageId: true, productId: true, contactId: true },
    });
    if (lead && lead.tenantId === null) {
      await tx.pipelineStage.updateMany({ where: { id: lead.stageId, tenantId: null }, data: { tenantId } });
      if (lead.productId) {
        await tx.product.updateMany({ where: { id: lead.productId, tenantId: null }, data: { tenantId } });
      }
      if (lead.contactId) {
        await tx.contact.updateMany({ where: { id: lead.contactId, tenantId: null }, data: { tenantId } });
      }
      await tx.lead.updateMany({ where: { id: leadId, tenantId: null }, data: { tenantId } });
    }
  }
  if (contactId) {
    await tx.contact.updateMany({ where: { id: contactId, tenantId: null }, data: { tenantId } });
  }
}

/**
 * Books a slot atomically: re-checks capacity under an advisory lock inside a
 * transaction and throws "SLOT_TAKEN" if it filled up in the meantime.
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
}) {
  const config = await getSlotConfig();
  const dt = slotInstantOrThrow(input.date, input.time, config);
  // Namespace the slot capacity by the caller's tenant, and STAMP the workshop
  // activity — reserveSlot runs on basePrisma, so the guard will never do either,
  // and it will never do it retrospectively once enforcement is switched on either.
  // `scoped` is null on every request today (the scope is GLOBAL while enforcement
  // is dormant); the previous `...(tenantId ? { tenantId } : {})` therefore stamped
  // NOTHING, and every chatbot and staff-scheduled workshop booking landed
  // tenantless for ever, to be filed under the founding tenant by statistics.ts.
  const scoped = writeTenantId();
  const tenantId = bookingTenantId(scoped);

  return basePrisma.$transaction(async (tx) => {
    await claimSlotCapacity(tx, dt, config.capacity, tenantId);
    // The stamp below makes the composite tenant FKs to Contact/Lead real; this
    // brings any parent the dormant guard left un-owned along with it. No-op once
    // enforcement is on, and never touches another tenant's row.
    if (adoptsUnownedParents(scoped)) {
      await adoptUnownedBookingParents(tx, tenantId, input.contactId, input.leadId);
    }
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
        tenantId,
      },
    });
  });
}
