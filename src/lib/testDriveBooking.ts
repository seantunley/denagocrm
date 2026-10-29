import crypto from "crypto";
import type { prisma } from "./db";

/**
 * THE ONE WAY A TEST DRIVE IS BOOKED.
 *
 * There used to be two: the Test drives module created a TestDriveBooking (with
 * its calendar activity), and the pipeline board's "Book test drive" created only
 * a calendar activity. A board booking therefore never appeared under Test
 * drives, so the licence check, identity check, indemnity, checkout and return
 * — all of which hang off the booking — never happened for it (gap audit #19).
 * Both doors now come through here.
 */

/** A board booking only picks a start time; this is how long the car is out by default. */
export const DEFAULT_TEST_DRIVE_MINUTES = 60;

export function newTestDriveReference(): string {
  return `TD-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

type Tx = Pick<typeof prisma, "testDriveBooking" | "activity">;

export type NewTestDrive = {
  /** Owner of the booking — the acting workspace, stamped explicitly. */
  bookingTenantId: string | null;
  /** Owner of the calendar activity — agreed between its lead and contact. */
  activityTenantId: string | null;
  leadId: string | null;
  contactId: string;
  branch: string;
  demoVehicleId: string | null;
  productId: string | null;
  salespersonId: string;
  accompanyingSalespersonId: string | null;
  scheduledStart: Date;
  expectedReturnAt: Date;
  /** Calendar entry wording. */
  summary: string;
  note: string;
  createdById: string;
  /**
   * An existing planned test-drive activity to attach instead of creating a
   * second one — a board booking made before bookings existed, so the lead
   * doesn't end up with two calendar entries for one drive. The caller brings
   * that activity up to date in its own (guarded) transaction.
   */
  adoptActivityId?: string | null;
};

/** Create the booking and (unless one is adopted) its calendar activity. Call inside the caller's transaction. */
export async function createBookedTestDrive(tx: Tx, input: NewTestDrive) {
  const activityId = input.adoptActivityId ?? crypto.randomUUID();
  if (!input.adoptActivityId) {
    await tx.activity.create({
      data: {
        id: activityId,
        type: "test_drive",
        summary: input.summary,
        note: input.note,
        location: input.branch,
        dueDate: input.scheduledStart,
        endDate: input.expectedReturnAt,
        status: "planned",
        leadId: input.leadId,
        contactId: input.contactId,
        assignedToId: input.salespersonId,
        createdById: input.createdById,
        tenantId: input.activityTenantId,
      },
    });
  }
  /*
   * THE ACTIVITY'S TRIGGER HAS ALREADY MADE A BOOKING FOR IT. "Activity_sync_test_drive_booking"
   * (migration 20260724130000, for the older calendar and board flows) inserts a TestDriveBooking for every
   * test-drive activity with a customer — so a plain create here was a second booking for the same activity,
   * refused by the unique activityId, and every booking failed ("The operation did not complete cleanly"). Found
   * by DAX's calendar test (scripts/test-dax-calendar.ts), 2026-10-29: no test had ever booked through this door.
   * This booking is the module's, with what the trigger cannot know (the demo vehicle, the model, both
   * salespeople, the return time), so it takes that row over; with no trigger row it is created.
   */
  const booking = {
    reference: newTestDriveReference(),
    status: "booked",
    leadId: input.leadId,
    contactId: input.contactId,
    branch: input.branch,
    demoVehicleId: input.demoVehicleId,
    productId: input.productId,
    salespersonId: input.salespersonId,
    accompanyingSalespersonId: input.accompanyingSalespersonId,
    scheduledStart: input.scheduledStart,
    expectedReturnAt: input.expectedReturnAt,
  };
  // The workspace from the session, on both branches — the trigger's row took the activity's.
  return tx.testDriveBooking.upsert({
    where: { activityId },
    create: { ...booking, tenantId: input.bookingTenantId, activityId },
    update: { ...booking, tenantId: input.bookingTenantId },
  });
}

/** Booking statuses that are still ahead of the customer — the ones a reschedule or move-back acts on. */
export const UPCOMING_TEST_DRIVE_STATUSES = ["booked", "confirmed"];

/**
 * Why this demo vehicle can't be out from `start` to `end`, or null if it can.
 * Every door that books or moves a booking asks this — the board's reschedule
 * once skipped it and double-booked a car the module had already given away.
 */
export async function demoVehicleUnavailable(
  db: Pick<typeof prisma, "demoVehicle" | "testDriveBooking">,
  args: {
    /** The booking's workspace — named in both reads, whatever client `db` is. */
    tenantId: string | null;
    demoVehicleId: string | null;
    start: Date;
    end: Date;
    excludeBookingId?: string;
  },
): Promise<string | null> {
  if (!args.demoVehicleId) return null;
  const vehicle = await db.demoVehicle.findFirst({
    where: { id: args.demoVehicleId, tenantId: args.tenantId, deletedAt: null },
  });
  if (!vehicle || vehicle.status !== "active") return "That demo vehicle is not available";
  const overlap = await db.testDriveBooking.findFirst({
    where: {
      tenantId: args.tenantId,
      id: args.excludeBookingId ? { not: args.excludeBookingId } : undefined,
      demoVehicleId: args.demoVehicleId,
      deletedAt: null,
      status: { in: ["booked", "confirmed", "checked_out"] },
      scheduledStart: { lt: args.end },
      expectedReturnAt: { gt: args.start },
    },
    select: { reference: true },
  });
  return overlap ? `The demo vehicle is already booked on ${overlap.reference}` : null;
}
