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
        status: "planned",
        leadId: input.leadId,
        contactId: input.contactId,
        assignedToId: input.salespersonId,
        createdById: input.createdById,
        tenantId: input.activityTenantId,
      },
    });
  }
  return tx.testDriveBooking.create({
    data: {
      tenantId: input.bookingTenantId,
      reference: newTestDriveReference(),
      status: "booked",
      leadId: input.leadId,
      contactId: input.contactId,
      branch: input.branch,
      demoVehicleId: input.demoVehicleId,
      productId: input.productId,
      salespersonId: input.salespersonId,
      accompanyingSalespersonId: input.accompanyingSalespersonId,
      activityId,
      scheduledStart: input.scheduledStart,
      expectedReturnAt: input.expectedReturnAt,
    },
  });
}

/** Booking statuses that are still ahead of the customer — the ones a reschedule or move-back acts on. */
export const UPCOMING_TEST_DRIVE_STATUSES = ["booked", "confirmed"];
