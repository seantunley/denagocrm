import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { TEST_DRIVE_INDEMNITY, type SubjectRow } from "./subject";

type Tx = Prisma.TransactionClient;
/** Only what a subject touches, so the signing hub's extended-client transaction fits as well as a plain one. */
type SubjectTx = {
  $executeRaw: Tx["$executeRaw"];
  testDriveBooking: {
    updateMany(args: {
      where: Prisma.TestDriveBookingWhereInput;
      data: Prisma.TestDriveBookingUpdateManyMutationInput;
    }): PromiseLike<{ count: number }>;
  };
};

/**
 * Lock the record a request is about — FIRST, before the request's own row.
 *
 * The same order as a quote or a job card (source record, then request), and the
 * order starting a new indemnity takes: it locks the booking and then voids the
 * request it replaces. Completing in the opposite order would have the two wait
 * on each other.
 *
 * The workspace is part of the lookup, not a check made afterwards: subjectId
 * has no foreign key, so the request's own tenant is the only thing that says
 * the row belongs with it.
 */
export async function lockSubject(tx: SubjectTx, req: SubjectRow): Promise<void> {
  if (req.subjectType !== TEST_DRIVE_INDEMNITY || !req.subjectId || !req.tenantId) return;
  await tx.$executeRaw`SELECT id FROM "TestDriveBooking" WHERE id = ${req.subjectId} AND "tenantId" = ${req.tenantId} FOR UPDATE`;
}

/**
 * What completing the request does to the record it is about, inside the
 * completion transaction — so "everyone signed" and "the booking says Signed"
 * commit together or not at all. True when THIS call made the change.
 *
 * Never refuses. A quote that was deleted or replaced stops its request from
 * completing, because the signature would be for something that no longer
 * exists. An indemnity is the driver's own undertaking and stands whatever
 * became of the booking: a cancelled or trashed one simply has nothing to mark.
 */
export async function completeSubject(tx: SubjectTx, req: SubjectRow): Promise<boolean> {
  if (req.subjectType !== TEST_DRIVE_INDEMNITY || !req.subjectId || !req.tenantId) return false;
  const marked = await tx.testDriveBooking.updateMany({
    where: { id: req.subjectId, tenantId: req.tenantId, deletedAt: null, indemnityStatus: { not: "signed" } },
    data: { indemnityStatus: "signed" },
  });
  return marked.count === 1;
}

/**
 * The booking's own audit entry for the change above. The signature itself is
 * already on the customer's timeline (the signing route writes that); this is
 * the record of what it did to the booking, where the booking's other changes are.
 */
export async function afterSubjectSigned(req: SubjectRow, signerName: string): Promise<void> {
  if (req.subjectType !== TEST_DRIVE_INDEMNITY || !req.subjectId || !req.tenantId) return;
  const booking = await prisma.testDriveBooking.findFirst({
    where: { id: req.subjectId, tenantId: req.tenantId },
    select: { id: true, reference: true, contactId: true, leadId: true },
  });
  if (!booking) return;
  await logAudit({
    action: "test_drive.indemnity_signed",
    summary: `Indemnity for ${booking.reference} signed by ${signerName} — the booking is marked Signed and the sealed copy is filed`,
    entityType: "TestDriveBooking",
    entityId: booking.id,
    contactId: booking.contactId,
    leadId: booking.leadId,
    userName: signerName,
  });
}
