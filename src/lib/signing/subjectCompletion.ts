import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { DELIVERY_NOTE, TEST_DRIVE_INDEMNITY, type SubjectRow } from "./subject";

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
 * order starting a new one takes: it locks the record and then voids the request
 * it replaces. Completing in the opposite order would have the two wait on each
 * other.
 *
 * The workspace is part of the lookup, not a check made afterwards: subjectId
 * has no foreign key, so the request's own tenant is the only thing that says
 * the row belongs with it.
 */
export async function lockSubject(tx: SubjectTx, req: SubjectRow): Promise<void> {
  if (!req.subjectId || !req.tenantId) return;
  if (req.subjectType === TEST_DRIVE_INDEMNITY) {
    await tx.$executeRaw`SELECT id FROM "TestDriveBooking" WHERE id = ${req.subjectId} AND "tenantId" = ${req.tenantId} FOR UPDATE`;
  } else if (req.subjectType === DELIVERY_NOTE) {
    await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${req.subjectId} AND "tenantId" = ${req.tenantId} FOR UPDATE`;
  }
}

/**
 * What completing the request does to the record it is about, inside the
 * completion transaction — so "everyone signed" and what follows from it commit
 * together or not at all. True when THIS call made a change.
 *
 * `signedDocumentId` is the sealed PDF's Document row, made a moment earlier in
 * the same transaction (null only when nobody could be named as its uploader).
 *
 * Never refuses. A quote that was deleted or replaced stops its own request
 * from completing, because the signature would be for something that no longer
 * exists. An indemnity is the driver's own undertaking, and a delivery note is
 * the customer's receipt: both stand whatever became of the record, which then
 * simply has nothing to mark.
 */
export async function completeSubject(tx: SubjectTx, req: SubjectRow, signedDocumentId: string | null): Promise<boolean> {
  if (!req.subjectId || !req.tenantId) return false;
  if (req.subjectType === TEST_DRIVE_INDEMNITY) {
    const marked = await tx.testDriveBooking.updateMany({
      where: { id: req.subjectId, tenantId: req.tenantId, deletedAt: null, indemnityStatus: { not: "signed" } },
      data: { indemnityStatus: "signed" },
    });
    return marked.count === 1;
  }
  if (req.subjectType === DELIVERY_NOTE) {
    // The sealed note is the delivery's paperwork: filed under the QUOTE, beside
    // its invoice and proof of payment — where the generic filing knows only the
    // customer. One statement, with the workspace named on both sides.
    //
    // Deliberately nothing else. Marking the quote delivered moves stock and
    // makes the customer's vehicles, behind gates only a member of staff can
    // answer for (lib/quoteDelivery.ts); that stays the delivery screen's own
    // step, taken with this signature as its evidence.
    if (!signedDocumentId) return false;
    const filed = await tx.$executeRaw`
      UPDATE "Document" d
         SET "quoteId" = ${req.subjectId}, "tag" = 'delivery-note'
       WHERE d."id" = ${signedDocumentId} AND d."tenantId" = ${req.tenantId}
         AND EXISTS (SELECT 1 FROM "Quote" q WHERE q."id" = ${req.subjectId} AND q."tenantId" = ${req.tenantId})
    `;
    return filed === 1;
  }
  return false;
}

/**
 * The record's own audit entry for the change above. The signature itself is
 * already on the customer's timeline (the signing route writes that); this is
 * the record of what it did, where the record's other changes are.
 */
export async function afterSubjectSigned(req: SubjectRow, signerName: string): Promise<void> {
  if (!req.subjectId || !req.tenantId) return;
  if (req.subjectType === TEST_DRIVE_INDEMNITY) {
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
  } else if (req.subjectType === DELIVERY_NOTE) {
    const quote = await prisma.quote.findFirst({
      where: { id: req.subjectId, tenantId: req.tenantId },
      select: { id: true, number: true, contactId: true, leadId: true },
    });
    if (!quote) return;
    await logAudit({
      action: "fulfilment.delivery_note_signed",
      summary: `Delivery note for Q-${quote.number} signed by ${signerName} — the sealed copy is filed with the quote`,
      entityType: "Quote",
      entityId: quote.id,
      contactId: quote.contactId,
      leadId: quote.leadId,
      userName: signerName,
    });
  }
}
