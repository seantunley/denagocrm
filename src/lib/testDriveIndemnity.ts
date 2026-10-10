import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { ActionRefusal } from "@/lib/actionFailure";
import { contactName } from "@/lib/format";
import { getRegionalSettings } from "@/lib/settings";
import { saveFile, deleteFile } from "@/lib/storage";
import { printableRecordLayout } from "@/lib/docbuilder/leadWarrantyRecords";
import { buildTestDriveContext } from "@/lib/docbuilder/leadWarrantyContext";
import type { MergeContext } from "@/lib/docbuilder/merge";
import type { DocumentModel } from "@/lib/doceditor/model";
import { indemnityTemplateForScreen } from "@/lib/doceditor/standardTemplates";
import { ensureSignable } from "@/lib/signing/autoEnvelope";
import { recipientLabel, resolvePartyRecipients } from "@/lib/signing/templateRecipients";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { createSignatureRequestFromDoc } from "@/lib/signing/service";
import { logSignEvent, staffActor } from "@/lib/signing/events";
import { CLOSED_REQUEST_STATUSES } from "@/lib/signing/status";
import { TEST_DRIVE_INDEMNITY } from "@/lib/signing/subject";
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
 * One live indemnity per booking. Starting one replaces any that was opened and
 * not signed, so the document always carries today's date and the customer's
 * details as they are now — they are frozen into the request when it is made.
 */

/** Where a booking's indemnity stands, as far as signing on a screen goes. */
export type IndemnityState =
  | { kind: "none" }
  /** Opened and waiting for the driver. */
  | { kind: "open"; requestId: string; recipientId: string; startedAt: Date }
  /** The driver has signed; the document is being sealed and filed. */
  | { kind: "finishing"; requestId: string; signedByName: string }
  | { kind: "signed"; requestId: string; signedByName: string; signedAt: Date };

const OPEN = { notIn: [...CLOSED_REQUEST_STATUSES] };

export async function indemnityState(bookingId: string): Promise<IndemnityState> {
  const requests = await prisma.signatureRequest.findMany({
    where: {
      subjectType: TEST_DRIVE_INDEMNITY,
      subjectId: bookingId,
      deletedAt: null,
      OR: [{ status: "completed" }, { status: OPEN }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      completedAt: true,
      recipients: {
        where: { role: { not: "viewer" } },
        orderBy: { order: "asc" },
        select: { id: true, name: true, signedName: true, signedAt: true, status: true },
      },
    },
  });
  const signedBy = (request: (typeof requests)[number]) => {
    const who = request.recipients.find((recipient) => recipient.status === "signed");
    return { name: who?.signedName || who?.name || "the driver", at: who?.signedAt ?? null };
  };

  const completed = requests.find((request) => request.status === "completed");
  if (completed) {
    const who = signedBy(completed);
    return { kind: "signed", requestId: completed.id, signedByName: who.name, signedAt: who.at ?? completed.completedAt ?? completed.createdAt };
  }
  const open = requests[0];
  if (!open) return { kind: "none" };
  const waiting = open.recipients.find((recipient) => recipient.status !== "signed" && recipient.status !== "declined");
  if (waiting) return { kind: "open", requestId: open.id, recipientId: waiting.id, startedAt: open.createdAt };
  // Everyone has signed and it is not completed yet: sealing takes a few
  // seconds, and is retried in the background if it fails.
  return open.recipients.some((recipient) => recipient.status === "signed")
    ? { kind: "finishing", requestId: open.id, signedByName: signedBy(open).name }
    : { kind: "none" };
}

type RawTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Hold every request for this booking's indemnity, so a signature being
 * submitted right now has either landed or not by the next statement.
 *
 * The signing route locks the request row while it records a signature. A
 * statement that started before that commit would still see "nobody has signed"
 * for the signer's row, and withdraw a document the driver had just signed. So:
 * take the rows first, and only then ask.
 */
async function holdIndemnityRequests(tx: RawTx, booking: { id: string; tenantId: string }): Promise<void> {
  await tx.$queryRaw`
    SELECT r."id" FROM "SignatureRequest" r
     WHERE r."subjectType" = ${TEST_DRIVE_INDEMNITY} AND r."subjectId" = ${booking.id} AND r."tenantId" = ${booking.tenantId}
       FOR UPDATE
  `;
}

/**
 * Withdraw a booking's indemnity that was opened and never signed — when a new
 * one replaces it, or the test drive is cancelled. Run inside the caller's
 * transaction, AFTER it holds the booking row (the lock order completion takes).
 *
 * One that has a signature on it is left alone: it is on its way to being
 * sealed, and a cancelled booking does not un-sign what the driver signed.
 *
 * Raw SQL so the base client's transaction and the workspace-scoped one both
 * fit. Returns the ids, for {@link recordIndemnityWithdrawn} once committed.
 */
export async function withdrawOpenIndemnity(tx: RawTx, booking: { id: string; tenantId: string | null }): Promise<string[]> {
  if (!booking.tenantId) return [];
  await holdIndemnityRequests(tx, { id: booking.id, tenantId: booking.tenantId });
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "SignatureRequest" r
       SET "status" = 'voided', "updatedAt" = NOW()
     WHERE r."subjectType" = ${TEST_DRIVE_INDEMNITY}
       AND r."subjectId" = ${booking.id}
       AND r."tenantId" = ${booking.tenantId}
       AND r."status" NOT IN (${Prisma.join([...CLOSED_REQUEST_STATUSES])})
       AND NOT EXISTS (
         SELECT 1 FROM "SignatureRecipient" s WHERE s."requestId" = r."id" AND s."status" = 'signed'
       )
    RETURNING r."id"
  `;
  return rows.map((row) => row.id);
}

/** The evidence entry for each request {@link withdrawOpenIndemnity} closed. */
export async function recordIndemnityWithdrawn(requestIds: string[], actor: string, reason: string): Promise<void> {
  for (const requestId of requestIds) {
    await logSignEvent(requestId, { type: "voided", actor, metadata: { via: "test_drive", reason } });
  }
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
  toPdf: (doc: DocumentModel, context: MergeContext) => Promise<Buffer> = (doc, context) => renderEnvelopePdf(doc, null, null, context),
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
  const driver = { name: contactName(contact), email: contact.email ?? null, phone: contact.phone ?? null };
  resolvePartyRecipients(layout, { denago: { name: user.name, email: user.email ?? null }, customer: driver });
  // Only the driver signs here. A layout that also asks someone else to sign
  // would wait on a signature this screen never collects, and the booking would
  // never be marked — so say so now instead.
  const someoneElse = layout.recipients.find((recipient) => recipient.role !== "viewer" && recipient.party !== "customer");
  if (someoneElse) {
    throw new ActionRefusal(
      `Your indemnity layout also asks for a signature from “${recipientLabel(someoneElse)}”. Signing on this device collects the driver's only — ` +
        "remove that signature block in Document Studio, or mark the indemnity signed by hand.",
    );
  }
  const doc = ensureSignable(layout, driver);
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

  // Rendered and stored BEFORE the lock, like a quote's: a PDF render must not
  // hold a row lock, and the file has to exist before a request can name it.
  const pdf = await toPdf(doc, context);
  const storedName = await saveFile(pdf, `${title}.pdf`, "application/pdf", tenantId);

  let outcome: { requestId: string; replaced: string[] } | "gone" | "signed" = "gone";
  let committed = false;
  try {
    outcome = await basePrisma.$transaction(async (tx) => {
      // The booking row is the mutex for its indemnity: taken first here, and
      // first by completion (lockSubject), so the two cannot interleave.
      await tx.$executeRaw`SELECT id FROM "TestDriveBooking" WHERE id = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const live = await tx.testDriveBooking.findFirst({
        where: { id: bookingId, tenantId, deletedAt: null },
        select: { status: true },
      });
      if (!live || !UPCOMING_TEST_DRIVE_STATUSES.includes(live.status)) return "gone" as const;
      await holdIndemnityRequests(tx, { id: bookingId, tenantId });
      // Signed — completed, or signed and still being sealed. Never replaced.
      const signed = await tx.signatureRequest.findFirst({
        where: {
          subjectType: TEST_DRIVE_INDEMNITY,
          subjectId: bookingId,
          tenantId,
          OR: [{ status: "completed" }, { status: OPEN, recipients: { some: { status: "signed" } } }],
        },
        select: { id: true },
      });
      if (signed) return "signed" as const;

      const replaced = await withdrawOpenIndemnity(tx, { id: bookingId, tenantId });
      const created = await createSignatureRequestFromDoc({
        doc,
        title,
        unsignedPdfRef: storedName,
        // No document or record of its own beside the customer: who may open it
        // in the Signatures list follows who may open the customer.
        source: { contactId: contact.id, subject: { type: TEST_DRIVE_INDEMNITY, id: bookingId } },
        context,
        createdById: user.id,
        client: tx,
      });
      return { requestId: created.id, replaced };
    });
    committed = typeof outcome === "object";
  } finally {
    // A thrown commit is not a rollback (recordSigning.ts spells this out): the
    // file goes only when a read PROVES no request names it.
    if (!committed) {
      const named = await basePrisma.signatureRequest
        .findFirst({ where: { unsignedPdfRef: storedName }, select: { id: true } })
        .then(Boolean, () => true);
      if (!named) await deleteFile(storedName).catch(() => {});
    }
  }
  if (outcome === "signed") throw new ActionRefusal("The indemnity for this test drive has already been signed.");
  if (outcome === "gone") throw new ActionRefusal("This test drive changed while the indemnity was being prepared — refresh and try again.");
  await recordIndemnityWithdrawn(outcome.replaced, await staffActor(user.name, tenantId), "Replaced by a new indemnity").catch(() => {});
  return outcome;
}
