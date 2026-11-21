"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { getActiveTenantId } from "@/lib/auth";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { requireVehicleAccess } from "@/lib/permissions";
import { getRegionalSettings } from "@/lib/settings";
import { sendEmail } from "@/lib/email";
import { readFile } from "@/lib/storage";
import { tenantEmailContent } from "@/lib/signing/signingEmail";
import { describeBlockedReason, firstAllowedChannel } from "@/lib/communicationPolicy";
import { vehicleCover } from "@/lib/warrantyParts";
import { CERTIFICATE_TAG, partsLines } from "@/lib/warrantyCertificate";
import { CERTIFICATE_FACTS_SELECT, CERTIFICATE_NOT_CURRENT, certificateState } from "@/lib/warrantyCertificateState";

/**
 * Send the vehicle's filed warranty certificate to its owner — only when someone presses Send (Sean, 2026-11-21): by
 * email with the PDF attached, through the consent check (service messages), in the workspace's own editable template
 * (Settings → Email templates → Warranty certificate), and logged on the customer's timeline.
 */
export async function sendWarrantyCertificate(vehicleId: string) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "warranty.manage");
      if (!(await isModuleEnabled("warranty"))) refuse("Warranty is switched off for this workspace.");
      const tenantId = await getActiveTenantId();
      if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
      const vehicle = await prisma.vehicle.findFirst({
        where: { id: vehicleId, tenantId, deletedAt: null },
        select: {
          // Everything the certificate prints, and whether the warranty covers the owner now.
          ...CERTIFICATE_FACTS_SELECT,
          documents: { where: { tag: CERTIFICATE_TAG, deletedAt: null, replacedById: null }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, fileName: true, storedName: true, contactId: true, issuedFrom: true } },
        },
      });
      if (!vehicle) return refuse("This vehicle is in the trash or no longer exists.");
      const certificate = vehicle.documents[0];
      if (!certificate) return refuse("No certificate is filed for this vehicle yet — press Issue certificate first.");
      // Only a certificate made out to the owner now, covered now, from the details as they are now — the email states
      // the live cover.
      const state = certificateState(certificate, vehicle);
      if (state !== "current") return refuse(CERTIFICATE_NOT_CURRENT[state]);
      const c = { ...vehicle.contact, id: vehicle.contactId };
      const verdict = await firstAllowedChannel({ contactId: c.id, tenantId, purpose: "service", channels: ["email"] });
      if (!verdict.allowed || !verdict.destination) {
        await logAudit({ action: "communication.suppressed", summary: `Warranty certificate for ${vehicle.model} not sent — ${describeBlockedReason(verdict.reason)}`, contactId: c.id, user });
        return refuse(`Not sent: ${describeBlockedReason(verdict.reason)}.`);
      }
      const message = await tenantEmailContent("warranty_certificate", tenantId, {
        first_name: c.firstName,
        recipient_name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        model: vehicle.model,
        cover_lines: partsLines(vehicleCover(vehicle, new Date()), await getRegionalSettings()),
      });
      const pdf = await readFile(certificate.storedName, tenantId);
      const sent = await sendEmail({
        to: verdict.destination,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: [{ filename: certificate.fileName, content: pdf, contentType: "application/pdf" }],
      });
      if (!sent.ok) refuse("The email didn't send. Check the email settings, then try again.");
      await prisma.communication.create({
        data: { type: "email", direction: "outbound", subject: message.subject, body: message.text, contactId: c.id, userId: user.id, tenantId },
      });
      await logAudit({ action: "vehicle.warranty_certificate_sent", summary: `Emailed the warranty certificate for ${vehicle.model} to its owner`, contactId: c.id, user });
      revalidatePath(`/vehicles/${vehicleId}`);
      revalidatePath(`/contacts/${c.id}`);
      return { success: "Certificate sent by email" };
    }),
  );
}
