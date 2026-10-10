import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ActionRefusal } from "@/lib/actionFailure";
import { contactName } from "@/lib/format";
import { getRegionalSettings } from "@/lib/settings";
import { printableRecordLayout } from "@/lib/docbuilder/leadWarrantyRecords";
import { buildTestDriveContext } from "@/lib/docbuilder/leadWarrantyContext";
import type { MergeContext } from "@/lib/docbuilder/merge";
import type { DocumentModel } from "@/lib/doceditor/model";
import { indemnityTemplateForScreen } from "@/lib/doceditor/standardTemplates";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { staffActor } from "@/lib/signing/events";
import { TEST_DRIVE_INDEMNITY } from "@/lib/signing/subject";
import {
  openSubjectRequest,
  recordSubjectWithdrawn,
  signedByCustomerOnly,
  subjectSigningState,
  withdrawOpenSubjectRequests,
  type SubjectSigningState,
} from "@/lib/signing/subjectRequests";
import { UPCOMING_TEST_DRIVE_STATUSES } from "@/lib/testDriveBooking";

/**
 * A test drive's indemnity, signed on a screen.
 *
 * The indemnity was a printed form and a dropdown someone remembered to change.
 * Here it is a signature request ABOUT the booking (signing/subject.ts): the
 * driver signs on the device they are handed, and completing it marks the
 * booking Signed in the same transaction that seals the document
 * (signing/subjectCompletion.ts).
 *
 * One live indemnity per booking, by the rules every such request shares
 * (signing/subjectRequests.ts): starting one replaces any that was opened and
 * not signed, so the document always carries today's date and the customer's
 * details as they are now — they are frozen into the request when it is made.
 */

/** Where a booking's indemnity stands, as far as signing on a screen goes. */
export type IndemnityState = SubjectSigningState;

const indemnityOf = (bookingId: string) => ({ type: TEST_DRIVE_INDEMNITY, id: bookingId });

export function indemnityState(bookingId: string): Promise<IndemnityState> {
  return subjectSigningState(indemnityOf(bookingId));
}

/**
 * Withdraw a booking's indemnity that was opened and never signed — the test
 * drive was cancelled, missed, or went out on an indemnity recorded by hand.
 * Inside the caller's transaction, AFTER it holds the booking row. One with a
 * signature on it is left alone.
 */
export function withdrawOpenIndemnity(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  booking: { id: string; tenantId: string | null },
): Promise<string[]> {
  return withdrawOpenSubjectRequests(tx, indemnityOf(booking.id), booking.tenantId);
}

/** The evidence entry for each request {@link withdrawOpenIndemnity} closed. */
export function recordIndemnityWithdrawn(requestIds: string[], actor: string, reason: string): Promise<void> {
  return recordSubjectWithdrawn(requestIds, actor, "test_drive", reason);
}

/**
 * Make the indemnity for a booking and leave it waiting for the driver.
 *
 * The caller has already decided this person may manage the booking. Refusals
 * come back as messages for the booking screen.
 */
export async function prepareIndemnity(
  bookingId: string,
  user: { id: string; name: string; email?: string | null },
  /** The unsigned PDF. It is rendered by a browser process, so the database test brings its own. */
  toPdf: (doc: DocumentModel, context: MergeContext, tenantId: string) => Promise<Buffer> = (doc, context, tenantId) =>
    renderEnvelopePdf(doc, null, null, { context, tenantId }),
): Promise<{ requestId: string; replaced: string[] }> {
  const booking = await prisma.testDriveBooking.findFirst({
    where: { id: bookingId, deletedAt: null },
    include: { demoVehicle: true },
  });
  // The scoped read above is what says the booking is this workspace's; the
  // tenant it names is then written on everything made for it.
  const tenantId = booking?.tenantId;
  if (!booking || !tenantId) throw new ActionRefusal("Test-drive booking not found");
  if (!UPCOMING_TEST_DRIVE_STATUSES.includes(booking.status)) {
    throw new ActionRefusal("The indemnity is signed before the vehicle goes out — this test drive is no longer upcoming.");
  }

  const [contact, lead, product, regional] = await Promise.all([
    prisma.contact.findFirst({ where: { id: booking.contactId, deletedAt: null } }),
    booking.leadId ? prisma.lead.findFirst({ where: { id: booking.leadId }, select: { title: true, status: true, source: true } }) : null,
    booking.productId ? prisma.product.findFirst({ where: { id: booking.productId }, select: { name: true } }) : null,
    getRegionalSettings(),
  ]);
  if (!contact || contact.tenantId !== tenantId) throw new ActionRefusal("This booking's customer could not be found.");

  // The workspace's own indemnity once it has PUBLISHED one (the same switch as
  // the printed form), otherwise the standard wording.
  const layout = (await printableRecordLayout("indemnity")) ?? indemnityTemplateForScreen();
  const title = `Test-drive indemnity — ${booking.reference}`;
  layout.title = title;
  // Only the driver signs here. A layout that also asks someone else to sign
  // would wait on a signature this screen never collects, and the booking would
  // never be marked — so say so now instead.
  const signable = signedByCustomerOnly(layout, {
    staff: { name: user.name, email: user.email ?? null },
    customer: { name: contactName(contact), email: contact.email ?? null, phone: contact.phone ?? null },
  });
  if ("alsoAsks" in signable) {
    throw new ActionRefusal(
      `Your indemnity layout also asks for a signature from “${signable.alsoAsks}”. Signing on this device collects the driver's only — ` +
        "remove that signature block in Document Studio, or mark the indemnity signed by hand.",
    );
  }
  const context = buildTestDriveContext(
    {
      driverLicenceNumber: booking.driverLicenceNumber,
      contact,
      vehicle: booking.demoVehicle
        ? { name: booking.demoVehicle.name, color: booking.demoVehicle.color, regNumber: booking.demoVehicle.regNumber }
        : null,
      productName: product?.name ?? null,
      lead,
    },
    new Date(),
    regional,
  );

  const outcome = await openSubjectRequest({
    subject: indemnityOf(bookingId),
    tenantId,
    // The booking row is the mutex for its indemnity: taken first here, and
    // first by completion (lockSubject), so the two cannot interleave.
    holdRecord: async (tx) => {
      await tx.$executeRaw`SELECT id FROM "TestDriveBooking" WHERE id = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const live = await tx.testDriveBooking.findFirst({ where: { id: bookingId, tenantId, deletedAt: null }, select: { status: true } });
      return Boolean(live && UPCOMING_TEST_DRIVE_STATUSES.includes(live.status));
    },
    doc: signable.doc,
    title,
    context,
    contactId: contact.id,
    createdById: user.id,
    pdf: await toPdf(signable.doc, context, tenantId),
  });
  if (outcome === "signed") throw new ActionRefusal("The indemnity for this test drive has already been signed.");
  if (outcome === "gone") throw new ActionRefusal("This test drive changed while the indemnity was being prepared — refresh and try again.");
  await recordIndemnityWithdrawn(outcome.replaced, await staffActor(user.name, tenantId), "Replaced by a new indemnity").catch(() => {});
  return outcome;
}
