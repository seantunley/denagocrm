import "server-only";
import { basePrisma } from "./db";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { readFile } from "./storage";
import { sendWhatsAppDocument } from "./whatsapp";
import { canAccessVehicle, hasAnyPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { WARRANTY_READ } from "./warrantyAccess";
import { CERTIFICATE_TAG } from "./warrantyCertificate";
import { linkedDocumentIds } from "./assistantWarrantyCertificateRules";

/**
 * "Send me the warranty certificate for …" on WhatsApp (Sean, 2026-11-21): the filed PDF goes to THE PERSON WHO ASKED,
 * on their own linked phone — never to a customer (sent with no `record`, so nothing lands on a customer's timeline),
 * exactly as a quote's PDF does (decided the same day). DAX's warranty lookup gives each certificate's link; the ones in
 * its answer are the ones sent, each re-checked here: this workspace, a certificate, the Warranty module on, and the
 * asker's warranty grant and access to that vehicle — now, not when the answer was written. In the CRM chat the same
 * link simply opens it.
 */
export async function sendCertificatesInAnswer(input: {
  tenantId: string;
  user: PermissionUser;
  waId: string;
  answer: string;
  /** The linked phone is still this person's, checked right before sending (assistantWhatsApp staffPhoneStillSafe). */
  phoneSafe: () => Promise<boolean>;
}): Promise<number> {
  const { tenantId, user, waId } = input;
  const ids = linkedDocumentIds(input.answer);
  if (ids.length === 0 || !(await isModuleEnabled("warranty")) || !(await hasAnyPermission(user, ...WARRANTY_READ))) return 0;
  let sent = 0;
  for (const id of ids) {
    try {
      const doc = await basePrisma.document.findFirst({
        where: { id, tenantId, tag: CERTIFICATE_TAG, deletedAt: null },
        select: { id: true, fileName: true, storedName: true, vehicleId: true },
      });
      if (!doc?.vehicleId || !(await canAccessVehicle(user, doc.vehicleId))) continue;
      const pdf = await readFile(doc.storedName, tenantId);
      if (!(await input.phoneSafe())) return sent;
      const result = await sendWhatsAppDocument(waId, { content: pdf, filename: doc.fileName, contentType: "application/pdf" }, "Warranty certificate — for you. This copy was not sent to the customer.");
      if (!result.ok) continue;
      sent++;
      await logAudit({
        action: "assistant.warranty_certificate_to_staff",
        summary: "Sent a warranty certificate to the linked WhatsApp of the person who asked for it (not to the customer)",
        user,
        entityType: "Document",
        entityId: doc.id,
      }).catch(() => {});
    } catch (error) {
      await logError("assistant-whatsapp", "warranty certificate send failed", error instanceof Error ? error.name : "unknown").catch(() => {});
    }
  }
  return sent;
}
