import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { deleteFile, saveFile } from "./storage";
import { getRegionalSettings } from "./settings";
import { isModuleEnabled } from "./modules/enabled";
import { printableRecordLayout } from "./docbuilder/leadWarrantyRecords";
import { standardTemplateFor } from "./doceditor/standardTemplates";
import { renderModelToPdf } from "./doceditor/generate";
import { vehicleCover } from "./warrantyParts";
import { CERTIFICATE_TAG, NOT_COVERED, buildWarrantyCertificateContext, certificateFileName, certificateNumber, ownerCovered } from "./warrantyCertificate";
import { refuse } from "./actionResult";

/**
 * Issue a vehicle's warranty certificate and FILE it: a PDF in the owner's documents and on the vehicle, from the
 * workspace's PUBLISHED certificate layout (Document Studio), else the standard one. Nothing is sent — sending is a
 * person's click. An earlier certificate for the vehicle stays on file, marked as replaced by this one.
 *
 * Null when there is nothing to certify (no warranty recorded, or the Warranty module off). `tenantId` names the
 * workspace on every read and write.
 */
export async function issueWarrantyCertificate(input: {
  tenantId: string;
  vehicleId: string;
  actor: { id: string; name: string };
  why: "delivery" | "reissue";
}): Promise<{ documentId: string; number: string } | null> {
  const { tenantId, vehicleId, actor } = input;
  if (!(await isModuleEnabled("warranty"))) return null;
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, tenantId, deletedAt: null },
    select: {
      id: true, model: true, vin: true, regNumber: true, color: true, contactId: true,
      warrantyParts: true, warrantyStartsAt: true, purchaseDate: true, warrantyMonths: true,
      contact: { select: { firstName: true, lastName: true, company: true, isCompany: true, phone: true, email: true, address: true, suburb: true, city: true } },
      ownerships: { where: { tenantId, ownedUntil: null }, select: { warranty: true }, take: 1 },
    },
  });
  if (!vehicle) return null;
  // A certificate certifies the owner NOW: never while their warranty transfer is pending or was declined.
  if (!ownerCovered(vehicle.ownerships)) refuse(NOT_COVERED);
  const issuedAt = new Date();
  const cover = vehicleCover(vehicle, issuedAt);
  const start = vehicle.warrantyStartsAt ?? vehicle.purchaseDate;
  if (cover.length === 0 || !start) return null;

  const layout = (await printableRecordLayout(CERTIFICATE_TAG)) ?? standardTemplateFor("warranty-certificate");
  // Its own number on every issue (review of #1173): printed on it, in its file name, in the audit line.
  const number = certificateNumber(vehicle.id, issuedAt, randomUUID());
  const ctx = buildWarrantyCertificateContext(vehicle, cover, start, issuedAt, number, await getRegionalSettings());
  const pdf = await renderModelToPdf(layout, ctx, tenantId);
  const fileName = certificateFileName(vehicle, number);
  const storedName = await saveFile(pdf, fileName, "application/pdf", tenantId);

  try {
    const documentId = await prisma.$transaction(async (tx) => {
      // Re-checked at filing under the vehicle's lock, which a transfer also takes: the same owner, still covered.
      const held = await tx.$queryRaw<{ contactId: string }[]>`SELECT "contactId" FROM "Vehicle" WHERE "id" = ${vehicle.id} AND "tenantId" = ${tenantId} AND "deletedAt" IS NULL FOR UPDATE`;
      const open = await tx.vehicleOwnership.findMany({ where: { tenantId, vehicleId: vehicle.id, ownedUntil: null }, select: { warranty: true }, take: 1 });
      if (held[0]?.contactId !== vehicle.contactId || !ownerCovered(open)) {
        refuse("The vehicle's owner or warranty changed while the certificate was being made. Refresh and try again.");
      }
      const doc = await tx.document.create({
        data: {
          tenantId, contactId: vehicle.contactId, vehicleId: vehicle.id, fileName, storedName,
          mimeType: "application/pdf", sizeBytes: pdf.length, tag: CERTIFICATE_TAG, uploadedById: actor.id,
        },
        select: { id: true },
      });
      // The earlier certificate stays on file, marked as replaced (the documents list shows the newest).
      await tx.document.updateMany({
        where: { tenantId, vehicleId: vehicle.id, tag: CERTIFICATE_TAG, deletedAt: null, replacedById: null, NOT: { id: doc.id } },
        data: { replacedById: doc.id },
      });
      return doc.id;
    });
    await logAudit({
      action: "vehicle.warranty_certificate",
      summary: `${input.why === "delivery" ? "Issued" : "Reissued"} the warranty certificate ${number} for ${vehicle.model} — filed on the customer's documents, not sent`,
      contactId: vehicle.contactId,
      user: actor,
    });
    return { documentId, number };
  } catch (error) {
    // No row names the file: remove it rather than leave an orphan blob.
    await deleteFile(storedName).catch(() => {});
    throw error;
  }
}

/**
 * At delivery: a certificate for each vehicle that has a warranty, filed after the delivery committed. Never a reason to
 * report the delivery as failed — a failure is logged and the certificate can be issued from the vehicle page.
 */
export async function issueCertificatesAtDelivery(tenantId: string, vehicleIds: readonly string[], actor: { id: string; name: string }): Promise<void> {
  for (const vehicleId of vehicleIds) {
    try {
      await issueWarrantyCertificate({ tenantId, vehicleId, actor, why: "delivery" });
    } catch (error) {
      await logError("warranty-certificate", error, "The warranty certificate could not be issued at delivery; issue it from the vehicle page.", { tenantId });
    }
  }
}
